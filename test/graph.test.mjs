import { test } from "node:test";
import assert from "node:assert/strict";
import { StateGraph, END } from "../lib/index.js";

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

test("条件边优先于静态边，可路由到 END", async () => {
  const ctx = stubCtx();
  const graph = new StateGraph(ctx, 10)
    .addNode("a", () => ({ n: 1 }))
    .addNode("b", () => ({ n: 2 }))
    .addEdge("a", "b")
    .addConditionalEdge("a", (s) => (s.n === 1 ? "__END__" : "b"))
    .setEntryPoint("a");
  const result = await graph.run({ n: 0 });
  assert.deepEqual(result.trajectory, ["a"]);
  assert.equal(result.finalState.n, 1);
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
