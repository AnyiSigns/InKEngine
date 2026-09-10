# state_machine（core/state_machine）

状态机通用底座：声明式规则（合法状态集 + 终态 + 可选转换白名单）+ append-only 转换日志（当前状态由日志推导）。

## 文件
- `state_machine.ts` — `StateMachine`（纯判定、无状态、可作模块级单例）、`StateTransition`（不可变转换记录，构造即冻结，可序列化落库）、`TransitionLog`（append-only 日志容器：`append` 拦截/`rollback` 截断重推/`history` 正序副本）、时间注入 seam `TimeSource`、约定值 `INITIAL_STATE`（null = 无前态）及各构造选项接口。

## 依赖
- 上游（本目录实际 import）：`core/json.ts`（`isRecord`、`JsonRecord`）。
- 下游（实际 import 本目录）：仅 `core/rules/predicates.ts`（`StateMachine`）；未上公共面（`src/index.ts` 无本目录导出，grep 核对）。
