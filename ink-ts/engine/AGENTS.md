# engine 引擎层契约（AGENTS.md）

engine = **受控自进化运行时的大脑（数据权威）**：纯函数 TypeScript 引擎，
JSON 进 JSON 出；各层零框架依赖、零 IO、零自持进程。详细定位/目录语义/验证见
`docs/subsystems/engine.md`（跨层权威）；数据面契约真源 = `schemas/`+`fixtures/`
→ `src/model/contracts/generated/`。

## 目录结构（七层现体 + 残部）与依赖（单向，以 gate layer-dag 矩阵为唯一口径）

- `src/model/`：数据面层——contracts/ + contracts/generated/（生成物落点，
  禁手改）、schema、events/event_types、graph 数据面、perception、plan、
  workflow、ui_schema、model_roles、scopes/channels/environments/harness 数据形态等。
- `src/graph/`：最小图解释器——executor/nodes（含池种子）/builder/node_registry/
  registry。
- `src/loop/`：执行主线——runtime/round_steps/tools/execution_runtime/whiteboard/
  collab/context/recovery/interrupt/trial/turn_settle 等回合与执行机制。
- `src/gate/`：运行期「可不可以」——approval/audit_log/budget/patch/permissions/
  sandbox/security/tool_vetting/link_validator。
- `src/evolve/`：单一演化栈——learn/observe/param_tuning/proposal/skill/pipeline，
  演化资产只经受控通道落库。
- `src/dock/`：对外契约面——端口词表单一真源 `ports.ts`、seam 接口 `ports/*`
  （events/exec/llm/storage）、机制注册面 `registry/`（原 kernel/registry）与
  index/caps/calls/view 公共面。
- `src/adapters/`：IO 端口真实装——**实有 boot/llm/mcp/storage 四子目录（无
  exec）**：exec seam 声明在 `dock/ports/exec.ts`，沙箱判定实现在 `gate/sandbox`，
  OS 执行真身是 Rust 原生机制件子进程；llm 只发协议级 HTTP 不 import 厂商 SDK；
  storage 驱动 sqlite/memory（postgres 暂不提供）；DI 装载可覆盖。
- 残部：`src/core/`（entities/knowledge_set/state/fanout/run_result 与
  environments/harness 留守纯逻辑，随 P8 消化）与 `src/kernel/`
  （simulation/multipath/spawn 旧推演机制件，P8 退役，新机制件禁入）同守
  纯函数纪律。
- 依赖纪律：`node:*`/第三方 import 仅 adapters 允许（各 0-IO 层白名单唯一例外
  `node:async_hooks`）；禁反向依赖 `adapters/`；禁宿主词（tauri/electron/
  vitest/react/inkling 等，opaque 协议串除外）；adapters 禁 import 各机制层
  私有文件 `**/_*.ts`（公共 seam 例外标注「跨域契约模块」）。
- 机制件契约落点：各机制层 `<mechanism>/contract.ts`（契约与实现文件同住机制
  目录、测试镜像 `engine/test/`，
  跨 kernel/graph/gate/loop/evolve 五机制层，现 31 契约），经 `dock/registry/`
  集中注册、boot 密封；新契约落对应机制层，禁按旧「kernel 单一收编地」理解。

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
- `tsx engine/scripts/verify_mechanisms.ts`（verify:mechanisms：契约三键，现 31 项）
- `tsx plugins/scripts/verify_unload.ts`（verify:unload：插件卸载一致性）
- gated docs 改动后：`tsx gate/src/check.ts`
