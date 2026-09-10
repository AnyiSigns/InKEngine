# boot/（自举引导种子）

引擎随带的引导数据资产（非领域成品、非机制）：开局即提供「AI 自描述 +
自举面板 + 元工具能力」的只读基线。全部为装配期数据——宿主经
AssemblyRecipe 直注消费，不作为知识条目注入（boot_prompt 种子注入已退役，
`build_boot_seed_entries` 保留定义供契约兼容/历史形态）。移植自 Python
`ink_engine/seeds/boot`；机制依赖只取 migrated 的类型形态。

## 文件
- `boot.ts` — boot 种子本体：常量与 id 严格保留 Python 字面
  （BOOT_SYSTEM_PROMPT 例外，已按「工具语义入 schema、提示词只留策略」收敛）。
- `index.ts` — 公开面（镜像 Python `__all__`）。

## 关键导出
- `BOOT_SYSTEM_PROMPT`：自举系统提示词——只承载观察/演化/编排策略，不枚举
  工具语义（工具能力与参数经函数清单注入：`introspection/pipeline.ts`、
  `self_tools/_specs.ts`；保底常驻集合见 `runtime/_constants.ts`
  BASELINE_TOOL_NAMES 单一真源）。
- `BOOT_UI_SPEC`：初始界面布局树（message_list + agent_input），渲染器
  按数据即时重渲。
- `BOOT_EVENT_TYPES`：协议 v2 建卡型事件类型登记（reply_token/thinking_start/
  plan_start/tool_start/node_start/review_card/suggestions/error 共 8 种，
  renderer 名与前端同名组件对应；更新型事件不独立建卡不登记）。
- `boot_harness_definition()`：自举 harness 定义（forge 自举领域：
  观察/提案/应用的元能力集）。
- `BOOT_METATOOLS`：自指元工具注册清单（观察 6 件来自 introspection 机制层
  + 演化 4 件来自 self_application 机制层 + search_tools/request_tool）——
  宿主装配据此登记，漏注册即违反契约；引擎单测强制 introspection 子集
  ⊆ 本清单，防换壳宿主未同步导致 agent 失明。
- `BOOT_PROMPT_SEED_ID` / `build_boot_seed_entries()`：历史种子条目形态
  （保留不破坏契约；产品宿主不再装配调用）。

## 依赖
- 上游：`core/event_types`（EventTypeSpec）、`core/harness`（HarnessDefinition）、
  `core/json`（JsonRecord）、`core/knowledge_set`（KnowledgeEntry/SOURCE_MODEL）。
- 下游：`src/index.ts`（boot 引导种子组）；`test/adapters/boot/boot.test.ts`、
  `test/e2e/`（_e2e_fixtures、runtime_e2e）。
