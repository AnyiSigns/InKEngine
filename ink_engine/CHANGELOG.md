# Changelog

InkEngine 遵循 [语义化版本](https://semver.org/lang/zh-CN/)（`MAJOR.MINOR.PATCH`）：

- **MAJOR**：破坏性变更（接口/行为/存储 schema 不兼容，需要修改调用方或删库）；
- **MINOR**：向后兼容的新能力（新原语/新扩展点/新配置项，旧调用不变）；
- **PATCH**：向后兼容的缺陷修复。

> 存储 schema 不迁移：引擎表结构随版本演进，升级后启动期自检给出删库指令。
> 当前为 0.1.0 未发布基线（无 git tag），本文件按能力演进记录；发布时补 tag 与逐版本记录。

## 未发布（0.1.0 基线）

### 机制骨架：自研内核（engine-core）

- **图定义 DSL + 执行循环**：节点/静态边/条件边/嵌套子图/循环回路/回合终止
  信号（reply/止损/超限/异常/取消五类终止原因）；节点/边注册表开放；
  执行预算钩子（BudgetPolicy 节点边界检查终止）。
- **图即数据**：`Graph.to_dict()/from_dict()` 完整序列化（节点/边以注册名
  引用，函数直挂节点序列化显式拒绝防静默丢失）；图指纹（sha256）随
  checkpoint 落库，恢复时校验（不一致抛 GraphVersionMismatchError）。
- **checkpoint 版本链**：每节点快照 + parent_id 链，恢复 = 快照 + 增量日志
  重放；回合边界快照锚点；编辑重放 = 日志截断 + 新分支。
- **通用存储服务**：memory/sqlite/postgres 三后端（连接串切换），
  checkpoint 版本链/事件日志/结构化记录三通道统一落库，敏感键写入前
  剥离，并发写保护（原子链尾校验 + 乐观锁）。
- **事件流**：append-only 执行事件日志 + 传输接口化（EngineTransport）；
  EngineEvent 含 step_id/round_id/parent_step_id（轨迹树引用）与协议版本化。
- **interrupt 挂起/注入重入**（弹卡审批一等能力）：InterruptSignal →
  InterruptState 随 checkpoint 持久化 → 注入值后从该节点重入。
- **内容型补丁链**：append/replace/delete + assemble full/base_only/partial
  + rebase/truncate/branch；状态通道 + 字段级 reducer 注册表
  （add_messages/merge_dicts/merge_metrics/last_value/patch_chain）。
- **发散并行原语**（部分失败剔除 + 控制流异常传播取消）、域窗口投影/归档
  摘要、通用状态机原语（转换 = 补丁，append-only 推导）。
- **LLM 层（可选 extra `[llm]`）**：AsyncLLM 统一协议 + 消息数据类；
  OpenAI 兼容适配器（自写 SSE 流式解析，零第三方 SDK），
  openai/deepseek/zhipu/moonshot/ollama 别名；工具 schema 自写转换；
  reasoning_content 透传；适配器注册机制（未知适配器显式报错）；
  fallback 链（重试/退避/备用切换/认证失败 fail-closed/取消穿透）；
  embedding 接口（AsyncEmbedder + OpenAI 兼容适配器）。
- **记忆/挡位/评审原语**：记忆策略（MemoryStore 协议 + 召回策略 + 存储
  后端，非破坏性失效）；模型分层挡位（router/tool/main/audit 配置解析/
  按挡位建链/调用统计钩子）；测试时专才化评审-收敛（评审器/再生成器/
  web 验证钩子/收敛策略，阈值 + Beam + 轮次上限）。

### 领域原语下沉与声明式化（v5）

- **组件并入 core**：round_steps/review_card/review 迁为 core 平级模块，
  domain_window 并入 core/context.py；`ink_engine.components` 目录消亡。
- **novel_harness 退役**：领域代码全部数据化（历史沿革：
  `ink_engine/ink_engine/seeds/novel/` → 根级 `seeds/novel/` 独立包 →
  领域种子层整体移除，领域深度归宿主产品层，见「领域层定位收敛」）；
  `ink_engine.domain_novel` 兼容别名层一并移除。
- **运行时重规划（Planner Loop）**：新保留键 `__plan__`（节点序列/并行组/
  条件/spawn 项），引擎执行一段后重规划；计划 = checkpoint 快照字段，
  随版本链落盘与回滚；与 `__spawn__` 共存（计划 = 流的结构、spawn = 流
  的展开，可嵌套），同受 max_spawns 护栏与 error_on_exception 配置驱动。
- **决策点推演-回溯-换选（Simulate）**：新保留键 `__simulate__`，每个
  分支作为独立子链执行（隔离状态 + 独立 checkpoint 链 + 事件统一父链），
  评估器协议（Evaluator）打分 + 调配策略（BranchMixer，默认单选最高分）
  择优提交主线；落选分支保留为轨迹树引用，可回溯对比/换选；分支失败按
  部分失败语义剔除，全部失败按节点失败收口。
- **核声明式化（Rules as Data）**：规则 DSL（不变式/校验规则/状态转换
  规则的声明式数据形态 + 13 个内置谓词 + 样例库机制，fixture 全绿才允许
  落库为非谈判项）；加权打分器（维度+权重+阈值）；Schema 声明校验器
  （必填/类型/枚举/范围/正则）。
- **知识集孵化**：规则条目 = 补丁链数据；五类信号感知（踩坑/用户修正/
  洞见/流程缺口/重复根因）+ 蒸馏（复用优先于生成，精准补丁 replace 语义）；
  三层验证闸门（L1 准入 schema+安全扫描+指令注入检测 → L2 完整样例+历史
  回归 → L3 不差于旧版且至少一维严格优于）；进化工厂（失败率优先入队 +
  反思式变异 + 变异体过闸门防退化）；分层晋升（工作→项目→用户）+ 可移植
  （导出/导入）+ 来源留痕与可信度分级。
- **自适应调优**：回合指标聚合（失败率/评审分/收敛轮数/挡位调用）+ 低分
  反馈降权 + 参数快照随评估记录落库（调参不改变历史推演的可回放性）。
- **输入调配管线**：调配器升格为执行循环一等原语（`ctx.assemble` 多源
  统一调配：上下文+知识+工具+记忆+证据）；统一预算分级分配；激活模式
  留痕（源/权重/预算/版本快照随 input_assembly 事件落库）；一键开关
  回退旧路径；能全量则全量，放不下才裁剪。
- **链级 rebase（checkpoint 版本链行数有界化）**：窗口化压缩（默认
  keep=256，0 = 禁用），窗口外行删除、每叶路径窗口最旧行改写
  parent_id=None 成为归档链头；事件日志连带裁剪；新原语
  `Storage.chain_index`/`delete_checkpoints`/`set_checkpoint_parent`/
  `trim_events`（三后端）+ `plan_compaction` 纯函数规划 + `maybe_compact_chain`
  执行（改写先行、删除在后，幂等，失败 fail-open）；恢复/巡检改单次
  chain_index 取链 + 内存回溯。
- **harness 动态化**：`__spawn__` subgraph 放宽为「Graph 或可解析的图
  定义数据」；harness 声明式定义/注册表/补丁链仓库（版本回退可取旧图）；
  声明式工具创建（只声明 name/description + 参数 schema + 强制权限 +
  端点类型，执行体经 executor 钩子注册，不生成执行代码）。
- **工作流约束域**：WorkflowSpec 声明式工作流（节点/边集合）→ 图转换，
  `RunOptions.plan_workflow` 注入后 `__plan__` 须落在工作流节点集内
  （宽松域自由选序/严格序按工作流边序校验）。
- **工具执行环境**：权限门禁（PermissionGate 判定三路 allow/review/deny，
  默认拒绝，`domain:action:pattern` 权限声明，`..` 路径段拒绝）+
  文件/进程沙箱（symlink 逃逸检测/写前快照还原/白名单/超时 kill/输出
  截断/禁 shell/环境清理）+ 执行流水线（提取→门禁→沙箱→守卫→分发→
  审计→观察）+ 挂卡审批标准姿势（approve_before_execute/approve_batch，
  决议 accept/edit/reject/terminate/auto，超时/非法注入回落 reject
  fail-closed）。
- **链级安全与日志**：敏感键剥离（落库/出网/日志同规格）；结构化 JSON
  日志 + trace_id 链路追踪（幂等挂载，不抢占宿主日志）。

### 自指层与产品壳（InKling）

- **自指层观察原语（core/introspection.py）**：内省服务 + 六个 `inspect_*`
  元工具（图/规则/知识/界面/工具表/实体目录 JSON 快照），注册进工具表经
  只读流水线执行——恒定信封（graph+digest）、函数节点降级视图带 degraded
  标记、默认严重度补全、快照深拷贝、limit 钳制；快照出口统一过敏感键剥离。
- **界面数据化（core/ui_schema.py）**：布局树 schema + 组件/绑定通道/
  主题 token 三层白名单 + 绑定路径保留前缀防内部数据泄漏 + UIRenderer
  契约。
- **事件类型数据化（core/event_types.py）**：EventTypeSpec 注册表
  （schema 校验/宽松发射折叠/随补丁链持久化），system 标记注入
  RunOptions.system_events 接线。
- **补丁应用管线（core/self_proposal.py + core/self_application.py）**：
  10 类补丁类型（ui/theme/tool/rule/knowledge/harness/event_type/
  environment/artifact/entity）提案校验；分级审批（L0 auto_approve_keys
  直过 / L1 弹卡 / L2 沙箱验证 fail-closed / 7 天超时过期回滚）、补丁链
  append-only + 并发 base 校验 + 链尾单步回退存储层强制、GuardedStorage
  旁路写拦截（harness/knowledge/entities 前缀全覆盖）、审计 append-only。
- **构建与环境原语**：core/builder.py（白名单构建 + 产物内容寻址哈希 +
  冒烟门禁 cwd 限定）；core/environments.py（环境 = 数据，提供器 = 机制：
  local/web_bridge，安装/运行经沙箱白名单 + env_audit 补丁链留痕）；
  core/tool_vetting.py（清单校验/静态钩子/影子运行写虚拟化独立副本）；
  core/retrieval.py（Retriever 注册表 + 指令注入扫描 + 调配器 evidence
  源接线）。

### 外部生态与孵化闭环

- **MCP 生态接入（core/mcp_client.py）**：McpClientManager 会话生命周期
  （connect 重连清理/并发串行化/close_all 优雅回收/register_session 防覆盖），
  三传输形态 http/stdio/in_memory + HTTP headers；工具转换纯函数无 SDK
  依赖；vetting 闸门仅放行 certified（review 待确认不进入工具表）；call_tool
  识别远端 isError 与超时包装结构化失败；跨 server 工具名冲突防静默改路由；
  env/headers repr 遮蔽防凭据泄漏；MCP 端点接入声明式工具（endpoint_operation
  按 server_id 路由，定义期必填）。
- **自举种子（seeds/boot）**：自举提示词/界面基线/事件类型/自举 harness/
  元工具契约清单种子化，导入即自注册。
- **孵化闭环与演化收敛管制（宿主侧 InKling evolution + 引擎自指钩子）**：
  行为信号 → 蒸馏 → 知识沉淀（审计增量消费 + 锚点身份集合游标 + 新鲜度
  窗口 + origin=incubation 防自我强化 + 内容哈希幂等）；收敛管制
  （拒批/回退/重写近窗口冷却、连续触发升级冻结、状态持久化）；种子沉淀池
  （vetting 质量/通用性/去隐私键值双防线 fail-closed、路径穿越防护、
  原子写清单）；harvest_seed 元工具（审批挂卡后落盘）+ apply_patch 收敛
  前置闸门 + 领域生成器 related_knowledge 孵化反馈。
- **领域层定位收敛（领域深度归产品）**：移除领域种子层——领域注册
  机制（register_seed_provider/seed_domains/seed_user_set）从 core
  删除（装配配方直注 provider 已覆盖），根级 `seeds/novel/` 包与
  examples/novel_seed_demo.py 删除，seeds/ 仓库收窄为产品种子登记；
  领域规则/样例/谓词改由宿主产品自写并成对维护（样例闸门 fixture
  全绿语义不变）；跨语言实验（examples/ts_seed_pack/：数据 = 纯 JSON，
  执行件 = 手写 JSON-RPC over stdio 的 MCP server）重定位为 MCP 生态
  演示，契约语言无关。

### 可嵌入自进化运行时

- **运行时装配与生命周期（core/runtime.py）**：Host 嵌入契约五件套
  （存储工厂/模型解析/审批策略/传输工厂/关停钩子）+ AssemblyRecipe 装配
  数据（22 字段：种子/harness/事件类型/实体规格/界面基线/工具三路分发/
  vetting/分级审批表/检索源/apply 目标/收敛钩子/回退钩子/run_options 覆盖/
  压缩策略/输出验证重试上限/时间线事件开关，字段注解核心类型白名单
  架构门禁强制）+ Runtime 状态机（uninitialized→running→paused→stopped，
  非法转换显式拒绝，stop 幂等按序关停 MCP→存储→宿主钩子）+ 在途 run 登记
  （begin_run/end_run，pause 拒新不打断）+ resume_run 审批决议重入样板 +
  rebuild_engine 重建缓存（配置/工具表变更才重建）+ 从链恢复集状态 +
  apply 目标注册。
- **契约自指元工具内核化（core/self_tools.py）**：6 契约演化工具
  （propose_patch/apply_patch/revert_patch/propose_domain_manifest/
  search_tools/request_tool）下沉引擎能力，随机制层走补丁链演化、不随宿主
  壳漂移；SELF_TOOL_CONTRACT 契约清单 + SelfToolContext（convergence
  前置闸门 + 宿主审批策略透传）；宿主扩展经钩子接入（harvest_seed 等）。
- **stdio 第二宿主（examples/stdio_host.py）**：最小非 web 宿主——Runtime
  三步挂载 + stdin 回合 + 终端 y/n/e/d 决议回流；真模型冒烟跑通内省快照
  →结构化拒绝→inspect_ui→L0 主题补丁 auto 落链。
- **架构门禁扩展**：core 全目录零宿主框架字样（含字符串内出现 +
  AssemblyRecipe 注解白名单文本级检查）——机制层不认识宿主。

### 变更

- **重定位（受控自进化运行时）**：引擎定位从「自进化 agent 引擎」收敛为
  「受控自进化运行时」（Controlled Self-Evolving Runtime）——只承载
  agent 机制运行时（执行/演化/装配），产品形态（受控自进化智能体）由
  宿主产品层（InKling）承担。「受控」落点为既有全套约束：演化经分级
  审批/审计/回退、孵化过三层闸门、收敛管制、运行时骨架不可被补丁链
  修改——文档与种子身份文案同步更新。
- **端点类型注册表化（L1 关闭）**：端点类型集合从封闭枚举（StrEnum）改为
  `EndpointTypeRegistry` 声明式注册表 + 引擎默认内置 7 种（谓词注册表同
  哲学）——自定义端点经 `EndpointTypeSpec` 连带声明判定动作域/配置必填键/
  契约输出形态/提取与失败原因钩子/沙箱守卫接线，与内置端点同等走全流水线；
  `sandbox_ops` 非空而 `sandbox_builder` 缺失 = 注册即拒绝（一致性校验）；
  未注册端点 = 工具定义期拒绝 + 分发处 fail-closed。注册 = 装配期代码动作
  （非 agent 可写数据），壳侧 Rust `Endpoint::Unknown` 宽容载入透传（守卫
  语义由引擎侧注册表承担）。`endpoint_operation`/`endpoint_operation_failure_
  reason` 改为注册表分发，签名不变（向后兼容）。
- 引擎包零业务依赖（仅标准库；sqlite/postgres/llm/mcp 为可选 extra）。
- 存储 schema 与旧引擎时代不兼容（新表，旧库删表重建）。
- 包结构收敛（历史沿革）：包归属曾重划为 core / components / novel_harness，
  后收敛为 core（机制层）+ seeds（通用种子 + boot 自举），领域种子层
  整体移除——领域深度归宿主产品层，机制层零领域内容。

### 修复

- 无（尚未发布版本）。

## 破坏性变更记录（Breaking Changes）

| 版本 | 变更 | 影响 |
|---|---|---|
| 0.1.0 | 首版基线 | 无历史兼容负担 |

## 发布形态

- 引擎为独立仓库包（本仓库为 ink_engine 与 inkling 双根仓库，各自完整
  历史保留）；`pip install -e .` 本地开发，inkling 经路径依赖引擎源码。
- sdist 含 docs/ 与 examples/（MANIFEST.in）；文档集：概念/扩展点/架构/
  宿主接入/安全模型/证据仲裁/审计/历史决策等（`docs/` 共 9 篇 + 索引）。
- 质量门禁：pytest 单测（默认 2065 项，全量 2380 项）+ 性能门禁
  （checkpoint 写入 <10ms / 事件吞吐 ≥500 事件/s / 100 补丁组装 <5ms /
  rebase <10ms）+ 架构门禁（领域词零出现/宿主框架零出现/配方注解白名单/
  装配字段对照）+ ruff lint——均为本地命令，仓库未接入 CI 编排。
- license 字段已标 MIT（见 LICENSE）。
