# Changelog

InkEngine 遵循 [语义化版本](https://semver.org/lang/zh-CN/)（`MAJOR.MINOR.PATCH`）：

- **MAJOR**：破坏性变更（接口/行为/存储 schema 不兼容，需要修改调用方或删库）；
- **MINOR**：向后兼容的新能力（新原语/新扩展点/新配置项，旧调用不变）；
- **PATCH**：向后兼容的缺陷修复。

> 存储 schema 不迁移：引擎表结构随版本演进，升级后启动期自检给出删库指令。


### 目录重构（v5 收尾）

- **共享组件包并入 core（`ink_engine.components` 目录消亡）**：round_steps/
  review_card/review 迁为 core 平级模块，domain_window 并入 core/context.py
  （域窗口投影与上下文调配原语同族）；引用路径更新为 `ink_engine.core.*`。
- **novel_harness 退役，领域种子落位 `ink_engine/seeds/novel/`**：领域代码
  全部数据化——规则集 10 条 + 样例库 14 用例 + schema 基座（知识条目/
  世界观视图口径）+ 默认编排模板（图定义数据）随种子包发布；校验入口
  `check_world_state_rules` 接受 JSON 兼容世界状态视图（不再依赖领域
  模型对象）；`domain_novel` 兼容别名层随退役路径一并移除。
- **工作流约束域接线**：`WorkflowSpec` 成为「可执行的计划空间」——
  `RunOptions.plan_workflow` 注入后，`__plan__` 节点须落在工作流节点集内
  （宽松域自由选序），严格序按工作流边序校验（计划不再只看图边约束）。


### 新增

- **自指层观察原语（`core/introspection.py`）**：内省服务 + 五个 `inspect_*`
  元工具（图/规则/知识/界面/工具表 JSON 快照），注册进工具表经只读流水线
  执行——恒定信封（graph+digest）、函数节点降级视图带 degraded 标记、
  默认严重度补全、快照深拷贝、limit 钳制；快照出口统一过敏感键剥离
  （凭据永不进入模型上下文，与落库通道同规格）。

- **运行时重规划（Planner Loop）**
  - 新保留键 `__plan__`：节点返回下一跳编排清单（节点序列/并行组/条件/
    spawn 子任务），引擎执行一段后重规划；计划 = checkpoint 快照字段
    （随版本链落盘与回滚——回溯决策点时计划与状态一起回到当时版本）；
  - 与 `__spawn__` 共存语义：计划 = 流的结构、spawn = 流的展开，可嵌套；
    计划 spawn 步同受 max_spawns 护栏约束、error_on_exception 统一配置驱动。
- **决策点推演-回溯-换选（Simulate）**
  - 新保留键 `__simulate__`：关键决策点派生分支清单，引擎把每个分支作为
    独立子链执行（与 spawn 同构：隔离状态 + 独立 checkpoint 链 + 事件
    统一父链），评估器协议（`Evaluator`）打分后调配策略（`BranchMixer`，
    默认单选最高分）择优提交主线——单选或跨分支组装，组装留痕记录
    「哪部分来自哪个分支」；
  - 落选分支不销毁：保留为轨迹树引用（`EngineEvent` 新增 `parent_step_id`
    字段，分支事件指向决策点步骤，协议增量演进不破坏）——可回溯对比/换选；
  - 分支失败/评估失败按部分失败语义剔除，全部失败按节点失败收口。
- **核声明式化（Rules as Data）**
  - 规则 DSL：不变式/校验规则/状态转换规则的声明式数据形态（谓词 =
    注册函数，规则 = 数据可版本化/回退/导出导入）+ 样例库机制
    （fixture 全绿才允许落库，非谈判项）；
  - 加权打分器（维度+权重+阈值可配置）+ Schema 声明校验器
    （SchemaSpec/SchemaValidator，字段必填/类型/枚举/范围）；
  - novel_harness 世界状态校验迁移为声明式规则集
    （`novel_harness/world_state/ruleset.py`，样例库全绿）。
- **知识集孵化（Knowledge Incubation）**
  - 知识集封装层：规则条目 = 补丁链数据（演化 = 新补丁、回退 = 旧版本、
    分支 = 平行版本），种子注入（幂等）+ 演化分层；
  - 信号感知（五类信号：踩坑/用户修正/洞见/流程缺口/重复根因）+
    蒸馏（丢弃试错分支、保留成功步骤）+ 精准补丁（replace 语义只改
    对应段落）；
  - 三层验证闸门：L1 准入（schema 校验 + 安全扫描 + 指令注入检测）→
    L2 效果评估（完整样例 + 历史回归，全绿才进下一层）→ L3 目标筛选
    （不差于旧版且至少一维严格优于才保留，多样性变体并存）；
  - 进化工厂（失败率优先入队 + 反思式变异 + 变异体过闸门防退化）；
  - 分层晋升（工作→项目→用户，namespace 迁移，id 跨层级稳定）+ 可移植
    （补丁链数据导出/导入）+ 复用检索（相似任务命中优先于重新蒸馏）+
    来源留痕与可信度分级（防 web 注入污染知识集）；
  - 知识集注入 = 调配器思想复用：知识条目 = ContextSource
    （type=层级、weight=可信度、relevance=任务相关度、ttl=时效）。
- **自适应调优（Self-tuning）**
  - 回合指标聚合纳入引擎自承载（失败率/评审分/收敛轮数/挡位调用）；
  - 调参器：低分反馈降权（下限保护）+ 失败率/收敛轮数驱动的机制参数
    调整（重试预算/web 验证阈值/探索宽度）；参数快照随评估记录落库
    （规则版本 + 权重快照——调参不改变历史推演的可回放性）。
- **输入调配管线（Input Assembly）**
  - 调配器升格为执行循环一等原语：节点经 `ctx.assemble` 统一调配
    （上下文 + 知识集 + 工具 + 记忆 + 证据多源）；
  - 统一预算分级分配（合计不超调用点总预算）、激活模式留痕
    （源/权重/预算/版本快照随 input_assembly 事件落库）、一键开关
    回退旧装配路径；能全量则全量，放不下才裁剪。
- **链级 rebase（checkpoint 版本链行数维度有界化）**
  - checkpoint 版本链每节点执行 +1 行、事件日志 append-only，行数随执行
    线性增长且与快照值大小无关——恢复回溯/巡检为 O(链长) 次逐跳查询，
    备份/迁移/并发写冲突扫描范围随链长增长。
  - 方案：链超窗口后压缩历史前缀——窗口外行删除、每叶路径窗口最旧行
    改写 parent_id=None 成为归档链头（全量快照，锚点状态无丢失；
    损失窗口外逐节点粒度），链遍历从 O(链长) 降为 O(窗口)；事件日志
    连带裁剪（<= 归档链头 event_seq 的事件对任何保留锚点不可达）。
  - 新原语：`Storage.chain_index`（轻量链行索引，单次查询）/`delete_checkpoints`/
    `set_checkpoint_parent`/`trim_events`（memory/sqlite/postgres 三后端）；
    `core/chain_rebase.py`：`plan_compaction` 纯函数规划 + `maybe_compact_chain`
    执行（改写先行、删除在后，失败不产生悬挂父指针，幂等）。
  - 接线：`RunOptions.checkpoint_keep`（默认 256，0 = 禁用）；顶层
    run/ainvoke 入口触发（编辑重放 parent_checkpoint 分叉跳过——锚点
    可能落在窗口外）；spawn 实例独立子链回合收尾同步压缩；压缩失败
    fail-open（宿主自定义存储缺原语时跳过，功能不受损）。
  - 恢复/巡检配套：`collect_resume_anchors`/`validate_chain` 改为单次
    chain_index 取链 + 内存回溯（消除逐跳串行重查询）。
- **内核（engine-core）**
  - 图定义 DSL + 执行循环：节点/静态边/条件边/嵌套子图/循环回路/回合终止
    信号（reply/止损/超限/异常四类终止原因）；节点/边注册表开放；
    执行预算钩子（BudgetPolicy 节点边界检查终止）。
  - **图即数据**：`Graph.to_dict()/from_dict()` 完整序列化（节点/边以
    注册名引用，需节点注册表 + 边注册表）；图指纹（sha256）随 checkpoint
    落库，恢复时校验（不一致抛 GraphVersionMismatchError）；图定义数据
    注册路径（校验 + 编译，注册期暴露非法定义）。
  - 状态通道 + 字段级 reducer 注册表（add_messages/merge_dicts/merge_metrics/
    last_value/patch_chain）；内容型补丁链（append/replace/delete +
    assemble full/base_only/partial + rebase/truncate/branch）。
  - checkpoint 版本链：每节点快照 + parent_id 链，恢复 = 快照 + 增量日志重放；
    回合边界快照锚点。
  - 通用存储服务：memory/sqlite/postgres 三后端（连接串切换），
    checkpoint/事件/records/补丁链/审批卡五通道统一落库，敏感键写入前剥离，
    并发写保护（原子链尾校验 + 乐观锁 + postgres advisory lock）。
  - 执行事件日志（append-only）：截断 + 新分支 = 编辑重放；事件传输接口化；
    `EngineEvent` 支持 parent_step_id（轨迹树引用，协议增量演进）。
  - interrupt 挂起/注入重入（弹卡审批一等能力）。
  - 执行预算原语、发散并行原语（部分失败剔除）、域窗口投影/归档摘要、
    通用状态机原语、挡位机制（挡位配置解析/按挡位建链/调用统计钩子）、
    记忆策略原语（MemoryStore 协议 + 召回策略 + 存储后端实现）、
    评审-收敛原语（评审器/再生成器/web 验证钩子/收敛策略）、
    **上下文调配器（ContextSource 源元数据模型 + 预算分配策略接口 +
    WeightedBudgetAllocator 确定性默认实现 + ContextAssembler 加权组装 +
    FusionHook LLM 融合钩子注册制 + ContextMixer 门面，fail-open 回退）**。
  - **harness 动态化**：`__spawn__` subgraph 放宽为「Graph 或可解析的图
    定义数据」；harness 声明式定义/注册表/补丁链仓库（版本回退可取旧图）；
    声明式工具创建（只声明 name/description + 参数 schema + 强制权限
    声明 + 端点类型，执行体经 executor 钩子注册，不生成执行代码）——
    声明式工具经 build_pipeline 走完整流水线（门禁 → 沙箱 → 守卫 →
    审批 → 审计，目标判定失败恒 fail-closed 拒绝）。
- **叙事领域包（engine-novel-harness，历史记录）**：叙事状态定义（伏笔
  set→advancing→resolved/stalled 状态机纯函数）、四类审批卡数据模型 +
  门控分级注册表、候选段落级混合（跨候选取段落组装 + 来源留痕）、小说
  评审-收敛循环（逐候选段落级评审 + 再生成 + web 验证钩子注入）、世界
  状态层（角色状态机/知识矩阵/因果链/伏笔矩阵 + 状态更新提取 + 写时
  校验原语 + 涟漪扫描 + What-if 分支，补丁链统一；校验语义 = 声明式
  规则集）、上下文调配器源构建器（章节摘要/角色卡/最近正文/支线素材/
  记忆/风格/读者反馈/世界状态 → ContextSource 纯函数化）——**v5 收尾
  已退役**（见顶部「目录重构」）：通用原语并入 core，领域校验语义数据化
  为 `seeds/novel` 规则集，候选混合/域源构建器等叙事专属能力不再随引擎
  发布。
- **LLM 层（`ink_engine.core.llm`，可选 extra `[llm]`）**
  - AsyncLLM 统一接口 + 消息数据类；OpenAI 兼容适配器（SSE 流式解析自写，
    零第三方 SDK），DeepSeek/OpenAI/Zhipu/Moonshot/Ollama/DashScope
    compatible-mode 别名；工具 schema 自写转换；reasoning_content 透传；
    适配器注册机制；fallback 链与容错（重试/退避/备用切换/取消穿透）；
    embedding 接口（AsyncEmbedder + OpenAI 兼容适配器）。
- **开源交付**：MIT License、CHANGELOG（本文件）、概念文档
  （docs/concepts.md）、扩展点文档（docs/extensions.md）、examples/
  （novel_demo.py + context_mixer_demo.py）、CI 门禁（GitHub Actions：
  lint + 单测 + 性能基准）。

- **共享组件包（`ink_engine.components`，历史记录）**：回合步骤
  （round_steps）/ 审批卡（review_card）/ 域窗口（domain_window）/ 评审
  收敛（review）曾重归类为共享组件——通用原语从 core 与领域包归拢到
  组件包，只依赖 core，可选引入、可组合可替换；**v5 收尾已消亡**：
  round_steps/review_card/review 迁为 core 平级模块，domain_window 并入
  core/context.py。
- **叙事领域包（`ink_engine.novel_harness`，历史记录）**：叙事状态定义 /
  世界状态层 / 候选段落级混合 / 小说评审-收敛（叙事实现）/ 上下文源
  构建器（域侧）曾归入叙事领域包；旧路径 `ink_engine.domain_novel` 曾
  保留为兼容别名（re-export），新代码曾使用 `ink_engine.components` /
  `ink_engine.novel_harness`——**v5 收尾已一并退役**（见顶部「目录重构」）。

### 变更

- 引擎包零业务依赖（仅标准库；sqlite/postgres/llm 为可选 extra）。
- 存储 schema 与旧引擎时代不兼容（新表，旧库删表重建）。
- harness 分层演进（历史）：包归属曾重划为 core 纯机制 / components
  共享组件 / novel_harness 叙事领域，import 路径迁移属破坏性变更，旧路径
  由 `domain_novel` 兼容别名层承接；v5 收尾再次收敛——当前仅 core
  （机制层）+ seeds（领域种子），见顶部「目录重构」。

### 修复

- 无（尚未发布版本）。

## 破坏性变更记录（Breaking Changes）

| 版本 | 变更 | 影响 |
|---|---|---|
| 0.1.0 | 首版发布 | 无历史兼容负担 |

## 发布形态

- 引擎随 TextForge 仓库发布；各包目录物理独立（pyproject 多包布局），
  搬目录零重构。
- license 字段已标 MIT（见 LICENSE）。
