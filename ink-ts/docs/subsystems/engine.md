# engine 层（docs/subsystems/engine.md）

**层权威**：改 engine 先读本文件 + `engine/AGENTS.md`；跨层引用统一见
`../PLUGINS.md`（插件契约与机制闭集红线）。

## 定位

L3 TypeScript 纯函数引擎（npm 包 `@ink-ts/engine`）：**大脑 = 数据权威**。
JSON 进 JSON 出，机制层零框架依赖、零 IO、零自持进程——IO 一律由端口 seam
声明（`src/dock/ports*`）、**端口提供方插件实现**（`plugins/ports/*`，S2
适配器下沉）、宿主装配注入。engine 不感知任何
宿主/插件/前端存在（词汇门禁禁 tauri/electron/vitest/react/inkling 等宿主词，
见 CODING §7）。

## 目录语义（现状物理结构：六层现体 + 残部；adapters 已随 S2 移出）

```
engine/
├─ AGENTS.md            # 本层契约（就近权威，见下）
├─ src/
│   ├─ index.ts         # 公共面（@ink-ts/engine 唯一出口，见 package.json exports）
│   ├─ model/           # 数据面：数据契约与纯数据形态，零依赖首层——
│   │                   #   contracts/（契约声明语言）+ contracts/generated/
│   │                   #   （schemas+fixtures 生成物，禁手改）、schema、events/
│   │                   #   event_types、graph 数据面、perception、plan、workflow、
│   │                   #   ui_schema/product_ui、model_roles、scopes/channels、
│   │                   #   errors/json/path/py_repr 等共享数据原语
│   ├─ loop/            # 执行主线：回合与执行运行时——runtime、round_steps、
│   │                   #   tools（tool_pipeline）、execution_runtime（转场循环
│   │                   #   run_loop、挂起续跑 run_checkpoint/run_transition、白板
│   │                   #   穿透与 __amend/__board 写路径、通道闸门 channel_gate、
│   │                   #   护栏 guardrails、回合子引擎 engine_turn_runner、临时
│   │                   #   作用域 temp_scope）、whiteboard（块模型/授权三元组/
│   │                   #   amend 仲裁门面）、collab（裁决+收敛判据）、context
│   │                   #   （输入调配管线）、recovery/interrupt/trial（隔离试跑）/
│   │                   #   turn_settle/display_stream/llm/route
│   ├─ graph/           # 最小图解释器：executor（子图/条件边/检查点）、
│   │                   #   nodes（结点类型池 + default_engine_pool_seed 池种子）、
│   │                   #   exec_types（图执行协议结构接口面，S1-c）、
│   │                   #   node_registry、registry（图注册）
│   ├─ gate/            # 运行期「可不可以」：approval（审批裁决）、audit_log
│   │                   #   （审计）、budget（预算闸门）、patch（补丁链）、
│   │                   #   permissions（权限）、sandbox（文件/进程沙箱判定，
│   │                   #   exec seam 的机制侧实现）、security、tool_vetting、
│   │                   #   link_validator
│   ├─ evolve/          # 单一演化栈：pipeline、learn（知识/结晶学习面）、
│   │                   #   observe（inspection + org_archive 组织档案/择优修剪
│   │                   #   阈值）、param_tuning、proposal（evolution_writer 受控
│   │                   #   通道/controlled_applier 采纳闸/evaluate_options 阈值
│   │                   #   配置面/self_edit_tools）、skill（crystallization
│   │                   #   结晶）、legacy（旧演化件留守）；
│   │                   #   演化资产只经受控通道落库
│   ├─ dock/            # 对外契约面：ports.ts（机制端口词表单一真源，现 4 值）、
│   │                   #   ports/（events/exec/llm/storage seam 接口）、
│   │                   #   registry/（机制注册面：contract_types.ts + contracts.ts
│   │                   #   汇入 ALL_MECHANISM_CONTRACTS + registry.ts boot 密封，
│   │                   #   原 kernel/registry）、index/caps/calls/view 公共面
│   ├─ core/            # 残部（P8 逐层消化）：entities/knowledge_set/state/
│   │                   #   run_result 与 environments/harness 留守纯逻辑
│   └─（kernel/）       # 旧推演目录（simulation/multipath/spawn）与 core/
│                       #   fanout/ 已随 P8+S1 展开段退役删除，目录清零、禁复活
├─ schemas/             # 数据面契约 JSON 真源（枚举/谓词/补丁类型/机制端口等）
├─ fixtures/            # 契约夹具 JSON 真源
└─ scripts/             # generate.mjs（schemas+fixtures→model/contracts/generated）+ verify_generated.mjs
```

机制契约落点 = 各机制层 `<mechanism>/contract.ts`（契约与实现文件同住机制目录、
测试镜像 `engine/test/`），
现 27 项分布 loop(7)/gate(7)/evolve(12)/graph(1)（builder 契约已随 S1-c 退役、
kernel 残部三项 simulation/multipath/spawn 契约已随 P8+S1 展开段退役清零），统一经
`src/dock/registry/` 集中注册与 boot 密封（`seal_mechanism_registry`）。

核心不变式（architecture gate + verify 链强制，口径同 CODING §7）：

- 0-IO 条款作用集合 = coreDirs ∪ layerDirs：`engine/src/{core,kernel}` 残部
  （kernel 已随 P8+S1 清零，条款按 gate config 口径保留历史扫描集）+
  `engine/src/{model,graph,gate,loop,evolve,dock}` 六层，禁 `node:*` 与第三方/
  裸包 import（`node:async_hooks` 白名单唯一例外）；禁反向依赖与跨域私有
  import 条款仍按 core/kernel 口径执行（历史残留条款，见 CODING §7 表），
  新六层层向纪律由 layer-dag 矩阵执法（未定义层间边一律违规）；
  禁宿主/框架词（命中即拒，opaque 协议串白名单如 `inkling.skill/v1`）。
- （S2 适配器下沉）`adapters/` 层已随目录移出引擎：IO 实现位 = 端口提供方
  插件（plugins/ports/*，kind='ports'），宿主装配层按 manifest「ports」段装载
  注入；引擎侧不再有 adapter 区专属纪律（layer-dag 六层矩阵；`adapters→loop`
  过渡边已随 S2 消亡删除）。
- 数据面契约（枚举、注册表条目、补丁类型、机制端口词表）只落
  `schemas/` + `fixtures/`，生成 TS 常量/类型入 `src/model/contracts/generated/`，
  全仓经 `@ink-ts/engine` 公共面取用——禁止第二套语义枚举。
- 机制契约三键（`verify:mechanisms`，现 27 项）：依赖单向 DAG、runtime
  depends 闭包 ∪ 自足叶子覆盖全量、机制层零自持 IO；boot 装配首步
  `seal_mechanism_registry` fail-closed。

## 边界（engine 不做什么）

- 不写进程、不监听端口、不读配置做决策（配置读取 = 宿主装配面）；
- 不实现存储驱动 / LLM 厂商适配 / OS 执行——这些是 `plugins/ports/*` 端口
  提供方插件实现（S2），且具体端点二进制由 plugins/endpoints 声明（见
  exec.md）；
- 不带任何产品语义（会话 UI / 审批卡 UI / 工具面板归属 web 产品壳或插件）。

## 消费方与验证

- 静态消费：`hosts/lib`、`hosts/cli`（经 `@ink-ts/engine` 公共面）；
  `hosts/web` 与 `renderer` 不静态 import engine（运行时经 cli serve 通道）。
- 验证：`.venv` 无关——engine 用 `vitest run --root engine`、
  `tsc -p engine/tsconfig.json`、`node engine/scripts/verify_generated.mjs`
  （contracts:verify）、`tsx engine/scripts/verify_mechanisms.ts`
  （verify:mechanisms）、`tsx plugins/scripts/verify_unload.ts`
  （verify:unload）；root `npm test` 全链首段 = engine typecheck + gate。

## 改动纪律

1. 改数据面枚举/契约 → 改 `schemas`/`fixtures` JSON 真源 + 重跑
   `node engine/scripts/generate.mjs`，model/contracts/generated 禁手改
   （contracts:verify 守漂移）。
2. 新增机制件 → 四机制层终态归属：`<graph|gate|loop|evolve>/<mechanism>/`
   `contract.ts + impl.ts`（kernel 层已随 P8+S1 退役清零、禁复活），入 `dock/registry/contracts.ts`
   全量清单，在 runtime 装配注册并满足机制三键；gated docs 改动后必跑
   `tsx gate/src/check.ts` 与 `pytest ink_engine/tests` 中对应门禁（见根 AGENTS）。
3. 残部消化方向：`core/` 留守项按归属迁入 model/loop/graph；`kernel/` 推演
   残部与 `core/fanout/` 已随 P8+S1 展开段退役删除（迁移/删除时同步更新
   本文件与 engine/AGENTS.md 及各层 docs）。
