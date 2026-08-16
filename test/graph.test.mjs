import { test } from "node:test";
import assert from "node:assert/strict";
import GraphEngineService, { StateGraph, END } from "../lib/index.js";

/** 最小 ctx 桩：StateGraph 运行时只调用 ctx.emit。 */
function stubCtx() {
  const events = [];
  return {
    events,
    emit(name, payload) {
      events.push({ name, payload });
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("线性图：状态增量合并、轨迹与迭代计数正确", async () => {
  const ctx = stubCtx();
  const graph = new StateGraph(ctx, 10)
    .addNode("a", (s) => ({ step: (s.step ?? 0) + 1 }))
    .addNode("b", (s) => ({ done: true, step: s.step }))
    .addEdge("a", "b")
    .setEntryPoint("a");
  const result = await graph.run({});
  assert.equal(result.finalState.step, 1);
  assert.equal(result.finalState.done, true);
  assert.deepEqual(result.trajectory, ["a", "b"]);
  assert.equal(result.iterations, 2);
  const names = ctx.events.map((e) => e.name);
  assert.deepEqual(names, [
    "graph/start",
    "graph/node-start",
    "graph/node-end",
    "graph/node-start",
    "graph/node-end",
    "graph/end",
  ]);
  assert.equal(ctx.events[0].payload.graphId, result.graphId);
});

test("同一图重复运行：每次运行生成独立 graphId", async () => {
  const ctx = stubCtx();
  const graph = new StateGraph(ctx, 10)
    .addNode("a", () => ({ done: true }))
    .setEntryPoint("a");

  const first = await graph.run({});
  const second = await graph.run({});

  assert.notEqual(first.graphId, second.graphId);
  assert.deepEqual(
    ctx.events.map((event) => event.payload.graphId),
    [
      first.graphId,
      first.graphId,
      first.graphId,
      first.graphId,
      second.graphId,
      second.graphId,
      second.graphId,
      second.graphId,
    ],
  );
});

test("同一图并发运行：每次运行的事件和结果使用独立 graphId", async () => {
  const ctx = stubCtx();
  const graph = new StateGraph(ctx, 10)
    .addNode("a", async (state) => {
      await sleep(1);
      return { run: state.run };
    })
    .setEntryPoint("a");

  const [first, second] = await Promise.all([
    graph.run({ run: "first" }),
    graph.run({ run: "second" }),
  ]);

  assert.notEqual(first.graphId, second.graphId);
  for (const result of [first, second]) {
    const events = ctx.events.filter((event) => event.payload.graphId === result.graphId);
    assert.equal(events.length, 4);
    assert.ok(events.every((event) => event.payload.graphId === result.graphId));
  }
});

test("条件边优先于静态边，可路由到 END", async () => {
  const ctx = stubCtx();
  const controller = new AbortController();
  let routeContext;
  let routeSignal;
  const graph = new StateGraph(ctx, 10)
    .addNode("a", () => ({ n: 1 }))
    .addNode("b", () => ({ n: 2 }))
    .addEdge("a", "b")
    .addConditionalEdge("a", (s, routeCtx, signal) => {
      routeContext = routeCtx;
      routeSignal = signal;
      return s.n === 1 ? "__END__" : "b";
    })
    .setEntryPoint("a");
  const result = await graph.run({ n: 0 }, { signal: controller.signal });
  assert.deepEqual(result.trajectory, ["a"]);
  assert.equal(result.finalState.n, 1);
  assert.strictEqual(routeContext, ctx);
  assert.strictEqual(routeSignal, controller.signal);
});

test("预取消：不启动图，也不发 graph/end", async () => {
  const ctx = stubCtx();
  const controller = new AbortController();
  controller.abort(new Error("pre-cancelled"));
  let called = false;
  const graph = new StateGraph(ctx, 10)
    .addNode("a", () => {
      called = true;
      return {};
    })
    .setEntryPoint("a");

  await assert.rejects(
    graph.run({}, { signal: controller.signal }),
    (error) => error === controller.signal.reason,
  );
  assert.equal(called, false);
  assert.equal(ctx.events.length, 0);
});

test("节点收到同一个 signal", async () => {
  const ctx = stubCtx();
  const controller = new AbortController();
  let nodeSignal;
  const graph = new StateGraph(ctx, 10)
    .addNode("a", (_state, _ctx, signal) => {
      nodeSignal = signal;
      return {};
    })
    .setEntryPoint("a");

  await graph.run({}, { signal: controller.signal });
  assert.strictEqual(nodeSignal, controller.signal);
});

test("运行中取消：合作型节点拒绝且不发 graph/end", async () => {
  const ctx = stubCtx();
  const controller = new AbortController();
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const graph = new StateGraph(ctx, 10)
    .addNode("a", async (_state, _ctx, signal) => {
      markStarted();
      await new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return {};
    })
    .setEntryPoint("a");

  const running = graph.run({}, { signal: controller.signal });
  await started;
  const reason = new Error("cancelled while running");
  controller.abort(reason);

  await assert.rejects(running, (error) => error === reason);
  assert.ok(!ctx.events.some((event) => event.name === "graph/end"));
});

test("迭代熔断：自环超限抛错并补发 graph/error", async () => {
  const ctx = stubCtx();
  const graph = new StateGraph(ctx, 3)
    .addNode("loop", (s) => ({ i: (s.i ?? 0) + 1 }))
    .addConditionalEdge("loop", (s) => (s.i < 100 ? "loop" : END))
    .setEntryPoint("loop");
  await assert.rejects(graph.run({}), /Max iteration limit/);
  const errorEvents = ctx.events.filter((e) => e.name === "graph/error");
  assert.equal(errorEvents.length, 1);
  assert.equal(errorEvents[0].payload.lastNode, "loop");
  // 熔断语义：第 N 次仍执行完（iterations === maxIterations）
  const nodeStarts = ctx.events.filter((e) => e.name === "graph/node-start");
  assert.equal(nodeStarts.length, 3);
  // 异常终止不发 graph/end
  assert.ok(!ctx.events.some((e) => e.name === "graph/end"));
});

test("路由到未注册节点：抛错 + graph/error", async () => {
  const ctx = stubCtx();
  const graph = new StateGraph(ctx, 10)
    .addNode("a", () => ({}))
    .addConditionalEdge("a", () => "ghost")
    .setEntryPoint("a");
  await assert.rejects(graph.run({}), /非法目标|missing/i);
  assert.equal(ctx.events.filter((e) => e.name === "graph/error").length, 1);
});

test("静态边悬空目标：抛错 + graph/error", async () => {
  const ctx = stubCtx();
  const graph = new StateGraph(ctx, 10)
    .addNode("a", () => ({}))
    .addEdge("a", "ghost")
    .setEntryPoint("a");
  await assert.rejects(graph.run({}), /missing/i);
  assert.equal(ctx.events.filter((e) => e.name === "graph/error").length, 1);
});

test("节点抛错：graph/node-error 后上抛，不发 end", async () => {
  const ctx = stubCtx();
  const graph = new StateGraph(ctx, 10)
    .addNode("a", async () => {
      await sleep(1);
      throw new Error("handler boom");
    })
    .setEntryPoint("a");
  await assert.rejects(graph.run({}), /handler boom/);
  assert.equal(ctx.events.filter((e) => e.name === "graph/node-error").length, 1);
  assert.ok(!ctx.events.some((e) => e.name === "graph/end"));
});

test("缺入口/重名节点在 run 前拒绝", async () => {
  const ctx = stubCtx();
  await assert.rejects(new StateGraph(ctx, 10).addNode("a", () => ({})).run({}), /entryPoint/);
  assert.throws(
    () => new StateGraph(ctx, 10).addNode("a", () => ({})).addNode("a", () => ({})),
    /already registered/,
  );
});

test("maxIterations：构造与配置边界拒绝非正数、非整数和非有限值", () => {
  const ctx = stubCtx();
  for (const value of [0, -1, 1.5, NaN, Infinity, -Infinity]) {
    assert.throws(
      () => new StateGraph(ctx, value),
      /maxIterations.*finite positive integer/i,
      `constructor should reject ${String(value)}`,
    );
    assert.throws(
      () => GraphEngineService.Config({ defaultMaxIterations: value, logTrajectory: false }),
      /number|multiple|>=/i,
      `config should reject ${String(value)}`,
    );
  }
});
