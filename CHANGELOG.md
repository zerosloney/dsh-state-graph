# Changelog

## Unreleased (0.1.0)

首次发布前的完整加固轮。

### ⚠️ Breaking / 行为变化

- peer 依赖为 `@deepseek-ai/cordis` `^4.0.1`。
- **取消终态事件统一**：`graph/start` 之后的取消在任意时点都补发一次 `graph/error` 后上抛（节点执行中的取消先发 `graph/node-error` 过程诊断、再发 `graph/error` 终态）。此前取消落点不同则终态事件不一致——节点段只有 `graph/node-error`、路由段 `graph/error`、个别时点甚至没有任何终态事件。`graph/start` 之前的预取消保持无事件。
- `addEdge` / `addConditionalEdge` 对同一 `from` 重复注册由静默覆盖改为抛错（与 `addNode` 一致）。

### Added

- 测试套件（node:test，stub ctx 驱动真实引擎）：线性图/条件边/迭代熔断/异常路径/取消终态/入口与重复注册校验/`logTrajectory` 日志分支。
- CI 增加 `npm run smoke` 步骤。

### Fixed

- **`npm run smoke` 从未执行冒烟脚本**：`node --test` 的默认文件发现不包含 `smoke/` 目录，改为显式 `node smoke/run.mjs`；同时移除会杀死测试进程的 `process.exit(0)`。
- **观察者异常误归类**：`graph/node-end` 的发射原先位于节点 try 块内，`graph/*` 监听器抛错（cordis `emit` 同步传播监听器异常）会被当作节点业务错误上报；已将补丁合并与事件发射移出 try 块，并明确"监听器不得抛错"契约。
- **非法路由目标 double-emit**：校验分支与 catch 各发一次 `graph/error`，改为校验只抛错、由 catch 统一补发。
- 路由非法目标的错误消息对 BigInt/循环引用等不可 JSON 序列化返回值不再自抛 `TypeError`。
- `run()` 内不可达的 `maxIterations` 重复断言移除（构造器已校验且之后不可变）。
- `graphId` 从 3 字节（16M 碰撞域）扩到 8 字节。
- README 修正：示例代码未定义变量、graphId 语义（实例标识 → 每次执行标识）、过期用例数。
- README 措辞收敛（子图/并发汇聚未内置）。
