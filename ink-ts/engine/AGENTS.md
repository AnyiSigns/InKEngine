# engine 引擎层契约（AGENTS.md）

engine = **受控自进化运行时的大脑（数据权威）**：纯函数 TypeScript 引擎，
JSON 进 JSON 出；核心零框架依赖、零 IO、零自持进程。详细定位/目录语义/验证见
`docs/subsystems/engine.md`（跨层权威）；数据面契约真源 = `schemas/`+`fixtures/`
→ `src/core/contracts/generated/`。

## 目录依赖（单向）

- `src/core/`、`src/kernel/`：机制语义与数据面纯逻辑，禁 `node:*`/第三方
  import（`node:async_hooks` 白名单唯一例外）、禁反向依赖 `adapters/`、禁宿主词
  （tauri/electron/vitest/react/inkling 等，opaque 协议串除外）。
- `src/adapters/`：IO 端口真实装（storage/llm/exec/mcp），DI 装载可覆盖；
  禁反向 import `core/**/_*.ts`、`kernel/**/_*.ts`（公共 seam 例外标注
  「跨域契约模块」）。
- 目标态用语：**kernel → adapters 单向**；现状机制件契约已落
  `src/kernel/<mechanism>/`（contract.ts + impl.ts + *.test.ts 同目录），历史
  领域逻辑在 `src/core/`，新代码优先落契约化目录，迁移同步文档。

## 本层禁止

- 不写 main、不监听端口、不读配置做决策、不实现厂商适配/存储驱动（那是
  adapters + host 装配的职责）；
- 不感知宿主/插件/前端：无 tauri/electron/react/inkling 字样（数据层）；
- 不维护第二套语义枚举：枚举/注册表/补丁类型/机制端口一律经 contracts
  generated（schemas+fixtures 真源生成，禁手改，contracts:verify 守漂移）。

## 验证命令

- `vitest run --root engine`（引擎单测 + 架构门禁随跑）
- `tsc -p engine/tsconfig.json`（typecheck）
- `node engine/scripts/verify_generated.mjs`（contracts:verify）
- `tsx engine/scripts/verify_mechanisms.ts`（verify:mechanisms：契约三键）
- gated docs 改动后：`tsx gate/src/check.ts`
