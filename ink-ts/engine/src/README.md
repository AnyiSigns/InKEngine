# engine/src（七层一眼地图）

L3 引擎纯函数库源码（JSON 进 JSON 出，0-IO 口径见 CODING §7；层向纪律 =
gate layer-dag 矩阵；目录语义详情见 `docs/subsystems/engine.md`）：

- `model/`：数据面——契约生成物（contracts/generated）、schema、事件、
  图数据形态、角色槽等纯数据，零依赖首层。
- `loop/`：执行主线——runtime/round_steps/tools/execution_runtime/whiteboard
  等回合与执行运行时机制。
- `graph/`：最小图解释器——executor/nodes（池种子）/builder/registry。
- `gate/`：运行期「可不可以」——审批/审计/预算/补丁链/权限/沙箱/安全。
- `evolve/`：单一演化栈——学习/观察/调参/提案/技能，受控通道落库。
- `dock/`：对外契约面——端口词表真源 `ports.ts`、机制注册面 `registry/`、
  caps/calls/view 公共面。
- `adapters/`：IO 真实现（boot/llm/mcp/storage），DI 装载可覆盖。
- 残部：`core/`（entities/knowledge_set/state/fanout/run_result 等留守纯
  逻辑，P8 消化）与 `kernel/`（simulation/multipath/spawn 旧推演件，
  P8+S1 退役）。
