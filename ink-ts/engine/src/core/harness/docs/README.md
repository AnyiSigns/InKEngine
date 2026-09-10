# harness/（core/harness — 声明式 harness 域）

harness = 用户集内的能力包（图定义数据 + 工具清单 + 能力描述 + 可选编排
模板与状态 schema）——定义即数据，注册即插拔。唯一用户集原则：每个用户
一个专属集，任务只在集内按相关度裁剪，无跨集选择、无路由误匹配。

## 文件
- `definition.ts` — `HarnessDefinition`（frozen 纯数据：name/description/
  keywords/graph/tools/schema/default_plan/meta + to_dict/from_dict 往返）、
  集合名常量（HARNESS_COLLECTION 历史名只读兼容 / `harness:<set_id>` 按集
  隔离，与 knowledge:<user_id> 同构）、DEFAULT_ROUTE_THRESHOLD=0.5、
  CapabilityMatcher 匹配器签名。
- `builder.ts` — `build_minimal_harness`（领域生成器起点形态，构造期校验：
  非空名/字符串描述/非空关键词/工具 dict 清单/可选项 dict）、
  `_keyword_match` 默认匹配器（关键词命中率，确定性零 LLM）。
- `registry.ts` — `HarnessRegistry`（进程内运行时视图）：register（注册即
  校验：图 from_dict 可解析/工具 DeclarativeToolSpec 构造即校验/default_plan
  经 Plan.parse 且要求 graph 存在）/unregister（对称注销，声明式定义登记
  批量清理）/route（集内相关度激活，阈值过滤降序）/build_graph/build_schema/
  build_tools（登记副作用）/build_pipeline（完整工具执行流水线接线）。
- `repository.ts` — `HarnessRepository`（存储后盾）：定义 = 补丁链数据
  （首版 base、后续 append replace 补丁，版本号 = 补丁数 + 1，回退 = 组装
  到指定版本不物理删除）；写入经 DefaultEvolutionWriter（harness_writer
  三闸门）；按集隔离 + 旧集合只读回退 + 写通迁移（失败静默不阻断）；
  versions/list 全量还原。
- `index.ts` — barrel（镜像 Python `__all__`）。

## 依赖
- 上游：`core/declarative_tools`、`core/errors`、`core/graph`、`core/json`、
  `core/plan`、`core/registry`、`core/state`、`kernel/evolution_writer`、
  `kernel/llm/tools`（type）、`kernel/patch`、`kernel/permissions`（type）、
  `kernel/tool_pipeline`。
- 下游：`kernel/runtime`（装配链 4 文件）、`kernel/self_tools`（HarnessRegistry
  + build_minimal_harness）、`kernel/self_proposal`、`kernel/introspection`、
  `adapters/boot`（boot_harness_definition 构造 HarnessDefinition）；公共面
  零导出（src/index.ts 仅 `boot_harness_definition` 名含 harness 字样，真源
  adapters/boot）；`test/core/harness/`（harness/repository 两测试 + helpers）。
