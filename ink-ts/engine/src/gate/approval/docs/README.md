# approval（gate/approval）

工具调用前挂卡审批的标准辅助（审批唯一性原则的「唯一标准姿势」）：单动作
`approve_before_execute` / 合并卡 `approve_batch` / `DefaultInterruptPolicy`
——挂起/重入走引擎 interrupt 原语（ctx seam），不引入第二套挂起语义。

## 文件
- `approval_types.ts` — 决议常量（`DECISION_ACCEPT`/`EDIT`/`REJECT`/`TERMINATE`/`AUTO` + `VALID_DECISIONS`）、审批姿态 `POSE_AUTO`/`POSE_REVIEW`/`POSE_DENY`（`normalizeApprovalPose` 非法回落 review）、`ApprovalDecision`、`InterruptPolicy`/`ApprovalInterruptContext` seam 形态。
- `approval.ts` — `approve_before_execute`（gate 卡挂起 → 注入决议解析）/`approve_batch`（同回合多写操作聚合一张卡，决议作用于整批）/`DefaultInterruptPolicy`（全量挂起 + 可选直过名单 + 可选统一超时）/`resolve_decision`（超时/非法注入一律回落 reject）/`ApprovalOptions`（clock/pose 注入）。
- `contract.ts` — 机制契约：id `approval`、effects 空（interrupt 经 ctx 成员消费非端口面）、depends 空。

## 依赖
- 上游（本目录实际 import）：`model/json`（`isRecord`）、`model/product_ui`（`build_gate_card` + `CardPayload`）、`dock/registry/contract_types`。
- 下游（实际 import 本目录）：`src/index.ts` 公共面（「审批卡辅助」组 `export *`）；`loop/tools/tool_pipeline`（review 委托挂卡 + pose 透传）、`evolve/legacy/self_application`（apply/revert/policy/patch_outcome）、`evolve/proposal/self_edit_tools`（ctx 类型）、`loop/runtime`（`_runtime_mechanisms`/`_types`/`_runtime_boot`）、`evolve/proposal`（`approve_before_execute`）；`dock/registry/contracts`；hosts/lib `host.ts`（自定义 policy 扩展 `DefaultInterruptPolicy`）与测试图（`approve_before_execute`）经公共面；测试 `test/gate/approval`（单动作 + 合并卡两文件）。
