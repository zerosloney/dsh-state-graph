# dsh-state-graph

把 **StateGraph 有向状态图编排引擎**移植为 **DeepSeek Harness (dsh) 插件**：用声明式的节点 / 静态边 / 条件边把 Harness 单向线性的 ReAct 调度提升为支持多分支条件路由、循环重试与迭代熔断的图编排运行时（子图嵌套可经节点内调用 `ctx.graph.create()` 组合实现；并行汇聚暂未内置）。

```text
addNode / addEdge / addConditionalEdge → 纯函数增量补丁 → 迭代熔断 → 轨迹事件流
```

## 这是什么

`dsh-state-graph` 是一个 **dsh bundle 包**：导出一个 cordis 插件（`state-graph`），提供 `ctx.graph` 服务。插件的核心是设计文档《状态图（StateGraph）编排引擎技术方案与架构设计》中的有向状态图运行时内核：

| 能力 | 落点 |
| --- | --- |
| 声明式拓扑构造（Fluent API：addNode / addEdge / addConditionalEdge） | `StateGraph` |
| 纯函数增量补丁：节点只返回 `Partial<State>`，引擎不可变合并 | `StateGraph.run` |
| 防死循环熔断（默认 25 次迭代，超限抛错） | `StateGraph` 内置 |
| 双向事件流观测（`graph/*` 事件，追加式轨迹） | `ctx.emit` 事件总线 |
| 隔离的状态图实例工厂 | `ctx.graph.create()` |

## 核心接口

| 接口 / 类型 | 签名 | 说明 |
| --- | --- | --- |
| `NodeHandler<T>` | `(state: T, ctx: Context, signal?: AbortSignal) => Promise<Partial<T>> \| Partial<T>` | 节点业务执行体，返回需合并的状态增量；第二参数仍为 `ctx`，第三参数接收本次运行的取消信号 |
| `ConditionHandler<T>` | `(state: T, ctx: Context, signal?: AbortSignal) => string \| Promise<string>` | 动态路由，返回下一个 NodeName 或 `"__END__"`；第二参数仍为 `ctx`，第三参数接收本次运行的取消信号 |
| `GraphExecutionResult<T>` | `{ graphId: string; finalState: T; trajectory: string[]; iterations: number }` | 每次执行的 graphId（区分重复/并发轨迹）、最终状态、全量跳转轨迹、迭代次数 |
| `ctx.graph.create<T>(maxIterations?)` | → `StateGraph<T>` | 创建隔离的图实例 |

一次运行可通过 `run(initialState, { signal })` 传入 `AbortSignal`；不传第二参数时保持原有调用方式。引擎会在节点执行、节点结果合并、条件路由以及跳转边界检查取消状态，并把同一个 signal 作为 `NodeHandler` / `ConditionHandler` 的第三参数传入。

### 事件（`ctx.on("graph/…")` 订阅）

| 事件 | 载荷 | 时机 |
| --- | --- | --- |
| `graph/start` | `{ graphId, initialState, entryPoint }` | 图开始执行 |
| `graph/node-start` | `{ graphId, node, state, iteration }` | 每个节点执行前 |
| `graph/node-end` | `{ graphId, node, state }` | 节点补丁合并后 |
| `graph/node-error` | `{ graphId, node, error }` | 节点抛错或被取消中断（随后上抛；取消还会补发 `graph/error`） |
| `graph/error` | `{ graphId, error, state, lastNode }` | 迭代熔断 / 目标节点缺失 / 路由抛错 / 取消（`graph/start` 之后） |
| `graph/end` | `{ graphId, finalState, trajectory, iterations }` | 仅正常终止（END 或无出边） |

`graphId` 标识每次执行（同一图实例的重复/并发运行各自独立生成），用于区分并发图之间可能重名的节点轨迹。`graph/end` 只在正常终止时发出；**所有异常终止统一发 `graph/error` 后上抛**——包括迭代熔断、条件路由返回未注册节点名/非字符串、路由函数抛错，以及 `graph/start` 之后的取消（节点执行中的取消先发 `graph/node-error` 过程诊断、再发 `graph/error` 终态；`graph/start` 之前的预取消无任何事件）。节点自身业务抛错仅发 `graph/node-error` 后上抛。`graph/*` 监听器同步执行且异常会传播进引擎（cordis `emit` 语义），订阅方不应在监听器中抛错。

`logTrajectory` 开启时，插件订阅 `node-start`（debug 级）与 `end`（info 级）把轨迹写入 `ctx.logger("graph")`。

## 安装

作为一个 bundle 包装进某个 profile：

```sh
# 发布后
dsh plugin --profile web add dsh-state-graph

# 本地开发（file: 链接）
# 在 $DSH_HOME/profiles/<name>/package.json 加依赖并安装
```

profile 的 `dsh.profile.bundles` 需要包含 `dsh-state-graph`（与 `@deepseek-ai/dsh-base` 一起）。插件无其他注入依赖，任何 profile 均可加载。

## 配置（`cordis.patch.yml` 的 `config`）

```yaml
- insert:
    - id: state-graph
      name: 'dsh-state-graph'
      config:
        defaultMaxIterations: 25   # 防死循环单次执行最大迭代上限
        logTrajectory: true        # 输出路由轨迹到日志总线
```

## 用法示例：代码生成与双向对齐检查图

```ts
import { Context } from "@deepseek-ai/cordis";

// 在其他插件 / 工具 / 命令中：
export function buildGraph(ctx: Context) {
  return ctx.graph
    .create() // 隔离实例，maxIterations 默认取插件配置
    .addNode("generate_code", async (s, ctx, signal) => {
      const code = await llmGenerate(ctx, s.task, signal); // 业务函数自行遵守 signal
      return { code, rev: s.rev + 1 };
    })
    .addNode("static_analyze", (s) => ({ lintOk: lint(s.code).ok }))
    .addNode("run_unit_test", async (s, ctx) => ({
      testOk: (await runTests(ctx, s.code)).passed,
    }))
    .addEdge("generate_code", "static_analyze")
    .addEdge("static_analyze", "run_unit_test")
    .addConditionalEdge("static_analyze", (s, _ctx, signal) => {
      signal?.throwIfAborted();
      return s.lintOk ? "run_unit_test" : "generate_code";
    })
    .addConditionalEdge("run_unit_test", (s) =>
      s.testOk ? "__END__" : "generate_code",
    )
    .setEntryPoint("generate_code");
}

// 使用：
const graph = buildGraph(ctx);
const controller = new AbortController();
const { finalState, trajectory, iterations } = await graph.run(
  { rev: 0, task },
  { signal: controller.signal },
);
ctx.logger("app").info(`route: ${trajectory.join(" -> ")} (${iterations} steps)`);
```

条件边优先于静态边；无出边或条件路由返回 `"__END__"` 即终止。`addEdge` / `addConditionalEdge` 对同一 `from` 重复注册会抛错（与 `addNode` 的重名检查一致）；静态边与条件边可挂在同一节点上，条件边优先生效。**条件路由返回未注册节点名、非字符串或 `undefined`（如忘写 return）时抛错并发 `graph/error`**（熔断语义同上，非静默终止）。

## 运维与性能考量

1. **状态合并策略**：默认浅拷贝 + 结构补丁合并（`{ ...state, ...patch }`）。大对象（文件内容、仓库快照）建议经引用路径或沙箱虚拟文件系统管理，避免全量复制造成 GC 压力。
2. **取消与异步超时控制**：`run(initialState, { signal })` 是合作式取消。引擎只在节点、路由和图遍历边界检查 signal，不会强杀忽略 signal 的普通 Promise；NodeHandler / ConditionHandler 也应把第三参数传给所调用的 LLM、工具或外部服务。取消的终态事件语义见上文事件表：`graph/start` 之后的取消一律补发 `graph/error`。引擎不内置单节点超时，单节点超时仍由调用方或 handler 自行组合 `AbortSignal` 与定时器。
3. **观测**：节点级耗时分析 = 同一节点相邻 `node-start` / `node-end` 事件时间差；执行流回放 = 按序消费 `graph/*` 事件。

## 开发

```sh
npm install
npm run build        # tsc → lib/
npm run typecheck
npm run smoke        # build + 冒烟测试（设计文档 §5 工作流 + 熔断/入口校验/事件流）
npm test             # build + node --test（StateGraph.run 全流程与事件契约，stub ctx 驱动）
```

## 许可

MIT。实现遵循《DeepSeek Harness (dsh) 状态图（StateGraph）编排引擎技术方案与架构设计》。
