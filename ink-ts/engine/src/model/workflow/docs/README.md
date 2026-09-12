# workflow/（core/workflow — 声明式工作流编译）

声明式工作流：节点描述为「类型名 + 配置」的数据形态（`WorkflowSpec`），
`build_workflow_graph` 编译为图定义（类型解析 + 建图期校验 + 扇出串行化）。
与图 DSL 的语义差异（全节点各执行一次 vs 路径行走）由编译器在表达层收敛：
按稳定拓扑序串行化、分支以桥接边衔接。需要回路的动态编排直接用图 DSL
（静态边回路建图期拒绝）。

## 文件
- `workflow_types.ts` — `WorkflowNodeSpec`（id/type/config）/`WorkflowEdgeSpec`
  （source→target）/`WorkflowSpec`（nodes/edges/entry 可选；缺省按唯一无
  入边节点推断）。
- `workflow.ts` — `build_workflow_graph(spec, registry)`：重复 id/未知类型/
  悬空边/静态边回路/入口歧义缺失/入口不可达节点全部建图期拒绝；链边占据
  边列表首位（防扇出分支抢先拐走）；返回未编译 Graph（宿主可续挂收尾节点
  再交 Engine 完整编译）。

## 依赖
- 上游：`core/graph`（Graph/NodeTypeRegistryLike）、`core/errors`。
- 下游：`core/plan`（三形态 import）、`core/run_result`（type WorkflowSpec）；
  `build_workflow_graph` 编译入口 src/hosts 内零消费（头注自述机制就绪/
  宿主接线点待定——当前 plan 仅消费 workflow_types 数据形态）；公共面
  零导出（grep 核对）；`test/core/workflow/`。
