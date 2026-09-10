# core/workflow — 声明式工作流编译（契约文档）

> 就近导航：本目录 `README.md` · 层权威：`docs/subsystems/engine.md` +
> `engine/AGENTS.md`

## 定位

图 DSL（core/graph）的最小单元是函数式节点、执行模型是路径行走；工作流
把节点描述为「类型名 + 配置」数据形态，语义为「全节点按依赖序各执行一次」。
扇出分支由编译器按拓扑序串行化收敛（画布平行分支顺序前后衔接，稳定序 =
边插入序），状态按通道累积、与运行期可观测行为等价。

## 文件与职责

| 文件 | 职责 |
| ---- | ---- |
| `workflow_types.ts` | WorkflowNodeSpec/WorkflowEdgeSpec/WorkflowSpec 纯数据形态（仅携带声明式数据，不含执行语义） |
| `workflow.ts` | `build_workflow_graph(spec, registry)`：入口解析（显式优先→唯一无入边推断）→ 可达性校验（入口不可达孤岛拒绝）→ Kahn 稳定拓扑序（零入度按清单序）→ 声明式绑定 + resolve_types → 链边首位串行化 → 出口 |

## 对外契约面

- `build_workflow_graph(spec, registry) → Graph`（未编译；宿主可继续追加
  节点/边——如挂接收尾节点——再经 Engine 构造触发完整编译校验）。
- 数据形态三类（供 plan/run_result 等消费）。
- **公共面零导出**（src/index.ts 逐名 grep 核对）——纯引擎内部面。
- 抛错统一 `GraphDefinitionError`（重复 id/未知类型/悬空边/回路/入口歧义/
  入口不存在/入口不可达）。

## 数据形态

- `WorkflowSpec`：name + nodes[] + edges[] + entry（可空）；entry 缺省按
  「唯一无入边节点」推断，多个无入边节点须显式指定（单入口 DSL）。
- 建图产物：`graph.add_node_type(id, type, config)` 声明式绑定（函数实例化
  经 resolve_types 统一解析），链边先于其余规格边加入（执行器沿首个静态边
  行走），末位拓扑节点为出口。

## Seam 与 IO 边界

纯函数无 IO；`registry: NodeTypeRegistryLike` 是注入的类型解析 seam
（按类型名解析工厂、配置透传实例化）。

## 装配与消费

- 消费方：`core/plan`（WorkflowNodeSpec/WorkflowEdgeSpec/WorkflowSpec——
  计划步的工作流约束域）、`core/run_result`（RunOptions.plan_workflow 类型
  引用）。
- `build_workflow_graph` 编译入口当前 src/hosts 内零消费（头注自述：机制
  就绪 / 宿主接线点待定，配方引用 WorkflowSpec 时才编译执行；当前 plan 仅
  消费 workflow_types 数据形态，编译产物未接入任何运行时装配）。

## 不变式与门禁

- 建图期拒绝全部结构错误，不等到运行时；静态边回路建图期拒绝（动态编排
  走图 DSL）。
- 扇出串行化不变式：节点执行顺序与「先决节点先执行」依赖语义不变；链边
  必须占据边列表首位（否则扇出分支抢先拐走、后续节点被跳过）。

## 疑点与不一致

1. **编译入口孤儿**：`build_workflow_graph` 全仓无消费方（仅测试）；头注
   自述「机制就绪 / 宿主接线点待定」——与 kernel/builder 同款未接线状态，
   文档如实记录。
2. **头注「状态标注」字样**：workflow.ts 头注含状态语（机制就绪/接线点
   待定），与 CODING §3 注释纪律的边界未见显式说明（同 builder 发现）。
3. **目录无 docs 之外的入口文件**：两文件无 index.ts 收敛者，消费方直接
   按文件 import（与多数 core 目录的 index 收敛形态不一致）。
4. **`_topological_order` 双重防御**：入口不可达校验（DFS）与回路校验
   （Kahn 计数）分别实现，无入边节点数为 0 时由 `_infer_entry` 先抛
   「循环依赖」——同一回路错误存在两条抛错路径（先后顺序决定文案），代码
   未说明分工。

## 测试

`test/core/workflow/workflow.test.ts`（编译校验/串行化/入口解析用例）。
