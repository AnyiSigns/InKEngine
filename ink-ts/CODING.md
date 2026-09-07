# ink-ts 编码与组织规范（CODING.md）

本文件是 `ink-ts/` 工作区的编码纪律单一事实源，由 `gate/` 架构门禁做可执行
检查（规则与样例见 gate）。与代码组织相关的所有评审以此为准。

## 1. 分层与依赖方向

- `engine/`：L3 引擎库，内部双纯层 + adapters、依赖单向 `kernel/core ← adapters`：
  - `engine/src/kernel/`：机制件层（gate/审计/补丁链/执行器/settle/round_steps/
    runtime 状态机等机制件经契约化后归此）。与 core 同守纯函数纪律：零框架
    依赖、零 node 内置模块、零宿主/领域词；JSON 进 JSON 出；无 main、无全局
    状态、无 IO。进程/存储/时间/随机数/LLM/网络等副作用一律以**接口（seam）**
    声明在此层，机制只含纯逻辑与 seam 契约，不依赖下方 adapters。
  - `engine/src/core/`：机制纯函数层（数据面/扩展点/装配数据留守，与 kernel
    同受纯函数纪律与 gate 规则约束，见 §7）。零框架依赖、零 node 内置模块、
    零宿主/领域词；JSON 进 JSON 出；无 main、无全局状态、无 IO。进程/存储/
    时间/随机数/LLM/网络等副作用一律以**接口（seam）**声明在此层，核心机制
    只含纯逻辑与 seam 契约，不依赖下方 adapters。
  - `engine/src/adapters/`：机制心跳（LLM/存储/MCP）的可选 IO **真实现**，
    仍属引擎包而非宿主——kernel/core 只给契约，适配实现按 DI 装载。llm 协议
    适配器（openai-compatible / anthropic messages / openai responses，本地
    OpenAI 兼容端点）只发协议级 HTTP，不 import 任何厂商 SDK；storage 驱动
    （sqlite/memory 驱动，postgres 暂不提供）实现 core/kernel 仓储契约；
    mcp client 同层。本层允许 node:* 与驱动必需的第三方，但不得反向依赖
    kernel/core 私有文件。
- `contracts` 已收编入 engine：数据面契约资产随引擎内置（JSON 真源
  `engine/schemas/` + `engine/fixtures/` 与生成器 `engine/scripts/`；生成 TS
  常量/类型入 `engine/src/core/contracts/generated/`，随 engine tsc/gate 守门，
  禁手改由 contracts:verify 强制），不再有独立契约包。
- `gate/`：开发/CI 静态纪律工具（行数、UTF-8、import 白名单、词汇、src-test
  检查），真实扫描挂在 root `npm test` 与 CI（不再只手动），不打包进运行时。
- `host/`（原 `backend/`）：宿主装配层 / composition root——装配 engine
  Runtime、实现 `Host` 五件套、构建产品配方（AssemblyRecipe）、出宿主命令面
  bridge；只做「选哪个适配、读配置、注入 seam」与宿主薄服务接线；**不写厂商
  适配与存储驱动**（那是 engine/adapters 的职责）。机制语义（审批/补丁链/
  审计/闸门/沙箱判定）属 engine core，不得在此复制。不写 main、不监听端口、
  不是进程——被 cli / web 进程 / vitest import。
- `cli/`：唯一进程载体与宿主执行体（stdio/serve/run 三形态），注入实现到 seam。
- `web/`（原 `frontend/`）：前端纯渲染层，只渲染数据 + 触发补丁，逻辑不进组件；
  本质非服务进程（无 main/不监听），服务承载方 = cli serve。

术语：**host（原 backend）** = 宿主装配层 / composition
root；**cli** = 唯一进程载体（含 main + 三形态）；**web** = 前端纯渲染（L5，
只连 cli serve 通道）；exec/infer/ink_ts_mcp 为 Rust 原生机制件子进程
（OS 执行 / 本地嵌入推理 / 内置 MCP server）。包间依赖单向：`web/host/cli
→ engine`；engine 数据面契约内置
（schemas/fixtures/生成物同包），上层一律经 `@ink-ts/engine` 公共面消费。
域间不跨目录 import 私有模块。

当前实现状态：数据面枚举（端点名/补丁类型/审批分级/守卫集合/审计状态/
FieldKind 等）经 engine 内置生成物单源（`engine/schemas` + `engine/fixtures`
→ `engine/src/core/contracts/generated`），engine core 模块以相对 import
直接消费，本地不维护同值第二套字面量；core 层 import 无裸包白名单（gate
精确拒绝，见 §7）。生成物再经 `@ink-ts/engine` index 公共面导出，供
host/cli/web 取用。

## 2. 文件拆分纪律

1. 文件行数上限 **≤350 行**（含注释与空行），一个文件只做一件事：一个机制、
   一个组件、一个 seam、一个 hook、一个纯工具模块。
2. 超限例外必须显式标注文件头注释：
   `// gate: 超限(<N> 行) - 原因`；仅允许「单一不可拆的注册表/协议/schema
   常量/生成代码」类文件。超限未标注 → 门禁拒绝。
3. React 组件文件不含业务逻辑：数据取用走 hook/channel，副作用走领域服务；
   组件文件只含渲染 + 绑定声明，逻辑文件为纯 TS（可测、无 JSX）。
4. 单组件 JSX ≤350 行；超出即拆子组件到同目录 `__parts/` 或按 ui_spec 拆为
   独立注册组件，禁止「上帝组件」。
5. 需要存储/LLM 等 IO 的机制：接口与仓储契约在 `engine/src/core`（纯 seam），
   IO 实现在 `engine/src/adapters`（可选装载、DI 注入）——core 保持纯函数无
    全局状态，宿主/host 只装配不实现。
6. 超过 350 行仍膨胀 → 按「子机制/子渲染区」拆目录，不凑文件。
7. **测试与源码分离**：vitest 测试一律放所属包 `test/` 目录（镜像被测 src
   路径，文件仍名 `<机制>.test.ts`），禁止与业务源码同目录——`src/**` 内
   出现 `.test` 文件即门禁拒绝（规则 `src-test`）；门禁另扫描
   `engine/test`、`cli/test` 与 `host/test` 的行数上限。
   注：本条为「按层/包分离」形态；插件化落位后（`docs/component_data_endgame.md`
   §4.1/阶段 7a）改为「测试随插件目录同住」（已定稿 2026-09-07）——即独立的
   `.test.ts(x)` 文件与源码同目录并列，非内嵌进源码文件；届时同步修订
   本条与 gate `src-test` 规则。

## 3. 注释纪律

1. 代码文件（含注释）禁止计划推进字眼（阶段编号/任务编号/进度状态/计划
   记号，如「阶段五」「计划 X」「A1」「E4」）；代码即最终事实。
2. 注释一律叙述口吻：说明意图/权衡/边界，不写「做了什么」的流水账；
   关键算法与复杂逻辑必须有意图注释。
3. 注释语言随代码主体（本工作区采用中文或英文均可，但单仓保持一致；
   以本文件定稿为准）。
4. 禁止过期注释：注释只解释「这一段当前代码」的作用（如某函数提供何
   作用）；通俗的机制功能描述只在每端最顶层（文件/模块头注），函数级
   注释不重复机制叙事。
5. 删除功能不留残留注释；「已迁移/已删除」类注释须显式提示「下轮审查
   请及时清理」，否则按残留清理。

## 4. 代码健壮性

1. 错误处理闭环：每个可失败路径有明确错误语义；重试/降级策略显式声明而非
   隐式吞错；边界条件全覆盖（空输入、超长、并发、非法值）。
2. 服务稳定不崩溃：宿主可兜底重启，但机制层不依赖兜底。
3. 禁止魔法数字/字符串散落：抽为常量/枚举/引擎数据面契约常量。

## 5. 数据面 / 钩子面

1. 可 JSON 表达的契约（枚举、注册表条目、配方数据）只落 `engine/schemas` +
   `engine/fixtures`（JSON 真源），生成 TS 常量/类型入
   `engine/src/core/contracts/generated`，core 模块相对 import 消费，
   host/cli/web 经 `@ink-ts/engine` 公共面取用，全仓同构，禁止第二套语义
   枚举。
2. 行为钩子（Callable/执行体接线）不落 JSON，只以 seam/类型存在于消费层，
   命名带明确职责后缀。
3. 新端点类型/谓词/补丁类型注册进 engine 数据面契约（schemas/fixtures →
   generated 重生成）后全流水线走通，不存在「跳过流水线环节」的开关。

## 6. 可测试性与可观测性

1. 依赖可注入（DI/入参式），纯逻辑与副作用分离，单测零真实进程。
2. 结构化日志（JSON 行）记录关键指标（耗时/成功率/错误码）；TraceId 沿调用
   链传递；非重要信息不落。
3. 每个机制的实现必须带 vitest 对标测试；测试置于所属包 `test/` 目录并
   镜像被测 src 路径（见 §2.7），禁与业务源码同目录。

## 7. gate 检查与仓库一致关系

| 检查 | 对象 | 强度 |
|---|---|---|
| 文件行数 ≤350（例外须标注） | engine/host/cli/web 源码与测试 | 拒绝 |
| src 内夹测试文件（`.test` 在 src 目录） | 各包 `src/**` | 拒绝 |
| 源文件非法 UTF-8 字节（含损坏转码） | 各包 `src/**` | 拒绝（utf8-valid） |
| core/kernel 禁 node:* 与第三方 import | `engine/src/core/**`、`engine/src/kernel/**` | 拒绝（`node:async_hooks` 白名单例外：镜像 Python core contextvars，清单见 gate config；core/kernel 无裸包放行——数据面契约经相对 import 引用同包内置生成物，不放行其它 @ink-ts/*、adapters 与第三方） |
| core/kernel 禁反向依赖 adapters | `engine/src/core/**`、`engine/src/kernel/**` | 拒绝 |
| core/kernel 域间私有模块跨目录 import（`../<dir>/_*`） | `engine/src/core/**`、`engine/src/kernel/**` | 拒绝（跨域共享 seam 例外：目标私有模块文件头标注「跨域契约模块」并注明理由，如 `_types/_constants/_injection` 类类型 seam 与共享工具） |
| adapters 反向 import core/kernel 私有模块（`core/**/_*.ts`、`kernel/**/_*.ts`） | `engine/src/adapters/**` | 拒绝（公共 seam 例外同上标注，须注明为公共 seam） |
| core/kernel 禁宿主/框架词 | `engine/src/core/**`、`engine/src/kernel/**` | 拒绝 |
| JSON 纪律：可 parse、无重复键、2 空格缩进格线 | `seed_data/**`、`engine/schemas`、`engine/fixtures` JSON | 拒绝（json-valid） |
| 生成文件禁手改 | `engine/src/core/contracts/generated/**` | 由 `contracts:verify`（engine/scripts/verify_generated.mjs：复制 engine/schemas + fixtures 后重生成，与仓库生成物归一化逐文件 diff）在 root `npm test` 与 CI 强制；不做文本扫描 |
| 机制件契约三键（依赖单向/装配完整/0-IO） | `engine/src/kernel/<mechanism>/contract.ts` 全量 + runtime 装配闭包 + kernel 源码 | 由 `verify:mechanisms`（engine/scripts/verify_mechanisms.ts：契约密封 DAG 无环 + runtime depends 闭包 ∪ 自足叶子覆盖全量 + kernel 禁 node 内置/第三方/IO 全局原语）在 root `npm test` 与 CI 强制；boot 装配首步同源 `seal_mechanism_registry` fail-closed |
| 命令声明即挂载（方法名不手写数组） | `host/src/bridge/index.ts` 的 `BRIDGE_METHODS` | 由 `verify:bridge-mount`（host/scripts/verify_bridge_mount.ts：BRIDGE_METHODS 数组体只允许各域 `*_COMMANDS` spread 或注释，禁点分方法名字面量；spread 常量须已 import）在 root `npm test` 与 CI 强制；键与实现表一致由各域工厂 `Readonly<Record<DomainCommand, BridgeHandler>>` 返回类型编译期保证 |

gate 实现与正反样例位于 `gate/src/` 与 `gate/test/`；**真实扫描链** =
root `npm test` 首段 `npm run typecheck --workspace engine`（engine tsc
全量类型检查，generated satisfies 生效处）→ `tsx gate/src/check.ts`
（对 engine/host/cli/web 工作树实际执行全部规则，含 seed_data 与 engine
schemas/fixtures 的 json-valid）→ `vitest run --root gate`（规则样例自测）
→ `tsx engine/scripts/verify_mechanisms.ts`（机制件契约三键）
→ `tsx host/scripts/verify_bridge_mount.ts`（命令声明即挂载：BRIDGE_METHODS
无手写方法名），
CI 的 ink-ts job 同链执行。规则增删须同步本表。

## 8. 模型角色槽（配置语义与措辞纪律）

1. 模型按**角色槽**配置，不按档位。引擎固定两只语义槽：`agent`（对话主
   模型——身份/会话默认模型/图运行主链，**唯一兜底槽**）与功能槽
   `router`（蒸馏判定/轻量决策）。扩展功能槽 = 引擎侧角色槽模块加角色常量
   并注释用途即生效（无需声明式装配注入）；未知/None 角色一律归一 agent，
   防拼写错误静默换槽。
2. 配置形态：`model_config` 为 dict，角色配置键 =
   `model_config.{agent_config, router_config}`，各角色备用链
   键 = `{role}_fallback_configs`。`main_config`/`main_fallback_configs` 仅作
   agent 槽兼容别名（`agent_config` 优先），是挡位→角色迁移期入口，新代码
   不再新增别名使用面。
3. 回落语义：功能槽缺失或显式空 `{}` = 该槽未配置 → **显式回落 agent**，
   可观测不静默（来源 `source_role=agent`/`fallback=true` 随 RoleModelStats
   与审计以 `role→agent` 键记录）；agent 槽缺失/空 → 该角色机制停用或
   确定性降级（如蒸馏走确定性基线），绝不跨槽顶替、不隐式换用其它模型。
4. 实现锚点：角色槽原语收敛于 `engine/src/core/model_roles/modelRoles.ts`
   （`resolve_role_model` / `build_role_model_chain` / `RoleModelStats`，
   机制层零模块级可变状态）；knowledge_signals 蒸馏链走 router 槽；
   `llm/cache` 的 `tag` 仅为通用用途桶标签（随指纹与记录落库，供命中率/
   审计按桶统计），与角色槽机制无关。
5. 措辞纪律：凡涉及模型配置与回落的引擎注释/评审，禁用模型「档位/tier」与
   「main_config 回落」的挡位化表述；下列既有非模型档位术语不受此限（字段
   与语义不同，勿混淆）：`edge/trust-tier`、`safety_tier`、approval 档、
   reasoning 档。

## 9. host bridge 命令面清单（方法增删须同步本表 + 各域文件声明元组 `*_COMMANDS`；`BRIDGE_METHODS` 由域声明 spread 派生，`verify:bridge-mount` 强制）

| 方法 | 域 | 语义（机制在 engine，host 只接线） |
|---|---|---|
| `rounds.send` | rounds | run 级组装回合（Runtime.assemble_round：input → 组装出本轮数据图 → 建本轮 Engine 执行，事件落文件传输 + 在途 run 登记） |
| `rounds.abort` | rounds | 中止当前在途 run（Runtime.abort_current_run；JS 取消模型降级见代码注） |
| `rounds.resume` | rounds | 审批决议重入（Runtime.resume_run：按 checkpoint `_round_graph` 重建本轮引擎同图续跑） |
| `rounds.branch` | rounds | 分支续跑（Runtime.resume_round：按锚点 checkpoint 关联图重建，同语义续跑新叶） |
| `rounds.todos` | rounds | 回合待办（最新 checkpoint.plan 未完成步骤 + 链尾挂起审批卡；无 = 空清单） |
| `records.sessions` | records | 会话索引查询（host 薄数据：rounds 收尾 upsert 的索引记录） |
| `records.chain` | records | 链记录（chain_index + checkpoint to_dict，engine 权威） |
| `records.ledger` | records | 回合账本窗口（引擎 ledger 集合事实行投影：intent/conclusion/events → {kind, action, node_id, detail, ts}；storage.list_records_page 按 `thread_id\u001f` 键前缀+游标分页取窗口，时间倒序 + limit） |
| `sessions.create` | sessions | 会话薄服务：建会话（host 数据目录持久化，引擎无 session 域） |
| `sessions.rename` | sessions | 会话重命名 |
| `sessions.delete` | sessions | 会话删除（tombstone；引擎无 per-thread 全删原语，事件日志保留） |
| `sessions.refresh` | sessions | 会话簿刷新 |
| `sessions.tree` | sessions | 会话/分支树查询 |
| `sessions.messages` | sessions | 会话消息回取（records 链投影：读主线链叶 checkpoint state 一次即得最终消息，不逐 checkpoint 回放；行 = {id, kind(message/tool), text?, role?, created_at, meta?}） |
| `approval.list` | approval | 审批卡查询（engine.get_latest_interrupt 挂起卡） |
| `approval.resolve` | approval | 审批裁决（决议注入 → resume_run） |
| `audit.export` | audit | 审计导出（SET_AUDIT_COLLECTION 只读窗口，原始数组） |
| `audit.list` | audit | 审计窗口（独立方法：kind/after 过滤 + limit 截断 + ts 倒序，返回 {records}） |
| `tools.full` | tools | 全量工具视图（每行附 vector/baseline/approved/enabled 消费旗标 + uses_vectors/degraded_reason 全局态） |
| `recovery.checkpoints` | recovery | 可回退点查询（engine recovery） |
| `recovery.rollback` | recovery | 回退入口（删链节点 + set_audit 留痕，调 engine recovery） |
| `recovery.reset` | recovery | 重置入口（危险操作：confirm 须精确 `'factory-reset'`；thread_id 缺省 = 全量（逐会话清链 + 清 host.sessions/ledger/memory + 清事件日志），显式 = 单线程（链 + 会话墓碑 + 该线程事件日志）；摘要含 events_cleared/knowledge_kept/audit_kept，set_audit/知识集保留不参与，如实标注） |
| `backup.export` | backup | data_dir 整包 zip 导出（store-zip + manifest；dest 缺省 data_dir/backups） |
| `backup.preview` | backup | 备份包预览（覆盖清单：条目数/总大小/含库/created_at） |
| `backup.restore` | backup | 备份恢复替换（危险操作：confirm 须精确 `'backup-restore'`；恢复前原目录快照入 data_dir/snapshots） |
| `mcp.market` | mcp | 市场浏览（seed_data/mcp_market.json + 每 server mounted 连接态；preview/add/remove 无真源不提供） |
| `mcp.mount` | mcp | 市场服务挂载（config = McpServerConfig 数据形态；连接 + 工具导入，失败 fail-closed） |
| `mcp.unmount` | mcp | 市场服务卸载（manager.disconnect；未挂载显式拒绝） |
| `knowledge.list` | knowledge | 知识集条目窗口（query/kind 过滤 + archived 含归档开关；条目渲染视图） |
| `knowledge.graph` | knowledge | 知识层级概览（层级计数 + 组件支持 kind 节点/边；无知识 = degraded） |
| `knowledge.export` | knowledge | 知识 JSON 导出串（无 kind = 全量补丁链可移植；kind = 单类条目子集） |
| `memory.list` | memory | 记忆清单（query 子串过滤 + limit 前移为驱动层分页：storage.list_records_page 游标窗口 + 召回 top-limit；namespace 分组计数 + 条目窗口） |
| `memory.invalidate` | memory | 记忆批量失效（{ids}；引擎 delete = 非破坏性标记；缺失记 not_found） |
| `growth.report` | growth | 自学习/调参状态报告（enabled + config_summary + weights_snapshot? + last_tuned_at?；无装配 = enabled + nulls） |
| `os.run` | os | 受控 OS 执行器调用（host 裁决面门 + exec 信封机械复核；headless 仅显式 --approve 放行） |
| `workspace.state` | workspace | 工作区授权态（authorized/root/mounts，data_dir/workspace.json） |
| `workspace.set` | workspace | 设置工作区授权根（绝对路径须存在） |
| `workspace.revoke` | workspace | 撤销工作区授权根 |
| `workspace.mount.add` | workspace | 追加挂载目录（多沙箱根） |
| `workspace.mount.remove` | workspace | 移除挂载目录 |
| `dialog.open_directory` | dialog | 原生目录选择（exec Rust 原生件 rfd；宿主 UI 面，非 agent 端点） |
| `search.keys.set` | search | web_search 密钥写入（宿主内存域；不落盘，web 只回显掩码） |
| `search.keys.get` | search | web_search 密钥掩码查询（无明文外泄） |
| `material.import` | material | 既有资料批量导入（目录扫描 → 逐文件 doc.parse → 文本/引用归一入会话；三重上限 fail-closed） |
| `models.config.get` | models | 模型运行配置掩码态查询（config.json 明文不出进程；含 agent/router 槽已配置态与厂商面 providers） |
| `models.config.put` | models | 模型配置保存（`{config: {...}}`）。输入含 `providers` = 厂商面整档写：按 `agent_pick`/`router_pick` 从厂商模型清单派生角色槽端点（agent=对话模型、router=功能槽；缺省 agent 回落首厂商首模型）后 apply；无 `providers` = 既有角色槽直写合并。校验 → host apply → 原子落 data_dir/config.json → 引擎重建，下轮生效 |
| `models.config.reload` | models | 模型配置重载（从 data_dir/config.json 重读 → apply → 引擎重建；冷启态再装配） |
| `models.config.role_pick` | models | 角色槽指派（`{role: agent/router, provider_id, model_id}`：模型须在已添加清单，同值 no-op；写 pick → 派生槽端点 → 落盘 → 引擎重建） |
| `model_archive.snapshot` | model_archive | 模型档案快照（从运行 model_config 聚合：角色槽/备用链端点 + 厂商 models 清单展开为 model_id 行；与 config.json 同源，无 sqlite 探测） |
| `capability.get` | capability | 能力记录读取（自动审批预授权 `auto_approve_tools`/`auto_approve_all_review` + 工具回合上限 `max_tool_rounds`；data_dir/capability.json；缺省字段注入——auto 出厂空集，不落盘固化缺省。推演档位语义已移除——不设档位直接开启，历史 `simulation_tier` 键读档丢弃） |
| `capability.put` | capability | 能力记录存档（单字段并入语义 + 白名单校验（auto 字段/上限），非法不落盘；策略实例为活读面，put 后下个审批请求生效） |
| `policy.route` | policy | 策略层路由预览（确定性任务分类 → 计划形态 → 档位/配额；零 LLM，规格见 bridge/policy.ts） |
| `ui_components.get` | ui_components | 出厂界面组件启停态（factory/disabled/active 三清单；engine 同源） |
| `ui_components.set_disabled` | ui_components | 整集替换出厂组件停用集（`{disabled: string[]}`；未登记名结构化拒绝） |
| `graph.instance` | graph | 最近回合组装图投影（introspection 内省图源 = 引擎每轮回合组装的图）+ 该线程最近一回合执行事件节点态（error=failed/其余=success）；无任何回合（宿主不产静态/默认图）= 空图 degraded 空态，不报错 |
| `pool.snapshot` | pool | 池治理登记快照（runtime.pool_governance.log 窗口 + 登记记录派生计数：容量/死结点候选/近重复/周预算；无登记 = 空态 + last_round:null） |
| `pool.evaluate` | pool | 池治理判定入口（引擎 evaluate 四规则只登记不执行；需 `proposal.node_id`，snapshot 可选；无登记器 = available:false 空态） |
| `edge_evidence.list` | edge_evidence | 边证据条目窗口（runtime.edge_evidence_store 投影：domain/source 过滤 + limit 截断；无 store = 结构化空态） |
| `metrics.snapshot` | metrics | 回合指标会话窗口（runtime.turn_metrics 投影：rounds/failures/avg(failure_rate)/llm_calls_by_role + skill_crystallizer 结晶计数 crystallized；无装配 = 空态） |
| `assemble.stats` | assemble | 组装链统计（assembler_enabled/contract_enabled/fingerprint_cache 统计/canary 门 + 累计 stats + restore_diag 恢复诊断 + skill_crystal 结晶装配态；未挂载 = available:false 空态） |
| `cache.stats` | cache | 指纹缓存计数（全域 entries + per_domain + stats 观测统计）+ multipath 配置态（引擎无独立多径缓存，计数如实单一）；无 store = 空态 |
| `path.state` | path | path_assembler 装配状态（runtime 挂载 / enabled 开关位 / canary 门 / 最近组装候选数与选择留痕；未挂载 = available:false 空态；thread_id 非本方法消费） |
| `entities.snapshot` | entities | 实体注册表快照（实体目录 id/label/model + 配额态 count/max；无注册表 = 空态 degraded） |

host bridge 与 cli `host.ping`/`host.info` 命名空间独立并存（方法表并入 cli 命令面）。
JSON-RPC 信封错误只回通用、细节走 diag（复用 `cli/src/diag.ts` 形态）。
serve/transport 方法面另设扁平↔点分别名层（`cli/src/legacy_aliases.ts`）：web 旧扁平命令名
（round_send/session_*/search_keys_put/material_import/models_config_* 等）映射到上表点分方法；
`models_config_*`/`model.reload` 落 models.config.*（models_refresh 语义 = 保存 + 刷新，
最小实现即 models.config.put）；`capability_get`/`capability_put` 落 capability.*（put 解包
`{record}` 入参）；`route_plan` 落 policy.route。H2 桥面别名：`session_messages→sessions.messages`、
`round_ledger_chain→records.chain`、`round_ledger_list→records.ledger`、`todo_get`/`todo.get→
rounds.todos`、`recovery_factory_reset→recovery.reset`（确认标记不回代，缺 confirm fail-closed
拒绝）、`recovery_snapshots→recovery.checkpoints`、`recovery_restore_snapshot→recovery.rollback`、
`tools_manifest→tools.full`、`tools_baseline_get/set→capability.baseline.get/set`、
`security_tier_overrides_set→capability.tier.set`、`backup_export/preview/restore→backup.*`、
`mcp_market_status/mount/unmount→mcp.market/mount/unmount`；`round_ledger_merge`、
`mcp_market_preview/add/remove`、`memory.update_frontmatter` 无真源不提供；`audit.list`/
`knowledge.*`/`memory.*`/`growth.report` 以同点分登记。H2b 读取类别名：
`graph_instance_snapshot→graph.instance`（camel→snake 适配）、
`pool_snapshot→pool.snapshot`、`pool_evaluate→pool.evaluate`、`edge_evidence_list→edge_evidence.list`、
`metrics_snapshot→metrics.snapshot`、`assemble_stats→assemble.stats`、`cache_stats→cache.stats`、
`path_state→path.state`、`entities_snapshot→entities.snapshot`；`tools_snapshot`/
`graph_snapshot` 无产品消费已删（tools.full/graph.instance 保留）。无点分落点不注册。
不补的旧扁平命令（web 批次删除/降级消费，别名表保留兼容但不用）：`shell_open_path`、
`offline_*`、`backend_status`/`engine_boot`/`first_run_dismiss`、security 旧面、arch op
**写类/越权类**（`path_assemble`/`path_choose_candidate`/`path_set_multipath`/
`path_set_assembler_enabled`/`path_clear_candidate`/`cache_clear`/`cache_invalidate`/
`cache_rebuild`/`edge_evidence_update`/`edge_downgrade_tier`/`edge_restore_tier`）——读取类
（graph_instance_snapshot/pool_snapshot/pool_evaluate/edge_evidence_list/
metrics_snapshot/assemble_stats/cache_stats/path_state/entities_snapshot）已落点分只读方法。

## 10. 机制接线注记（host 装配语义补充）

- 产品配方开关默认表（recipe.ts `PRODUCT_SWITCH_DEFAULTS`）十位全开且每位真实消费：
  八位经 AssemblyRecipe 机制开关字段（contract/edge_evidence/settle_hooks/
  pool_governance/assembler/fingerprint_cache/canary_verification/
  context_window_multidomain/emit_timeline_events）、两位经 run_options
  （multipath_enabled/emit_timeline_events）逐位落到引擎；删除开关表须同步删除
  `assert_product_switches_all_on` 断言与单测。memory_extract/skill_crystal 自学习族
  开关不在产品表（引擎默认开）。
- 回合 = 组装、无默认图（语义不变量）：引擎/宿主都不存在「默认图/出厂图」——
  round 入口 = run 级组装出本轮数据图再执行（Runtime.assemble_round）；恢复/
  审批重入/分支按 checkpoint 关联的本轮图定义（随 state 保留键 `_round_graph`
  落库，`graph_version` = 图 digest）重建本轮 Engine 续跑（resume_run/
  resume_round）。图架构全是数据：池结点类型/边先验（引擎内置池种子
  engine/src/core/nodes：llm_decider/tool_pipeline/terminal 等，注册进
  node_registry 并随池种子给数据）/组装产物/checkpoint 图定义。host 配方
  （recipe.ts build_product_recipe）不产任何图（AssemblyRecipe 无图配方位，
  host/src/graph.ts 已删），CLI 亦不再有占位图/`--graph` 选图。
- `max_tool_rounds` 消费点：引擎 llm_decider 节点 config 的 `max_tool_rounds`
  （工具回合上限；引擎池种子 default_config/登记数据携带，缺省常量
  ENGINE_DEFAULT_TOOL_ROUNDS=8，见 engine/src/core/nodes）。host 能力记录
  （capability.json）的 max_tool_rounds 只作声明的装配位存档，不再喂宿主
  静态图——宿主已无静态图。
- 存储缺省 sqlite（沉淀跨会话）：host/cli 缺省存储 = data_dir 下 sqlite 库
  （config.ts `default_storage_uri` → `sqlite:///<data_dir>/ink.sqlite`；
  INK_STORAGE_URI / 显式输入可覆写；显式 `memory://` 走内存后端——测试与
  演示显式声明不受影响）。账本/治理状态/注册登记/知识等沉淀经 records/
  checkpoint 落库跨会话复用；sqlite 文件属运行产物不入库（.gitignore
  `*.sqlite` / `.ink-host/`）。
- 内省/架构读口数据源 = 最近回合组装图投影：引擎 `_build_graph_engine`（run 级
  组装/恢复/分支重建共用）每次把本轮组装图刷入 introspection 图源
  （`snapshot_graph`），host `graph.instance`/web architecture 随最近回合可见；
   无任何回合 = 空图 degraded 空态，不报错不回归。host 桥 `tools.full`/
  capability baseline/`approval.list` 以 runtime 装配态（storage 在位）判可用；
  引擎无常驻静态引擎，`approval.list`/`rounds.todos` 直读 checkpoint interrupt
  （链尾挂起卡 = 引擎链尾态）。
- 审批策略活读面（host.ts `HostInterruptPolicy`）：autoApprove 显式 true = 全量直过；
  否则按能力记录并入 `auto_approve_all_review`（全量直过）/`auto_approve_tools`
  （工具命中直过）；其余 fail-closed。判定现取 capability 记录，put 后下个请求生效。
- exec http op 已移除（D16）：`ExecOp`/信封/裁决面门/`os.run`/doc/dialog 不再含
  http 与 allow_domains；`hostAllowed` 保留为**检索出网白名单**纯函数（web_search
  provider 域名过滤，非 exec op）；`os.run` env 请求键黑名单禁覆写 `INK_*` 保留键。
- MCP 装配（host/src/mcp/assembly.ts）：管理器注入引擎声明式执行器
  （register_mcp_executor）+ `runtime.mcp_manager`（stop 收口/端点探活）；
  内置 server（inkling_exec/inkling_shell）由 ink-ts 产物内原生二进制
  ink_ts_mcp 承载（`ink_ts_mcp <exec|shell>`，exec/crates/mcp-server；exec
  复用 exec ops、shell 复用 infer 嵌入，INK_MCP_ROOT/INK_MCP_PROCESS_ALLOW
  沙箱 fail-closed）——装配期 `resolveBuiltinOverrides` 定位二进制 + profile
  参数 + Content-Length 分帧注入 connect_builtin overrides（engine 内置
  注册表 registry.ts 同步为 STDIO + content_length）；二进制未定位/连接失败
  一律 fail-closed 只记诊断（createHost 返回 mcpStatus 可查）；backup 等
  产品桥经 `createHost.mcpManager` 取用（H2 扩面）。环境变量表（INK_MCP_ROOT
  等）与工具集约定见 exec/CONFIG.md §2.4/§6。
- 工作区信任模型 = 「纯授权台账 + 调用方自述」：workspace.json 只记用户授权根/挂载
  清单；os.run/doc 的 roots/allowlist 由请求方自述、宿主裁决面门信封校验 fail-closed，
  不与 workspace.json 强制求交（详见 workspace/store.ts 头注）。
- 检索域写面：`createHost.retrieval.store`（upsert/remove 写入口）与 createHost 内
  tool_index 语义检索接线（attachToolIndexEmbedder → handle.toolEmbedder）——资料/
  知识入库的宿主域调用面；tools.full 随向量态可观测。
- 池治理「可写实体注册表」接线点（R3 决策 A）：引擎 core 已定义可写 seam
  `GovernanceWriteTarget`（list/archive/evict/merge + `GOVERNANCE_WRITE_TARGET_NOOP`
  回落），实体注册表装配时 runtime 挂注册表面向的受守卫写实现（entity_writer
  管线 + 审计）；池治理 settle 在裁决产生可写目标时经 seam 反写（dead →
  archive、near-duplicate → merge 保权威），目标不存在/无 seam = 回落登记 +
  审计。宿主后续可按需装配更多实体源（F3 接缝）。
- 产品主壳 spec 直渲（seed ui_spec.json 唯一布局真源）：UIRenderer 为唯一产品
  渲染入口，布局结构不在壳层硬编码（App 只装配宿主数据/动作，经 product chrome
  注入渲染器）。canonical 组件（file_tree/session_list/message_list/agent_input/
  top_bar/evolution_feed/ledger_view/trajectory_view/todo_view/mechanism_view/
  review_card/settings_floater/task_capsule）映射到产品实现（薄适配器在
  web/src/app/rendererAdapters，binding 载荷 → 产品组件 props）；四个 gate 锚点名
  （file_tree/session_list/message_list/agent_input）保持注册映射新适配器。
  出厂白名单三处同源：host/src/recipe.ts ui_allowed_components/ui_allowed_theme_tokens
  ← 引擎 runtime 出厂集；inkling/manifest.json contracts.renderer_components；
  web 组件注册表（registerBuiltinComponents + registerProductComponents 对码测试
  守门）。改动任何一处须同步其余（gate/whitelistGate 测试防漂移）。
- 渲染归一（K5）：产品消息流唯一渲染 = MessageStream（经 spec message_list
  canonical 引用）；components/messages/* 旧渲染子树已删除，图表/媒体条目收进
  app/session/parts；eventRenderers/messageRendererRegistry 只服务 agent 产物
  （artifact renderer_key）的事件渲染，product 面不再有第三套消息渲染。

## 11. 端到端评审纪律（人工审查，gate 静态扫描 §7 之外）

评审除 gate 静态检查外，须逐层端到端追溯**调用链 / 依赖链 / 消费链**，
识别架构可优化处。每发现一处注明严重等级（**阻塞 / 严重 / 建议**）+ 所属
功能/机制/用途 + 修正建议；涉及架构或功能缺失须主动与需求方/用户确认，
不擅自放行。

### 11.1 端到端语义一致（硬约束）

1. **三链追溯**：逐层追调用链/依赖链/消费链；前后端联合审查须额外校验
   接口契约一致、功能完整、前端正确消费后端数据，无遗漏缺陷。
2. **语义标签端到端断言**：凡界面文案/命令名/参数模式承诺某机制行为
   （如「组装」「回合=组装」），须沿真实调用链找到行为执行点并断言存在；
   覆盖「孤儿生产方（后端有功能无人消费）」与「孤儿语义标签（前端标了
   行为但后端不真做）」两类；找不到执行点按**阻塞**上报，不得以注释/
   占位/空态掩盖放行。
3. **禁止语义漂移/断链**：引擎/后端/前端语义一致——引擎有机制后端须实现、
   前端有 UI 后端引擎须实现，不得任一端断链。
4. **禁止待定功能**：不残留「机制先行/宿主待接线/未来接线/待引擎补全」等
   待接线功能机制；禁止任何待实现/待接线功能。
5. **禁止孤儿**：禁止孤儿功能/插件/机制；删除功能不留残留注释（见 §3.5）。
6. **功能默认全开**：无关闭机制，开关默认全开且每位真实消费（见 §10）。
7. **禁止单层自洽**：语义一致性须跨层成立，禁止层内自洽、整体失联。

### 11.2 安全

1. 禁止凭证硬编码（密钥/密码/Token/敏感凭据）。
2. 禁止不安全系统调用（rm -rf/eval/exec 类）。
3. 错误信息脱敏：后端错误堆栈不得完整返回前端，统一为通用错误码。

### 11.3 逻辑正确性

1. 需求真实完整实现，功能点被正确消费（前端调用/下游使用）。
2. 边界：空值/超时/并发/资源不可用全覆盖，try-catch 无遗漏（见 §4.1）。
3. 测试有效：用例具备实际验证能力，无 `assert True` 类无效断言。
4. 类型安全：类型定义与实际数据一致，无隐式 any/强制类型转换风险。
5. 语义标签真实性：注释/UI 文案里的行为承诺视作需求真源参与对链（呼应
   §11.1.2），防层内自洽掩盖跨层断链。

### 11.4 冗余

1. 禁止重复造轮子（复用已有工具函数/组件）。
2. 禁止无依赖引入（可被已有功能替代的第三方库）。
3. 禁止调试残留（print/console.log/debugger）。
4. 禁止死代码/孤儿代码：未用导入/变量/函数/空文件、无引用模块/组件；功能
   未实现须向用户确认是否占位，否则按冗余清理。
5. 禁止冗余/过期注释（见 §3.4）。

### 11.5 质量属性（§4/§6 之外补充）

1. 可维护性可扩展性：高内聚低耦合，接口稳定、变更隔离（插拔而非拆弹）。
2. 简洁性：10 行说清不写 100 行，避免伪健壮。
3. 性能：无慢查询/N+1/大对象循环/内存泄漏。
4. 用户体验：逻辑与功能实现注重用户体验；前端可选界面布局/视觉/交互/样式
   升级，项目文件结构清晰。
