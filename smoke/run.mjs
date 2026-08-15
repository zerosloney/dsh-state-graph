// 冒烟测试：设计文档 §5 的「生成 → 静态审查 → 单测 → 自适应循环」图，
// 以及迭代熔断、入口校验、事件流三处边界。
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import GraphEngineService from "../lib/index.js";

const ctx = new Context();
await ctx.plugin(GraphEngineService, { defaultMaxIterations: 25, logTrajectory: false });

// ---- §5 工作流：lint/test 首次失败后回环到 generate_code ----
const graph = ctx.graph.create();
const events = { start: 0, nodeStart: [], nodeEnd: 0, end: 0 };
ctx.on("graph/start", () => events.start++);
ctx.on("graph/node-start", (e) => events.nodeStart.push(e.node));
ctx.on("graph/node-end", () => events.nodeEnd++);
ctx.on("graph/end", () => events.end++);

graph
  .addNode("generate_code", (s) => ({ rev: s.rev + 1, code: `fn_${s.rev + 1}` }))
  .addNode("static_analyze", (s) => ({ lintOk: s.rev >= 2 }))
  .addNode("run_unit_test", (s) => ({ testOk: s.rev >= 3 }))
  .addEdge("generate_code", "static_analyze")
  .addEdge("static_analyze", "run_unit_test")
  .addConditionalEdge("static_analyze", (s) =>
    s.lintOk ? "run_unit_test" : "generate_code",
  )
  .addConditionalEdge("run_unit_test", (s) =>
    s.testOk ? "__END__" : "generate_code",
  )
  .setEntryPoint("generate_code");

const result = await graph.run({ rev: 1 });
assert.equal(result.finalState.code, "fn_3");
assert.equal(result.finalState.lintOk, true);
assert.equal(result.finalState.testOk, true);
assert.deepEqual(result.trajectory, [
  "generate_code",
  "static_analyze",
  "run_unit_test",
  "generate_code",
  "static_analyze",
  "run_unit_test",
]);
assert.equal(result.iterations, 6);
assert.equal(events.start, 1);
assert.equal(events.end, 1);
assert.equal(events.nodeEnd, 6);
assert.deepEqual(events.nodeStart, result.trajectory);

// ---- 迭代熔断：无条件回环超出 maxIterations 抛错并发出 graph/error ----
let guardMessage = null;
ctx.on("graph/error", (e) => {
  guardMessage = e.error.message;
});
await assert.rejects(
  ctx.graph
    .create(3)
    .addNode("loop", (s) => ({ n: s.n + 1 }))
    .addEdge("loop", "loop")
    .setEntryPoint("loop")
    .run({ n: 0 }),
  /Max iteration limit \(3\) exceeded/,
);
assert.match(guardMessage, /Max iteration limit \(3\) exceeded/);

// ---- 入口校验：未设置或未注册的 entryPoint 抛错 ----
await assert.rejects(
  ctx.graph.create().addNode("a", () => ({})).run({}),
  /valid registered entryPoint/,
);

console.log(
  "smoke ok:",
  JSON.stringify({ trajectory: result.trajectory, iterations: result.iterations }),
);
process.exit(0);
