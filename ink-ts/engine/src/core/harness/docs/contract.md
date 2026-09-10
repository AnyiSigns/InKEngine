# core/harness — 声明式 harness 域（契约文档）

> 就近导航：本目录 `README.md` · 层权威：`docs/subsystems/engine.md` +
> `engine/AGENTS.md`

## 定位

定义即数据、注册即插拔的能力包域：注册表（进程内视图：按名取定义/集内
激活/图与工具重建/流水线接线）+ 仓库（存储后盾：定义 = 补丁链数据，版本
可回退、Event Sourcing 哲学）。组合调配 = 激活返回按相关度排序的候选清单，
宿主按序选取并 spawn 展开——引擎只做相关度排序，不替宿主做选择。

## 文件与职责

| 文件 | 职责 |
| ---- | ---- |
| `definition.ts` | HarnessDefinition 纯数据形态（frozen）+ 集合名常量 + harness_collection() 按集派生 + CapabilityMatcher 签名 + DEFAULT_ROUTE_THRESHOLD=0.5 |
| `builder.ts` | build_minimal_harness（领域生成器起点，构造期 GraphDefinitionError 校验）、_keyword_match（命中率 = 命中数/关键词总数，子串命中计入） |
| `registry.ts` | HarnessRegistry：register（注册即校验三件套）/unregister（幂等 + 声明式登记批量清理）/get/names/route（阈值过滤降序）/build_graph（无图返 null）/build_schema/build_tools（登记进 declarative）/build_pipeline（gate 缺省 fail-closed、network_unlisted_policy 缺省 review） |
| `repository.ts` | HarnessRepository：save（补丁链 append + 版本索引追加，经 harness_writer 三闸门）/get（最新或指定版本 partial 组装）/versions（升序索引）/list（链记录按 base 键识别，按集集合权威 + 旧集合后读不覆盖）；HarnessVersion frozen；HarnessStorage 最小契约（EvolutionStorage + list_records） |
| `index.ts` | barrel（镜像 Python `__all__`） |

## 对外契约面

- `HarnessRegistry`：宿主运行期视图主入口；`HarnessRepository`：持久化
  主入口（save/get/versions/list）。
- **公共面零导出**（src/index.ts grep 核对：仅 adapters/boot 的
  `boot_harness_definition` 名含 harness 字样）——本目录为引擎内部面，
  宿主经 AssemblyRecipe/自指流程间接消费。
- 错误面：形态校验抛 GraphDefinitionError；未注册查询抛裸 Error（注释
  自述镜像 Python KeyError）；register 空名抛裸 Error。

## 数据形态

- 集合隔离：写一律进 `harness:<set_id>`（与 knowledge:<user_id> 同构）；
  无 set_id 落历史名 `harness`（多集共享存储会串数据，仅旧数据只读兼容）。
- 版本语义：首版 = 补丁链 base；版本号 = patches.length + 1；get(version)
  = base_only / partial(0, version-1) 组装；版本索引 = `versions:<name>`
  记录（数组，created_at 缺 0 时回落注入时钟）。
- 记录键：`chain:<name>`（链）与 `versions:<name>`（索引）。

## Seam 与 IO 边界

- `HarnessStorage`（EvolutionStorage + list_records）：宿主 Storage 全量
  实现天然满足，seam 化免测试实现大接口；写入经 DefaultEvolutionWriter
  （kernel/evolution_writer，补丁链 + 实时写 + 审计三闸门）。
- 时间注入 now（缺省 0）；`matcher`（CapabilityMatcher）与 `registries`
  （GraphRegistries）、`declarative`（DeclarativeToolExecutors）均构造
  注入可替换。

## 装配与消费

- `kernel/runtime` 装配链（_types/_runtime_base/_runtime_assemble/
  _runtime_engine）：配方 → 注册表/仓库 → 图与工具重建进引擎。
- `kernel/self_tools`（提案 ops 用 build_minimal_harness 构造领域起点；
  SelfToolNodeContext 持 HarnessRegistry）、`kernel/self_proposal`
  （proposal_validator 校验提案定义）、`kernel/introspection`（sources 读
  注册表观察）。
- `adapters/boot`：boot_harness_definition() 返回本域 HarnessDefinition。

## 不变式与门禁

- 注册即校验（LLM 生成定义的入口：非法定义注册期暴露，不执行期静默
  降级）；default_plan 依赖 graph（计划节点须落在可执行图上）。
- 注销与注册对称（注销清理声明式定义登记，再注册重登记）。
- 旧数据兼容：只读回退 + 写通迁移幂等（迁移失败静默跳过，不阻断读取）。

## 疑点与不一致

1. **registry.ts 头注失准**：头注称「本文件同时承载默认匹配器
   _keyword_match」——实际 _keyword_match 定义在 builder.ts，registry.ts
   仅 import 作构造缺省（grep/读源核验）。
2. **错误面三种口径并存**：register 空名裸 Error、未注册查询裸 Error
   （自述镜像 KeyError）、其余形态校验 GraphDefinitionError——同目录无
   统一错误族策略。
3. **`_keyword_match` 私有命名上 barrel**：下划线前缀经 index.ts 显式
   导出（同 kernel/builder `_sha256_file` 先例；头注自述镜像 Python `__all__`）。
4. **`repository.list()` 无坏记录容错**：以 `'base' in record` 识别链记录，
   PatchChain.from_dict 无 try/catch——一条含 base 键的损坏/异构记录会
   击穿全量列举（相对读路径 _get_chain_record 的防御姿态不一致）。
5. **移植对账叙述保留**：repository.ts 注释含「对应 Python warning 行为
   以静默跳过表达」「ledger precedent」等跨语言对账语境（同 fanout/events
   先例）。
6. **公共面零导出**：HarnessRegistry/HarnessDefinition 等不经
   src/index.ts——宿主类型可达性经 AssemblyRecipe 数据面间接成立，
   直接 import 面未见显式说明（grep 证据：index.ts 无 core/harness 导出行）。

## 测试

`test/core/harness/`：harness.test.ts（定义/注册/路由/重建/pipeline）、
repository.test.ts（版本链/回退/集合隔离/迁移）、helpers.ts（共享桩）。
