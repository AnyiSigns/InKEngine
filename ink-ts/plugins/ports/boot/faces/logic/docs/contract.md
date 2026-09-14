# adapters/boot — 自举引导种子（契约文档）

> 就近导航：本目录 `README.md` · 层权威：
> `docs/subsystems/engine.md` + `engine/AGENTS.md` · 移植源：
> Python `ink_engine/seeds/boot`

## 定位

引擎随带的引导发布物（非领域成品、非机制）：开局提供「AI 自描述 + 自举
面板 + 元工具能力」的只读基线。纯装配期数据，不含机制逻辑；宿主从本模块
取用，保持机制层零领域/产品内容。

## 文件与职责

| 文件 | 职责 |
| ---- | ---- |
| `boot.ts` | 常量与数据形态（提示词/UI 布局树/事件类型/harness/元工具清单/历史种子条目） |
| `index.ts` | 公开面（镜像 Python `__all__`） |

## 对外契约面

| 导出 | 形态 | 语义 |
| ---- | ---- | ---- |
| `BOOT_SYSTEM_PROMPT` | 值（string） | 自举系统提示词；经 `AssemblyRecipe.boot_system_prompt` 注入为 llm 类结点 system 合成只读基线（boot 恒前拼接自定义提示词） |
| `BOOT_UI_SPEC` | 值（JsonRecord） | 初始界面布局树（message_list + agent_input + 主题），渲染器按数据即时重渲 |
| `BOOT_EVENT_TYPES` | 值（EventTypeSpec[]） | 协议 v2 建卡型事件 8 种（reply_token/thinking_start/plan_start/tool_start/node_start/review_card/suggestions/error）→ 前端同名渲染组件；schema 缺省不校验 payload（注册表是增强不是收紧） |
| `boot_harness_definition()` | 函数 | 自举 harness 定义（forge：观察/提案/应用元能力集，role=self） |
| `BOOT_METATOOLS` | 值（string[]，11 项） | 自指元工具注册清单：inspect_rules/knowledge/ui/tools/entities（inspect_graph 随组装链路退役，W7-B）+ propose_patch/apply_patch/revert_patch/propose_domain_manifest + search_tools/request_tool |
| `BOOT_PROMPT_SEED_ID` | 值 | `seed.boot.system_prompt`（历史种子幂等锚点） |
| `build_boot_seed_entries()` | 函数 | 历史知识条目形态（产品宿主不再装配调用，保留供契约兼容/历史形态） |

公共面：`src/index.ts` boot 引导种子组全量导出。

## 数据形态

- 常量与 id 严格保留 Python 字面；`BOOT_SYSTEM_PROMPT` 为有意例外——按
  「工具语义入 schema、提示词只留策略」收敛，不再逐字节对齐（工具能力与
  参数经函数清单注入：`introspection/pipeline.ts`、`self_tools/_specs.ts`；
  保底常驻集合单一真源 = `kernel/runtime/_constants.ts` BASELINE_TOOL_NAMES）。
- `BOOT_METATOOLS` 是「agent 知道自己能干啥」的只读基线：观察 6 件来自
  introspection 机制层、演化 4 件来自 self_application 机制层（均为引擎
  能力，不随宿主壳漂移）；引擎单测强制 engine-resident 的 introspection
  子集 ⊆ 本清单。

## Seam 与 IO 边界

无 IO、无 seam 声明：本目录只持有数据形态并构造 core 类型实例
（EventTypeSpec/HarnessDefinition/KnowledgeEntry），机制依赖仅取 migrated
类型形态。

## 装配与消费

宿主装配期经 AssemblyRecipe 直注：boot_system_prompt → llm 结点 system
合成；BOOT_UI_SPEC/BOOT_EVENT_TYPES/boot_harness_definition → 装配期数据
直接消费；BOOT_METATOOLS → 据此登记元工具（introspection + self 两套），
漏注册即违反契约。seeds 通道退役：boot 不再作为 boot_prompt 知识条目注入。

## 不变式与门禁

- boot 数据与机制分离：本目录不引入任何机制依赖（仅 core 数据形态 import）。
- gate 适用：`adapters` 反向私有 import 检查、行数 ≤350、UTF-8。

## 测试

`test/adapters/boot/boot.test.ts`（种子形态/事件类型清单/元工具清单契约）、
`test/e2e/_e2e_fixtures.ts`、`test/e2e/runtime_e2e.test.ts`
（BOOT_SYSTEM_PROMPT 注入与 BOOT_PROMPT_SEED_ID 断言）。
