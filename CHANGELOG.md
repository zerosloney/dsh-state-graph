# Changelog

## Unreleased (0.1.0)

首次发布前的完整加固轮。

### ⚠️ Breaking / 行为变化

- peer 依赖对齐 harness `0.1.0-rc.5`（`^0.1.0-rc.5` 同时兼容 rc.6+）。

### Added

- 测试套件（node:test，7 用例，stub ctx 驱动真实引擎）：线性图/条件边/迭代熔断/异常路径/入口校验。
- `npm run smoke` 修复为可执行（原先指向不存在的脚本）。

### Fixed

- **非法路由目标 double-emit**：校验分支与 catch 各发一次 `graph/error`，改为校验只抛错、由 catch 统一补发。
- `graphId` 从 3 字节（16M 碰撞域）扩到 8 字节。
- README 示例代码修复（未定义变量）、过度宣称措辞收敛（子图/并发汇聚未内置）。
