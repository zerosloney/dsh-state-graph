import { test } from "node:test";
import assert from "node:assert/strict";
import GraphEngineService, { StateGraph, END } from "../lib/index.js";

/** 最小 ctx 桩：StateGraph 运行时只调用 ctx.emit / ctx.on。 */
function stubCtx() {
  const events = [];
  const listeners = [];
  return {
    events,
    emit(name, payload) {
      events.push({ name, payload });
      for (const { name: n, listener } of listeners) {
        if (n === name) listener(payload);
      }
    },
    on(name, listener) {
      listeners.push({ name, listener });
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
  // 取消终态契约：node-error（过程诊断）+ graph/error（终态），各恰好一次
  assert.equal(
    ctx.events.filter((event) => event.name === "graph/node-error").length,
    1,
  );
  const errorEvents = ctx.events.filter((event) => event.name === "graph/error");
  assert.equal(errorEvents.length, 1);
  assert.equal(errorEvents[0].payload.error, reason);
  assert.equal(errorEvents[0].payload.lastNode, "a");
});

test("路由段取消：补发 graph/error 终态后拒绝", async () => {
  const ctx = stubCtx();
  const controller = new AbortController();
  let markRouting;
  const routing = new Promise((resolve) => {
    markRouting = resolve;
  });
  const graph = new StateGraph(ctx, 10)
    .addNode("a", () => ({}))
    .addConditionalEdge("a", async (_state, _ctx, signal) => {
      markRouting();
      await new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return "a";
    })
    .setEntryPoint("a");

  const running = graph.run({}, { signal: controller.signal });
  await routing;
  const reason = new Error("cancelled while routing");
  controller.abort(reason);

  await assert.rejects(running, (error) => error === reason);
  const errorEvents = ctx.events.filter((event) => event.name === "graph/error");
  assert.equal(errorEvents.length, 1);
  assert.equal(errorEvents[0].payload.error, reason);
  assert.equal(errorEvents[0].payload.lastNode, "a");
  assert.ok(!ctx.events.some((event) => event.name === "graph/end"));
});

test("graph/start 监听器内同步取消：仍收到 graph/error 终态", async () => {
  const ctx = stubCtx();
  const controller = new AbortController();
  const reason = new Error("cancelled at start");
  ctx.on("graph/start", () => controller.abort(reason));
  let called = false;
  const graph = new StateGraph(ctx, 10)
    .addNode("a", () => {
      called = true;
      return {};
    })
    .setEntryPoint("a");

  await assert.rejects(
    graph.run({}, { signal: controller.signal }),
    (error) => error === reason,
  );
  assert.equal(called, false);
  // 此前该时点取消会导致 graph/start 之后无任何终态事件
  assert.deepEqual(ctx.events.map((event) => event.name), [
    "graph/start",
    "graph/error",
  ]);
  assert.equal(ctx.events[1].payload.error, reason);
  assert.equal(ctx.events[1].payload.lastNode, "a");
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

test("缺入口/重名节点/重复边在 run 前拒绝", async () => {
  const ctx = stubCtx();
  await assert.rejects(new StateGraph(ctx, 10).addNode("a", () => ({})).run({}), /entryPoint/);
  assert.throws(
    () => new StateGraph(ctx, 10).addNode("a", () => ({})).addNode("a", () => ({})),
    /already registered/,
  );
  assert.throws(
    () => new StateGraph(ctx, 10).addEdge("a", "b").addEdge("a", "c"),
    /already registered/,
  );
  assert.throws(
    () =>
      new StateGraph(ctx, 10)
        .addConditionalEdge("a", () => "b")
        .addConditionalEdge("a", () => "c"),
    /already registered/,
  );
});

test("路由返回 undefined/BigInt：抛非法目标错误且错误消息可读", async () => {
  const ctx = stubCtx();
  const ghostRoute = new StateGraph(ctx, 10)
    .addNode("a", () => ({}))
    .addConditionalEdge("a", () => undefined)
    .setEntryPoint("a");
  await assert.rejects(ghostRoute.run({}), /非法目标：undefined/);

  const bigintRoute = new StateGraph(ctx, 10)
    .addNode("a", () => ({}))
    .addConditionalEdge("a", () => 1n)
    .setEntryPoint("a");
  // BigInt 不可 JSON 序列化：错误消息构造降级为 String()，不再自抛 TypeError
  await assert.rejects(bigintRoute.run({}), /非法目标：1/);
});

test("logTrajectory=true：订阅 node-start/end 输出轨迹日志", () => {
  const logs = [];
  const listeners = {};
  const ctx = {
    emit() {},
    on(name, listener) {
      (listeners[name] ??= []).push(listener);
    },
    logger(scope) {
      return {
        debug: (message) => logs.push(`[${scope}] debug ${message}`),
        info: (message) => logs.push(`[${scope}] info ${message}`),
      };
    },
    reflect: { provide() {} },
  };
  new GraphEngineService(ctx, { defaultMaxIterations: 25, logTrajectory: true });

  assert.deepEqual(listeners["graph/node-start"].length, 1);
  assert.deepEqual(listeners["graph/end"].length, 1);
  listeners["graph/node-start"][0]({ node: "a", iteration: 2 });
  listeners["graph/end"][0]({ trajectory: ["a", "b"], iterations: 2 });
  assert.deepEqual(logs, [
    "[graph] debug [StateGraph] [#2] Running Node: a",
    "[graph] info [StateGraph] Completed in 2 steps. Route: a -> b",
  ]);
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

test("graph/node-end 包含 durationMs 和 patch 增量", async () => {
  const ctx = stubCtx();
  const graph = new StateGraph(ctx, 10)
    .addNode("calc", async () => {
      await sleep(10);
      return { score: 100 };
    })
    .setEntryPoint("calc");
  const result = await graph.run({});
  assert.equal(result.finalState.score, 100);
  const endEvent = ctx.events.find((e) => e.name === "graph/node-end");
  assert.ok(endEvent);
  assert.equal(endEvent.payload.node, "calc");
  assert.deepEqual(endEvent.payload.patch, { score: 100 });
  assert.ok(typeof endEvent.payload.durationMs === "number" && endEvent.payload.durationMs >= 5);
});

test("addSubgraph: 嵌套子图声明式组合与状态映射", async () => {
  const ctx = stubCtx();
  const subGraph = new StateGraph(ctx, 5)
    .addNode("sub_step", (s) => ({ subCount: (s.subCount ?? 0) + 10 }))
    .setEntryPoint("sub_step");

  const mainGraph = new StateGraph(ctx, 10)
    .addNode("init", () => ({ count: 1 }))
    .addSubgraph("nested", subGraph, {
      inputMapper: (mainState) => ({ subCount: mainState.count }),
      outputMapper: (subState, mainState) => ({
        count: mainState.count,
        subResult: subState.subCount,
      }),
    })
    .addEdge("init", "nested")
    .setEntryPoint("init");

  const result = await mainGraph.run({});
  assert.equal(result.finalState.count, 1);
  assert.equal(result.finalState.subResult, 11);
  assert.deepEqual(result.trajectory, ["init", "nested"]);
});

test("Fan-out / Fan-in: 条件路由返回并行目标数组并汇聚", async () => {
  const ctx = stubCtx();
  let executedA = false;
  let executedB = false;

  const graph = new StateGraph(ctx, 10)
    .addNode("split", () => ({ init: true }))
    .addNode("branch_a", async (s) => {
      await sleep(5);
      executedA = true;
      return { fromA: true };
    })
    .addNode("branch_b", async (s) => {
      await sleep(5);
      executedB = true;
      return { fromB: true };
    })
    .addNode("join", (s) => ({
      joined: true,
      allOk: s.fromA && s.fromB,
    }))
    .addConditionalEdge("split", () => ["branch_a", "branch_b"])
    .addEdge("branch_b", "join")
    .setEntryPoint("split");

  const result = await graph.run({});
  assert.equal(executedA, true);
  assert.equal(executedB, true);
  assert.equal(result.finalState.fromA, true);
  assert.equal(result.finalState.fromB, true);
  assert.equal(result.finalState.joined, true);
  assert.equal(result.finalState.allOk, true);
  assert.deepEqual(result.trajectory, ["split", "branch_a", "branch_b", "join"]);
});

