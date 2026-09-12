# engine 层（docs/subsystems/engine.md）

**层权威**：改 engine 先读本文件 + `engine/AGENTS.md`；跨层引用统一见
`../component_data_endgame.md`（总纲）与 `../PLUGINS.md`（插件契约）。

## 定位

L3 TypeScript 纯函数引擎（npm 包 `@ink-ts/engine`）：**大脑 = 数据权威**。
JSON 进 JSON 出，核心层零框架依赖、零 IO、零自持进程——IO 一律由端口 seam
定义、`adapters/` 实现、宿主装配注入。engine 不感知任何宿主/插件/前端存在
（core 词汇门禁禁 tauri/electron/vitest/react/inkling 等宿主词，见 CODING §7）。

## 目录语义（现状物理结构）

```
engine/
├─ AGENTS.md            # 本层契约（就近权威，见下）
├─ src/
│   ├─ index.ts         # 公共面（@ink-ts/engine 唯一出口，见 package.json exports）
│   ├─ core/            # 数据面契约 + 领域纯逻辑（零 IO）：
│   │                   #   contracts/generated/（schemas+fixtures 生成物，禁手改）
│   │                   #   执行模型主线（设计稿 agent_execution_design.md）：
│   │                   #     scopes/（作用域规格/目录种子/先验+prior 覆写）、
│   │                   #     channels/（通道规格与目录）、
│   │                   #     execution_runtime/（转场循环 run_loop、挂起续跑
│   │                   #       run_checkpoint/run_transition/run_result、白板穿透与
│   │                   #       __amend/__board 写路径、通道闸门 channel_gate、
│   │                   #       护栏 guardrails、回合子引擎 engine_turn_runner、
│   │                   #       隔离试跑 trial_runner、临时作用域 temp_scope）、
│   │                   #     whiteboard/（块模型/授权三元组/amend 仲裁门面）、
│   │                   #     collab/（裁决四步+仲裁三档/圆桌收敛判据）、
│   │                   #     org_archive/（组织档案+择优修剪阈值）、
│   │                   #     controlled_evolution/（采纳闸/结晶/提案应用/阈值配置面
│   │                   #       evaluate_options，演化资产只经受控通道落库）、
│   │                   #     context/（输入调配管线 + block_source 白板块→物理输入）
│   │                   #   支撑数据面：graph/events/state/run_result/nodes/plan/...
│   │                   #   （轨迹与图数据面纯逻辑；组装时代目录 assembly/、
│   │                   #     pool_governance、fingerprint_cache、thread_skeleton、
│   │                   #     path_assembler 已随执行主线切换退役，勿凭旧文档找回）
│   ├─ kernel/          # 机制件契约目录：<mechanism>/contract.ts + impl.ts + *.test.ts
│   │                   #   装配闭集 registry.ts：boot 组密封图 + 依赖单向校验
│   └─ adapters/        # IO 端口真实装（boot/llm/mcp/storage...）：DI 装载，可覆盖
├─ schemas/             # 数据面契约 JSON 真源（枚举/谓词/补丁类型/机制端口等）
├─ fixtures/            # 契约夹具 JSON 真源
└─ scripts/             # generate.mjs（schemas+fixtures→generated）+ verify_generated.mjs
```

核心不变式（architecture gate + verify 链强制，见 CODING §7）：

- `core/` 与 `kernel/`：禁 `node:*` 与第三方 import（`node:async_hooks`
  白名单唯一例外）；禁反向依赖 `adapters/`；禁跨域私有模块 import；
  禁宿主/框架词（命中即拒，opaque 协议串白名单如 `inkling.skill/v1`）。
- `adapters/`：禁止反向 import `core/**/_*.ts`、`kernel/**/_*.ts`（公共 seam
  标注「跨域契约模块」的例外放行）。
- 数据面契约（枚举、注册表条目、补丁类型、机制端口词表）只落
  `schemas/` + `fixtures/`，生成 TS 常量/类型入 `contracts/generated/`，
  全仓经 `@ink-ts/engine` 公共面取用——禁止第二套语义枚举。
- 机制件三键（`verify:mechanisms`）：依赖单向 DAG、runtime depends 闭包 ∪
  自足叶子覆盖全量、机制层零自持 IO；boot 装配首步 `seal_mechanism_registry`
  fail-closed。

## 边界（engine 不做什么）

- 不写进程、不监听端口、不读配置做决策（配置读取 = 宿主装配面）；
- 不实现存储驱动 / LLM 厂商适配 / OS 执行——这些是 `adapters/` 端口实现，
  且具体端点二进制由 plugins/endpoints 声明（见 exec.md）；
- 不带任何产品语义（会话 UI / 审批卡 UI / 工具面板归属 web 产品壳或插件）。

## 消费方与验证

- 静态消费：`hosts/lib`、`hosts/cli`（经 `@ink-ts/engine` 公共面）；
  `hosts/web` 与 `renderer` 不静态 import engine（运行时经 cli serve 通道）。
- 验证：`.venv` 无关——engine 用 `vitest run --root engine`、
  `tsc -p engine/tsconfig.json`、`node engine/scripts/verify_generated.mjs`
  （contracts:verify）、`tsx engine/scripts/verify_mechanisms.ts`
  （verify:mechanisms）；root `npm test` 全链首段 = engine typecheck + gate。

## 改动纪律

1. 改数据面枚举/契约 → 改 `schemas`/`fixtures` JSON 真源 + 重跑
   `node engine/scripts/generate.mjs`，generated 禁手改（contracts:verify 守漂移）。
2. 新增机制件 → `kernel/<mechanism>/contract.ts + impl.ts + *.test.ts`，
   在 runtime 装配注册并满足机制三键；gated docs 改动后必跑
   `tsx gate/src/check.ts` 与 `pytest ink_engine/tests` 中对应门禁（见根 AGENTS）。
3. 目录契约演进方向：现状 `core/` 契约化后归 `kernel/`；新文件优先落契约化目录，
   旧文件迁移时同步更新本文件与 engine/AGENTS.md。
