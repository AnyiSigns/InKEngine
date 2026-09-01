# InKling 产品手册

> 受控自进化智能体：你用得越多，它越懂你的领域，且每一次变化都经审批、
> 可审计、可回退。
> 本文档是产品形态的功能清单与机制导览；机制覆盖审计见
> `mechanism_coverage_matrix.md`，机制对照实验见 `mechanism_ab_report.md`，
> 桌面壳 Windows 启动冒烟见 `desktop_smoke_windows.md`。

## 产品定位

InKling 是本地单机桌面产品：**受控自进化智能体**（Controlled
Self-Evolving Agent）——跑在受控自进化运行时（`ink_engine`）之上。
数据全本地（sqlite + 本地文件）、出厂零预挂第三方服务。它不是
一个「演示形态」——它接管用户电脑上的一类重复任务（研究/开发/运维/
知识沉淀），并在使用中长出完成这些任务的专属方法与能力。
「受控」是产品的信任承诺：自进化不是无约束的——**每一次变化都经审批
（分级 L0/L1/L2）、可审计（append-only）、可回退（链尾单步）**；出网
走审批弹卡；沙箱/权限门禁全环节 fail-closed；孵化后台静默沉淀但过
三层闸门；headless 无人值守仅限可信自动化场景。

## 四根柱子

1. **深认知**：越用越懂领域——知识孵化（信号五类 → 蒸馏 → 三层闸门 → 知识集条目补丁链落位，引擎 `GrowthPipeline` 自承载）、记忆沉淀（本地 md 文件，用户可读可编辑，回合账本规则抽取零 LLM）、知识演化（失败驱动变异 → 闸门防退化 → KNOWLEDGE 补丁落链）、边证据演化（路径统计按域聚合，信任档观察/常规/转正自动晋级）。
2. **能力沉淀**：长出需要的工具——MCP 市场挂载（vetting → 观察 → 审批 →
   补丁链 → 可回退）、AI 自写组件（写 → 门禁 → 内容寻址挂载 → 渲染生效 →
   可回退）、执行件通道（出厂 Rust 六体 + 自写执行体契约测试）。
3. **方法/架构自生长**：学会怎么干——路径组装（结点池 + 边证据 + 多径汇流 +
   指纹缓存）、workflow 高信任先验、canary 试跑门禁、策略层任务分流、
   推演决策点（确定性流程兜底）。
4. **领域形态生长**：为工作域长出专属界面形态——组件管线 + ui_spec 数据
   （白名单渲染器 + 动态加载 + 组件隔离）。

## 功能清单（A-H 组）

### A 会话与记忆

| 能力 | 要点 |
|---|---|---|
| 会话侧栏 | 新建/切换/删除/重命名（重启持久）；首回合后自动生成标题（≤12 字，可改名）；消息可编辑重发/分支（checkpoint 复用 + 分支树映射；当前为会话级分支，消息级分支预留） |
| 记忆 | 本地 md 文件（目录=namespace、文件=条目、frontmatter 元数据）；标记失效而非物理删除；失效窗口默认 90 天可调 |
| 回合中止 | 暂停胶囊 → 中断 → checkpoint 可续（不丢历史） |

### B 研究与网络

| 能力 | 要点 |
|---|---|---|
| web_search | 本地聚合源免费默认；用户自配 Exa/parallel/bocha 任一 key 后降级厂商源（设置页配置，数据驱动）；出网走审批卡裁决（审批即网关），出网目标收口 outbound_domains 白名单化，结果域名过滤（越域结果丢弃） |
| fetch | 单页抓取（http_fetch 端点）；出网经审批卡裁决（已记住域名免弹卡快速路径，留空 = 每次出网都弹卡），超限截断；「先检索后取证」与 web_search 串行标准顺序 |
| 研究链 | collect_material 采集 → parse 结构化 → validate 校验 → review 评审（phase=score 确定性评分已并入）→ distill 蒸馏 → mutate 变异（Rust 执行件，样例闸门绑定） |
| 知识孵化 | 信号（pitfall/纠偏/insight/缺口/根因）→ 蒸馏 → L1 安全扫描 / L2 形态语义 / L3 目标筛查 → 知识集条目补丁链落位（`knowledge:<user>` 链 append-only 可回退，后台静默沉淀零审批）；演化/技能导入走集补丁链（KNOWLEDGE 补丁审批+审计） |

### C 文件与开发循环

| 能力 | 要点 |
|---|---|
| 文件工具 | file_read/write/edit（工作区沙箱 + 授权卡，写前快照可回滚，越界/符号链接逃逸拒绝）；grep 内容检索 / glob 路径检索 |
| AI 自写组件 | 写 TSX 源码 → typecheck+vitest 门禁 verdict → Artifact 挂载（L2 内容寻址含测试报告）→ 渲染器动态加载生效 → 链尾回退撤销；全流程消息流内联可见 |
| 执行件 | cargo 构建 + 白名单 + 内容寻址产物；冒烟门禁（通过才可 promote）；契约测试 + 样例绑定（谓词↔样例成对维护） |

### D 图与架构

| 能力 | 要点 |
|---|---|
| agent_graph 架构视图 | DAG 读/点展示/视觉 diff 高亮/专家编辑（改图走补丁链 + 分层信任：结构编辑 L2 ↔ 参数编辑低风险级） |
| canary 试跑 | 改图先试一个 stub 回合（重建 + 单回合收尾），通过才落链；失败留痕不击穿 |
| 路径组装 | schema 反推（纯算法）+ LLM 草稿（语义方向）+ 边证据评分 + 多径汇流裁决 + 指纹缓存（先例命中直接复用，三失效信号：执行失败强失效/证据漂移/抽样重装） |
| workflow 先验 | 高信任 workflow 直接引用；组装候选取代走策略层审批 |

### E 能力扩展（三通道）

| 通道 | 要点 |
|---|---|
| MCP 市场 | 出厂零预挂（mcp_market.json 目录）；一键挂载走 vetting → 观察 → L2 审批转正 → 补丁链；stdio/http/in_memory 三传输；卸载回退（链尾冲突预检） |
| 组件通道 | 形态进渲染层：白名单渲染器 + ui_spec 三层白名单校验 + ErrorBoundary 组件隔离（渲染崩溃不拖垮会话） |
| 执行件通道 | 出厂六体（collect/parse/validate/review/distill/mutate，评分并入 review phase=score）+ OS 控制 10 件（launch_app/open_file/set_volume/set_brightness/notify/sleep/ui_click/ui_type/window_focus/window_minimize）+ 设备感知（ui_query：元素树/窗口清单/屏幕参数；file_query：设备文件检索）+ 文档解析/生成/截图/资料导入/系统查询（doc_parse/doc_generate/screenshot_capture/material_import/system_query）+ 混合 shell（shell_exec，白名单外命令升级审批）+ 待办（task_manager）+ 协作（collab_request）+ 自写执行体（P1 契约测试）——全部执行器声明以 `seed_data/tools.json`（35 工具）为真源 |

### F 生长治理

| 能力 | 要点 |
|---|---|
| 推演档位 | 关 / 轻探测（默认，教学 1-2 步探测）/ 全量；回合配额硬上限 |
| spawn 并行 | 默认开 + 护栏（嵌套深度上限、分支步数截止，fail-closed） |
| 推理强度档 | 按模型档案（reasoning_profile）声明；无参数模型隐藏控制器 |
| 多 workflow 分流 | 研究/开发/运维按域分流；确定性兜底单链 |
| 路径演化 | 边证据信任档自动晋级；多径触发（探索模式）自动开 |
| 收敛管制 | 同目标冷却（review.json max_rounds 数据驱动），防重复提案 |
| 知识演化 | 失败驱动反思式变异（失败日志/调用率入队）→ 三层闸门防退化（变异体不差于母体）→ KNOWLEDGE 补丁落集补丁链（审批→审计→可回退）；壳侧回合收尾低频触发（每 10 回合一批），宿主 `IncubationDomain` 只承载演化面 |
| 自学习闭环（孵化） | 回合事件 → 信号（踩坑/用户修正/洞见/缺口/重复根因）→ 按需蒸馏（复杂度/干预双阈值）→ 三层闸门 → 知识集条目补丁链落位；出厂默认开、引擎 `GrowthPipeline` 自承载，宿主零介入；设置页「知识集」节只读诊断（孵化中信号/知识集规模/闸门通过率），无用户可操作项；孵化沉淀零审批但过三层闸门，演化/技能导入走 KNOWLEDGE 补丁审批+审计 |

### G 安全与信任

| 能力 | 要点 |
|---|---|
| 权限三档 | 自动放行 / 待审批 / 已拒绝（设置页可调，按工具声明降级链） |
| 审批分级 | L0 直过 / L1 弹卡 / L2 vetting 前置；超时 fail-closed；决议重入（恢复/过期拒绝/去重） |
| 审计 | append-only（补丁/审批/回退/组装/汇流全留痕；on_reverted 通知钩子） |
| 沙箱三件 | 文件（越界/符号链接拒绝 + 写前快照）/ 进程（白名单枚举 + 超时 kill；混合 shell 白名单外命令升级审批）/ 网络（审批即网关——unlisted_policy：review=转审批放行 / deny=硬拒；http_fetch 出厂留空 allow_domains = 每次出网都弹卡，已记住域名免弹卡） |
| 权限矩阵 | 工具 tab 每工具 allow/review/deny 三档（设置页可调，按工具声明降级链）+ 自动审批开关 + max_tool_rounds；`_escalated` 升级审批（审批台账为唯一防线） |
| 环境机制 | 环境声明 = 数据（随补丁链版本化），提供器 = 机制（local/web_bridge/container 自动装配）；用户不单独管理，环境类变更经对话审批卡；ContainerUnavailable 结构化降级 |
| headless 边界 | **headless 无人值守模式不设人工审批，仅限可信自动化场景**——`--approve` 由调用方显式声明即放行 review 档，桌面壳的审批闸门在无人值守形态下不参与；外部自动化调用链须自证可信（风控自担）。运行期约束：`inkling-headless` 依赖嵌入式 Python（pyo3 auto-initialize），即使 `--os-op` 路径不经 Python 回合也需 `pythonXY.dll` 可加载——调用前须把对应 CPython 安装目录加入 `PATH`，否则启动直接退出码 `0xC0000135`（DLL 未找到，无可读诊断）；构建期 `PYO3_PYTHON` 见 `inkling/cli/.cargo/config.toml`（相对 cwd 两层） |

### H 运维与恢复

| 能力 | 要点 |
|---|---|
| 导出/备份 | 一键导出（数据目录打包：sqlite + md + 补丁链快照，纯数据形态不含执行件）→ 恢复向导（选包 → 校验 → 重建，恢复前自动快照）；非法导出显式拒绝（穿越/篡改/陌生文件） |
| 崩溃回退栈 | 五层：渲染隔离（组件 ErrorBoundary）→ 安全模式（连续失败 3 次自动转入，不触碰链）→ 链引导回退（逐尾自动回退至可启动，走既有 revert + 审计）→ 存储快照（版本化 N=5 轮换，一键回上一稳定版本）→ 一键回落（出厂重置，链记录损坏豁免机制） |
| 管理台 | 管理台不再独立成窗——原「应用/环境/生长管线状态与回滚」并入设置页「记忆/洞察/备份」等节；组件/工具/市场各节含注册来源（出厂基线不可卸载可停用 / 挂载新增可卸载 / AI 自写可卸载附测试报告/版本） |
| 设置页（注册表驱动） | 通用 / 模型 / 连接 / 知识集 / 架构 / 记忆 / 洞察 / 备份 / 市场 / 组件 / 工具 / 工作区授权 / 界面编辑器 十三节，全部节对所有用户开放（无开发者模式门控）；权限矩阵归「工具」节，备份/崩溃回退归「备份」节，出网一律走审批弹卡（已记住域名白名单机制废弃） |

## 视图架构

- **架构视图**（agent_graph）：读/查/视觉 diff/专家编辑，改图经补丁链 + canary。
- **主区页签**：对话 / 演化 / 账本 / 轨迹 / 待办；左栏工作区/设置入口，右栏会话列表与分支树；演化页含协作者目录（`entities.snapshot`，与 inspect_entities 工具同源，只读展示可召唤的协作者）。
- **设置页**：注册表驱动浮层，十三节（通用/模型/连接/知识集/架构/记忆/洞察/备份/市场/组件/工具/工作区授权/界面编辑器）。

## 模型与数据去向（透明）

- **模型 = 用户自配**：八厂商模板（OpenAI/DeepSeek/智谱/Moonshot/Ollama/
  DashScope/Anthropic/Gemini）+ 自定义协议提供方（openai_compatible /
  openai_responses / anthropic_messages / gemini）；对话输入框直接从已配置
  厂商选模型（无默认、无档位——选什么跑什么）；router/audit 内部通道在
  模型节可编辑（留空回落主模型）；推理档/推演档按模型档案声明；弱模型
  自动降档（策略层只出计划，确定性流程兜底，不静默替用户决策）。
- **数据全本地**：唯一集 = sqlite 单份（经引擎存储契约）；记忆 = 本地 md（用户可读可编辑）；向量索引 = 派生数据（可由本体重建，随包导出）。
- **出厂内嵌**：granite-97m 本地向量模型（懒加载，首次检索才载入；`INK_EMBEDDING_*` 环境变量可覆盖远端端点）；web_search 本地聚合源免费默认。

## 导出/备份生死线

补丁链回退救不了磁盘故障：**定期一键导出是唯一保险**（一等公民功能，
设置页「备份」节 + 工具/组件各节双入口）。恢复前自动快照当前状态，
恢复可预览覆盖清单。

## 出厂自检（七门禁一键）

出厂门禁以 `inkling/manifest.json` 的 `self_check` 为命令单一事实源，
由 Rust 自检编排（`inkling/self_check/`，零第三方依赖）统一执行：

```
cargo run --release --manifest-path inkling/self_check/Cargo.toml -- all
```

七门禁：**schema** 数据一致性（22 文件 schema + 跨文件一致性 +
manifest/boot_prompt 定稿 + 引擎源码事实核对 + 校验器自检夹具）/
**cargo_test** 三 crate（exec + shell + self_check）/**frontend**
typecheck + vitest/**e2e** 接线（壳 crate 全量，pyo3 内嵌引擎 stub 回合；
`--live` 追加推理清洁度实弹探针，需 LLM key，发布前手动跑一次）/
**discipline** 代码纪律（零计划痕迹）/ **benchmark** 公开评测基准（引擎
基准 + 自举回归硬门禁）/ **symbols** 符号引用计数（孤儿扫描）。任一
失败非零退出并给修复指引。

## 自扩展示范：桌宠

桌宠 = **组件管线 + MCP 市场挂载**的完整案例（非出厂物，演示能力扩展闭环）：

1. **AI 自写桌宠组件**：TSX 源码 + vitest 测试 + view_forms 声明
   （mini/overlay 形态）→ typecheck+vitest 门禁 verdict → Artifact 补丁
   挂载（L2 内容寻址，含测试报告）→ 渲染器动态加载（overlay 壳窗口）→
   可回退。
2. **感知 MCP 组合**：设备感知 server 挂载（ui_query/file_query，
   in_memory 嵌入式或 stdio 真执行件）→ vetting/L2/审批 → 补丁链 → 工具
   注册表出现 → 桌宠引用感知数据。
3. **全流程可见可审计**：写 → 门禁 → 挂载 → 生效 → 回退，消息流内联 +
   管理台条目（来源 = AI 自写，附测试报告/版本/补丁链审计）。

教学资产（内容中性示例领域演示完整链路，规划待建）计划落
`ink_engine/examples/domain_template/`；建成前机制演示以
`ink_engine/examples/e2e` 与出厂自检门禁为准。
