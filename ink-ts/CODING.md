# ink-ts 编码与组织规范（CODING.md）

本文件是 `ink-ts/` 工作区的编码纪律单一事实源，由 `gate/` 架构门禁做可执行
检查（规则与样例见 gate）。与代码组织相关的所有评审以此为准。

## 1. 分层与依赖方向

- `engine/`：L3 引擎库，内部三段、依赖单向 `core ← adapters`：
  - `engine/src/core/`：机制纯函数层。零框架依赖、零 node 内置模块、零宿主/
    领域词；JSON 进 JSON 出；无 main、无全局状态、无 IO。进程/存储/时间/
    随机数/LLM/网络等副作用一律以**接口（seam）**声明在此层，核心机制只含
    纯逻辑与 seam 契约，不依赖下方 adapters。
  - `engine/src/adapters/`：机制心跳（LLM/存储/MCP）的可选 IO **真实现**，
    仍属引擎包而非宿主——core 只给契约，适配实现按 DI 装载。llm 协议适配器
    （openai-compatible / anthropic messages / openai responses，本地 OpenAI
    兼容端点）只发协议级 HTTP，不 import 任何厂商 SDK；storage 驱动
    （sqlite/memory 驱动，postgres 暂不提供）实现 core 仓储契约；mcp client 同层。本层允许
    node:* 与驱动必需的第三方，但不得反向依赖 core 私有文件。
- `contracts/`：L0/L1 数据面契约唯一真源（JSON schema + fixtures + 生成类型）。
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

术语（§3 对齐，写入本文）：**host（原 backend）** = 宿主装配层 / composition
root；**cli** = 唯一进程载体（含 main + 三形态）；**web** = 前端纯渲染（L5，
只连 cli serve 通道）；exec/infer 为 Rust 原生机制件子进程（OS 执行 / 本地
嵌入推理）。包间依赖单向：`web/host/cli → engine → contracts`。域间不跨目录
import 私有模块。

当前实现状态：`engine → contracts` 依赖已声明（`engine/package.json`
dependencies = workspace 包）并经生成物消费落地——engine 数据面枚举
（端点名/补丁类型/审批分级/守卫集合/审计状态/FieldKind 等）直接消费
`@ink-ts/contracts` generated 常量与类型，本地不维护同值第二套字面量；
core 层 import 白名单仅放行 `@ink-ts/contracts` 这一个数据契约包（gate
精确 allowlist，见 §7）。

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

## 3. 注释纪律

1. 代码文件（含注释）禁止计划推进字眼（阶段编号、任务编号、进度状态）；
   代码即最终事实。
2. 注释一律叙述口吻：说明意图/权衡/边界，不写「做了什么」的流水账；
   关键算法与复杂逻辑必须有意图注释。
3. 注释语言随代码主体（本工作区采用中文或英文均可，但单仓保持一致；
   以本文件定稿为准）。

## 4. 代码健壮性

1. 错误处理闭环：每个可失败路径有明确错误语义；重试/降级策略显式声明而非
   隐式吞错；边界条件全覆盖（空输入、超长、并发、非法值）。
2. 服务稳定不崩溃：宿主可兜底重启，但机制层不依赖兜底。
3. 禁止魔法数字/字符串散落：抽为常量/枚举/contracts 常量。

## 5. 数据面 / 钩子面

1. 可 JSON 表达的契约（枚举、注册表条目、配方数据）只放 `contracts/`，
   全仓同构消费，禁止第二套语义枚举。
2. 行为钩子（Callable/执行体接线）不落 JSON，只以 seam/类型存在于消费层，
   命名带明确职责后缀。
3. 新端点类型/谓词/补丁类型注册进 contracts 后全流水线走通，不存在「跳过
   流水线环节」的开关。

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
| core 禁 node:* 与第三方 import | `engine/src/core/**` | 拒绝（`node:async_hooks` 白名单例外：镜像 Python core contextvars，清单见 gate config；裸包仅精确放行 `@ink-ts/contracts`——engine→contracts 数据契约层唯一入口，不放行其它 @ink-ts/*、adapters 与第三方） |
| core 禁反向依赖 adapters | `engine/src/core/**` | 拒绝 |
| core 禁宿主/框架词 | `engine/src/core/**` | 拒绝 |
| 生成文件禁手改 | `contracts/src/generated/**` | 由 `contracts:verify`（复制 schemas/fixtures 后重生成，与仓库生成物归一化逐文件 diff）在 root `npm test` 与 CI 强制；不做文本扫描 |

gate 实现与正反样例位于 `gate/src/` 与 `gate/test/`；**真实扫描链** =
root `npm test` 首段 `tsx gate/src/check.ts`（对 engine/host/cli/web
工作树实际执行全部规则）→ `vitest run --root gate`（规则样例自测），
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

## 9. host bridge 命令面清单（方法增删须同步本表与 `host/src/bridge/index.ts` 的 `BRIDGE_METHODS`）

| 方法 | 域 | 语义（机制在 engine，host 只接线） |
|---|---|---|
| `rounds.send` | rounds | 回合驱动（Runtime 在途 run 登记 + engine.ainvoke 续链 + 事件落文件传输） |
| `rounds.abort` | rounds | 中止当前在途 run（Runtime.abort_current_run；JS 取消模型降级见代码注） |
| `rounds.resume` | rounds | 审批决议重入（Runtime.resume_run） |
| `records.sessions` | records | 会话索引查询（host 薄数据：rounds 收尾 upsert 的索引记录） |
| `records.chain` | records | 链记录（chain_index + checkpoint to_dict，engine 权威） |
| `approval.list` | approval | 审批卡查询（engine.get_latest_interrupt 挂起卡） |
| `approval.resolve` | approval | 审批裁决（决议注入 → resume_run） |
| `audit.export` | audit | 审计导出（SET_AUDIT_COLLECTION 只读窗口） |

host bridge 与 cli `host.ping`/`host.info` 命名空间独立并存（方法表并入 cli 命令面）。
JSON-RPC 信封错误只回通用、细节走 diag（复用 `cli/src/diag.ts` 形态）。
