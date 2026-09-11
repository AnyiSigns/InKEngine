# core/state — 状态通道 reducer 与 schema（契约文档）

> 就近导航：本目录 `README.md` · 层权威：`docs/subsystems/engine.md` + `engine/AGENTS.md`

## 定位

状态 = 通道字典；每通道可挂 reducer（按名引用），未挂 = 裸 LastValue（覆盖语义）。reducer 族对齐补丁链心智模型：累积型 `add_messages`（每条消息 = 一个补丁，append/替换/删除语义）、内容型 `patch_chain`（通道值 = PatchChain 基础 + 补丁链）、合并型 `merge_dicts`/`merge_metrics`、覆盖型 `last_value`。`StateSchema` 是节点增量 overlay 进状态的合并入口；`subgraph_overlay_delta`/`subgraph_flowback_overlay` 供嵌套子图与 spawn 共用（减少回流噪音）。常量字符串与 Python core/state.py 同源（镜像），注册表开放扩展。

## 文件与职责

| 文件 | 职责 |
| --- | --- |
| `reducers.ts` | 五个内置 reducer、`REDUCER_REGISTRY` 注册表、additive/merge 族集合与判定、`register_reducer` 扩展入口、`get_reducer` 取用。 |
| `schema.ts` | `Channel`/`ChannelSpec`、`StateSchema`（构造 fail-fast、`apply` 合并、序列化往返）、`stateEquals`、两个回流增量函数。 |

## 对外契约面

- 目录导出：`Reducer`、`add_messages`、`merge_dicts`、`merge_metrics`、`patch_chain_reducer`、`last_value`、`REDUCER_REGISTRY`、`ADDITIVE_REDUCERS`、`MERGE_REDUCERS`、`register_reducer`、`is_additive_reducer`、`is_merge_reducer`、`get_reducer`；`Channel`、`ChannelSpec`、`stateEquals`、`StateSchema`、`subgraph_overlay_delta`、`subgraph_flowback_overlay`。
- 公共面：`export * from './core/state/reducers.js'` + `export * from './core/state/schema.js'`（全量直通）。

## 数据形态

- 通道：`Channel{reducer: string|null}`；`ChannelSpec = Channel | string | null`。
- `REDUCER_REGISTRY` 键：`add_messages`/`merge_dicts`/`merge_metrics`/`patch_chain`/`last_value`；`ADDITIVE_REDUCERS = {add_messages}`（累积追加族，子图回流按条目差集）、`MERGE_REDUCERS = {merge_metrics, merge_dicts}`（父图合并恰好一次，防二次加和翻倍）。
- `StateSchema.to_dict()` → `{channels: {名 → reducer 名|null}}`；`from_dict` 未知 reducer 名 fail-fast 拒绝。
- `add_messages`：按 `id` 去重/替换、`RemoveMessage`（type === `'RemoveMessage'`）删除、无 id 按内容键去重。
- `merge_metrics`：数值相加、嵌套 dict 递归合并、其余取 overlay；`__reset__: true` 整体重置。
- `patch_chain_reducer`：overlay 为单 `Patch`/补丁数组时追加（同源回流只追加差集段）；裸 dict 作基础文本；PatchChain 整链写入先比对既有前缀。
- 回流增量：additive 通道按条目身份差集（消息按 `id`，`{kind,text}` 按内容对，其余无稳定身份）；其余通道与入口态不等才回流；spawn 回流受父结构键保护（子图未声明通道不回流、父无 additive 承接丢弃）。

## Seam 与 IO 边界

- reducer 本身是函数值 seam：`Reducer = (base, overlay) => unknown`，经 `register_reducer`（幂等覆盖，`additive: true` 声明累积追加族）开放扩展。
- 纯函数，无 IO 声明；`PatchChain`/`Patch` 来自 `kernel/patch`（core → kernel 机制依赖，仍为零 IO 纯逻辑）。

## 装配与消费

- `StateSchema.apply` 合并规则：schema 外键宽容裸覆盖；空 overlay 返回副本；按通道 reducer 归约，无 reducer 即覆盖。
- 消费方：`kernel/executor`（run_subgraph、模拟回流、spawn 回流）、`kernel/spawn`（merge 通道判定）、`core/link_validator`（additive/merge 通道判定）、`core/harness`、`core/run_result`、`kernel/recovery`、`kernel/multipath`；`kernel/path_assembler`（StateSchema 形态校验/修复）消费已随组装链路退役（W7-B）。
- 错误语义：未知 reducer 名 → `GraphDefinitionError`（构造期/取用期均 fail-fast）；patch_chain 通道基底类型与 PatchChain overlay 不兼容（会静默丢弃基底）→ `GraphDefinitionError`；additive 通道终态值非条目序列 → `GraphDefinitionError`。

## 不变式与门禁

- core 纯函数纪律：零框架/零 `node:*`/零宿主词/JSON 进 JSON 出；merge 族保证父图合并恰好一次。
- 不维护第二套语义枚举：reducer 名为开放注册表字符串，注册表本体在此（与 contracts generated 的枚举口径边界未见显式说明）。
- 架构门禁（`vitest run --root engine` 随跑）：core 目录 import 白名单与宿主词扫描。

## 测试

`test/core/state/` 镜像两件：
- `reducers.test.ts` — add_messages 追加/替换/RemoveMessage 删除/无 id 追加、merge_dicts 覆盖、merge_metrics 相加 + 递归 + 键保留、patch_chain 累积/同对象短路/差集段/隔离拷贝/裸 dict 初值。
- `schema.test.ts` — reducer 注册表按名取用与 None 裸通道、apply 合并/未知通道宽容/空 overlay 副本/add API、to_dict/from_dict 往返、未知 reducer 名构造期拒绝。

## 疑点与不一致

- `patch_chain_reducer` 分支不对称：base 为 PatchChain 且 overlay 为裸 dict 时，overlay 被静默忽略（`chain = base` 命中后无分支再命中，原链原样返回）；裸 dict 仅在 base 非链时才作为基础文本写入（reducers.test.ts「裸 dict 初值作为基础文本写入」只覆盖后者）。该静默路径无报错、语义未见显式说明。
- `patch_chain_reducer` 增量路径原地变更 base（`apply`/`apply_many` 作用于传入的 base 实例并返回同实例，reducers.test.ts「整链回流只追加差集段」断言 `result).toBe(parent)`）——「整链写入返回隔离拷贝」仅 `branch()` 分支成立；与「纯函数、JSON 进 JSON 出」表述的边界（允许原地变更通道值）未见显式说明。
- `subgraph_overlay_delta` additive 分支错误消息 `期望条目序列，收到 ${Array.isArray(value) ? 'list' : typeof value}` 中 `'list'` 分支不可达——进入该抛错的守卫条件已排除数组（`!Array.isArray(value)`），消息恒输出 typeof 形态。
- `last_value` 双表达：既注册于 `REDUCER_REGISTRY`（键 `last_value`），又是 null 裸通道的缺省语义（`get_reducer(null)` 返回 null → `apply` 覆盖）；src 内无 `last_value` 直接调用方（grep 核对），两表达并存的关系未见显式说明。
- 导出面宽于消费面：`stateEquals` 在 src 内仅本目录 `schema.ts` 内部使用；`register_reducer`/`REDUCER_REGISTRY` 在 src 与 hosts 内均无调用方（grep 核对）——扩展入口除镜像测试外无消费方。
- `add_messages` 无 id 消息：docstring 称「无 id 按内容去重」（`seenNoId` 实现存在），镜像测试 reducers.test.ts 的用例名「无 id 消息追加（不重复去重）」表述相反，且测试体仅断言不同内容两条均追加——「无 id 同内容去重」分支无测试断言。
- 「常量字符串与 Python core/state.py 同源（镜像）」为文件头自述，本任务范围内未对照 Python 侧，同源性未核实。
