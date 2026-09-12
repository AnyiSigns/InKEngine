# core/graph — 图定义 DSL 与编译校验（契约文档）

> 就近导航：本目录 `README.md` · 层权威：`docs/subsystems/engine.md` + `engine/AGENTS.md`

## 定位

数据即图的机制件（core/graph.py 移植）：`Graph{name, entry, nodes, edges, exits, subgraphs, node_bindings, schema}` 数据驱动建图。节点可函数直挂（`add_node`，进程内形态）或声明式绑定（`add_node_type`，按类型名引用、可序列化、随 checkpoint/harness 仓库持久化）；边分静态边/条件边（挂函数 = 进程内，按条件名 = 声明式）/loop 回边；子图以图实例挂为节点，执行时入路径栈（`graph_path` 显式记录）。结构/校验/注册归 `graph.ts`，数据形态变换与指纹归 `graph_serialize.ts`，类型与 seam 形态归 `graph_types.ts`。

## 文件与职责

| 文件 | 职责 |
| --- | --- |
| `graph.ts` | `Graph` 注册 API、`resolve_types`/`resolve_conditions` 声明式解析、`to_dict`/`from_dict`/`digest`、`compile()` 编译校验；`CompiledGraph`。 |
| `graph_types.ts` | `NodeFn`/`EdgeCondition`/`NodeContextLike` 执行 seam、`Edge`（构造即冻结，`to_dict` 强制条件边携带条件名）、`EdgeKind`、`NodeBinding`、`TerminateReason`、注册表 seam、`SchemaSerializable`、`fnv1a64Hex`。 |
| `graph_serialize.ts` | `graphToDict`（函数直挂节点/schema 不可序列化即拒）、`loadGraphFromDict`（逐字段校验重建）、`graphDigest`、稳定键序 JSON 渲染。 |

## 对外契约面

- 目录导出：`Graph`/`GraphInit`/`CompiledGraph`、`Edge`/`EdgeKind`/`EdgeCondition`、`NodeFn`/`NodeContextLike`、`NodeBinding`、`TerminateReason`（REPLY/STOP/BUDGET_EXCEEDED/ERROR/CANCELLED + `is_valid`）、`NodeTypeRegistryLike`/`EdgeConditionRegistryLike`、`SchemaSerializable`、`fnv1a64Hex`、`graphToDict`/`loadGraphFromDict`/`graphDigest`。
- 公共面（`src/index.ts`）：`export * from './core/graph/graph.js'` + `export * from './core/graph/graph_types.js'`；`graph_serialize.ts` 未直接上公共面——其功能经 `Graph` 实例方法 `to_dict`/`from_dict`/`digest` 暴露。

## 数据形态

- 图 dict：`{name, entry, nodes: {名 → {type, config, contract?}}, edges: {源 → [{target, condition?, kind?}]}, exits: 排序数组, subgraphs, schema}`；standard/conditional 不回填 kind，仅 loop 显式输出 `kind:'loop'`。
- 节点绑定：`NodeBinding{type_name, config(深拷贝), contract: NodeContract|null}`；`NodeBinding`/`Edge` 构造即 `Object.freeze`。
- 终止原因：`TerminateReason` 五常量（轨迹/审计一致语义，防魔法值）。
- 指纹：FNV-1a 64 位 hex（16 字符）；同一定义输入（拓扑/节点/条件/子图/schema）→ 同一指纹；name 排除；函数直挂节点/条件按 `<module>.<qualname>` 拼接参与，缺 `__qualname__` 退化为 `<lambda>` 占位。

## Seam 与 IO 边界

- seam：`NodeFn`/`EdgeCondition`（执行器接，图模块只持不透明引用不解释含义）；`NodeTypeRegistryLike`/`EdgeConditionRegistryLike`（建图/重放期按名解析，经参数注入，不反向依赖 registry）；`NodeContextLike`（执行器注入的节点运行时上下文：emit/interrupt/spawn/assemble/terminate 等）。
- 纯函数，无 IO 声明：哈希用纯实现 FNV-1a 规避 `node:crypto`（core 禁 `node:*`/第三方）。

## 装配与消费

- 消费方：`kernel/executor`（编译图驱动执行、`TerminateReason` 终止语义）、`kernel/runtime`、`kernel/spawn`、`kernel/simulation`、`kernel/settle`、`kernel/introspection`、`core/harness`、`core/plan`、`core/workflow`、`core/nodes`（内置节点类型建图）；`kernel/path_assembler` 与 settle 指纹钩子消费已随组装链路退役（W7-B）。
- 错误语义：图定义非法（节点名冲突、空类型名/条件名、入口缺失、静态边与条件边混用、序列化缺类型声明/条件名）→ `GraphDefinitionError`；节点/出口/边目标不存在 → `NodeNotFoundError`；子图校验失败包装为父图 `GraphDefinitionError`。
- `resolve_conditions` 按位置替换同源多条件边（不首条错替）；`compile()` 拒绝静态边与条件边混用（静态边优先会闷杀条件边）；`from_dict` 支持 `validate: true` 建图期暴露非法图。

## 不变式与门禁

- core 纯函数纪律：零框架/零 `node:*`/零宿主词/JSON 进 JSON 出；禁反向依赖 `adapters/`。
- 序列化不变式：图定义数据只含声明式形态（类型名引用 + 条件名），函数实例不入数据；函数直挂节点/条件 `to_dict` 显式拒绝（防静默丢失）。
- 指纹不变式：name 不参与（候选图名随排名生成不得产生不同指纹）；同拓扑实现替换不敏感、拓扑/条件/loop 变化必变指纹。
- 架构门禁（`vitest run --root engine` 随跑）：core 目录 import 白名单与宿主词扫描；`tsx gate/src/check.ts` 守 gated docs。

## 测试

`test/core/graph/` 镜像三件：
- `graph.test.ts` — 编译校验（线性图、入口/边/出口/边源缺失、子图冲突与嵌套暴露、混用拒绝、kind 推断、Edge 旧形态兼容）。
- `graph_serialize.test.ts` — to_dict/from_dict 往返、函数直挂拒绝、按名条件边解析与无注册表拒绝、kind 序列化（loop 往返保留/非法 kind 拒绝）。
- `graph_digest.test.ts` — 指纹 name 不参与/拓扑敏感/稳定/64 位 hex 格式、resolve_conditions 按位置解析与幂等、loop 参与指纹。

## 疑点与不一致

- 函数限定名指纹：`graph_types.ts` 头注释与 `graph_serialize.ts` `fnRef` 按 `<module>.<qualname>` 取函数名，但 `__module`/`__qualname` 是 Python 惯例属性——grep 全 src 未见任何生产者，TS 运行时函数不携带该属性，直挂函数恒走 `'<lambda>'` 占位分支（注释自述「缺 __qualname__ 退化」，属性生产者未见）。
- 冲突检查覆盖不一致：`add_node` 查 nodes+node_bindings+subgraphs 三处；`add_node_type` 只查 nodes+subgraphs——同名重复声明节点类型会静默覆盖既有 `NodeBinding`；`add_subgraph` 只查 nodes+node_bindings——同名重复注册子图会静默覆盖既有子图。
- `resolve_types` 对同名直挂函数与声明式绑定并存的情形静默跳过绑定（`if (this.nodes[name] === undefined)`），无报错，优先级规则未见显式说明。
- `graph_serialize.ts` `schemaFromData`：`if (!isRecord(data)) return data; return data;` 两分支同值，分支无区分效果；且 `loadGraphFromDict` 侧对 schema 无 `SchemaSerializable` 校验，与 `graphToDict` 侧要求 schema 必须带 `to_dict()` 不对称（同一定义的往返不保证同构）。
- `loadGraphFromDict` 的 exits 逐项未校验类型（`(exitsData ?? []) as string[]` 直接入集），非 string 项可进入 exits；同函数对 edges/kind/config/contract 均逐项校验。
- `graph_types.ts` `NodeContextLike` 在 src 内无 import 引用；执行器侧另定义 `NodeContext`（`kernel/executor`，公共面导出）——两个节点上下文类型的关系未见显式说明。
- 指纹哈希跨语言：文件头注明 Python 参考实现用 sha256、TS 用 FNV-1a 且「跨语言字节等价不保证」——两侧指纹值不可互比（注释自述，对齐手段未见）。
