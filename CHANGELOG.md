# Changelog

InkEngine 遵循 [语义化版本](https://semver.org/lang/zh-CN/)（`MAJOR.MINOR.PATCH`）：

- **MAJOR**：破坏性变更（接口/行为/存储 schema 不兼容，需要修改调用方或删库）；
- **MINOR**：向后兼容的新能力（新原语/新扩展点/新配置项，旧调用不变）；
- **PATCH**：向后兼容的缺陷修复。

> 存储 schema 不迁移：引擎表结构随版本演进，升级后启动期自检给出删库指令。


### 新增

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
  - 状态通道 + 字段级 reducer 注册表（add_messages/merge_dicts/merge_metrics/
    last_value/patch_chain）；内容型补丁链（append/replace/delete +
    assemble full/base_only/partial + rebase/truncate/branch）。
  - checkpoint 版本链：每节点快照 + parent_id 链，恢复 = 快照 + 增量日志重放；
    回合边界快照锚点。
  - 通用存储服务：memory/sqlite/postgres 三后端（连接串切换），
    checkpoint/事件/records/补丁链/审批卡五通道统一落库，敏感键写入前剥离，
    并发写保护（原子链尾校验 + 乐观锁 + postgres advisory lock）。
  - 执行事件日志（append-only）：截断 + 新分支 = 编辑重放；事件传输接口化。
  - interrupt 挂起/注入重入（弹卡审批一等能力）。
  - 执行预算原语、发散并行原语（部分失败剔除）、域窗口投影/归档摘要（D4）、
    通用状态机原语（D6 core 侧）、挡位机制（D5：挡位配置解析/按挡位建链/
    调用统计钩子）、记忆策略原语（D10：MemoryStore 协议 + 召回策略 +
    存储后端实现）、评审-收敛原语（D9 core 侧：评审器/再生成器/web 验证钩子/
    收敛策略）、**上下文调配器（D7：ContextSource 源元数据模型 +
    预算分配策略接口 + WeightedBudgetAllocator 确定性默认实现 +
    ContextAssembler 加权组装 + FusionHook LLM 融合钩子注册制 +
    ContextMixer 门面，fail-open 回退）**。
- **叙事领域包（engine-domain-novel）**
  - 叙事状态定义（伏笔 set→advancing→resolved/stalled 状态机纯函数，D6）；
  - 四类审批卡数据模型 + 门控分级注册表（D3）；
  - 候选段落级混合（D2 进阶：跨候选取段落组装 + 来源留痕）；
  - 小说评审-收敛循环（D9：逐候选段落级评审 + 再生成 + web 验证钩子注入）；
  - 世界状态层（D8：角色状态机/知识矩阵/因果链/伏笔矩阵 + 状态更新提取 +
    写时校验原语 + 涟漪扫描 + What-if 分支，补丁链统一）；
  - **上下文调配器源构建器（D7：章节摘要/角色卡/最近正文/支线素材/记忆/
    风格/读者反馈/世界状态 → ContextSource 纯函数化）**。
- **LLM 层（`ink_engine.core.llm`，可选 extra `[llm]`）**
  - AsyncLLM 统一接口 + 消息数据类；OpenAI 兼容适配器（SSE 流式解析自写，
    零第三方 SDK），DeepSeek/OpenAI/Zhipu/Moonshot/Ollama/DashScope
    compatible-mode 别名；工具 schema 自写转换；reasoning_content 透传；
    适配器注册机制；fallback 链与容错（重试/退避/备用切换/取消穿透）；
    embedding 接口（AsyncEmbedder + OpenAI 兼容适配器）。
- **开源交付**：MIT License、CHANGELOG（本文件）、概念文档
  （docs/concepts.md）、扩展点文档（docs/extensions.md）、examples/
  （novel_demo.py + context_mixer_demo.py）、CI 门禁（GitHub Actions：
  lint + 单测 + E1 性能基准）。

- **共享组件包（`ink_engine.components`，harness 组件库）**
  - D1 回合步骤（round_steps）/ D3 审批卡（review_card）/ D4 域窗口
    （domain_window）/ D9 评审收敛（review）重归类为共享组件——通用原语
    从 core 与领域包归拢到组件包，只依赖 core，可选引入、可组合可替换。
- **叙事领域包（`ink_engine.novel_harness`，随引擎发布的参考 harness）**
  - 叙事状态定义（D6）/ 世界状态层（D8）/ 候选段落级混合（D2）/
    小说评审-收敛（D9 叙事实现）/ 上下文源构建器（D7 域侧）归入叙事领域包；
  - 旧路径 `ink_engine.domain_novel` 保留为兼容别名（re-export），
    新代码使用 `ink_engine.components` / `ink_engine.novel_harness`。

### 变更

- 引擎包零业务依赖（仅标准库；sqlite/postgres/llm 为可选 extra）。
- 存储 schema 与 langgraph 时代不兼容（新表，旧库删表重建）。
- E7 harness 分层：包归属重划（core 纯机制 / components 共享组件 /
  novel_harness 叙事领域），模块 API 形状不变；import 路径迁移属破坏性
  变更，旧路径由 `domain_novel` 兼容别名层承接。

### 修复

- 无（首个可发布版本）。

## 破坏性变更记录（Breaking Changes）

| 版本 | 变更 | 影响 |
|---|---|---|
| 0.1.0 | 首版发布 | 无历史兼容负担 |

## 发布形态

- 引擎随 TextForge 仓库发布；各包目录物理独立（pyproject 多包布局），
  搬目录零重构。
- license 字段已标 MIT（见 LICENSE）。
