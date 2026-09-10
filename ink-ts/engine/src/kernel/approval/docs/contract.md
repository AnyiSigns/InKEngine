# kernel/approval — 挂卡审批标准辅助（契约文档）

> 就近导航：本目录 `README.md` · 层权威：`docs/subsystems/engine.md` + `engine/AGENTS.md`

## 定位

工具调用前挂卡审批的机制化封装（`approval.py` 移植）——宿主不得另写
「工具调用前挂卡」实现。gate 卡形态统一由 `core/review_card` `build_gate_card`
构造（宿主只给动作描述与 payload）；挂起/重入经 `ApprovalInterruptContext`
鸭子类型消费引擎 interrupt 原语（挂起负载随中断 checkpoint 持久化）。

## 文件与职责

| 文件 | 职责 |
| --- | --- |
| `approval_types.ts` | 五决议常量（accept=按原动作执行 / edit=替换后执行 / reject=跳过（fail-closed 默认方向）/ terminate=宿主终止 / auto=策略直过）+ `VALID_DECISION(S|_SET)`；姿态三档 `POSE_AUTO`/`POSE_REVIEW`/`POSE_DENY` + `VALID_POSES(SET)` + `isApprovalPose`/`normalizeApprovalPose`（非法/缺失 → review）；`ApprovalDecision`（decision/action/edited_content/reason/source）；`InterruptPolicy`（should_approve/timeout_for）与 `ApprovalInterruptContext`（interrupt + 可选 get_interrupt_payload）seam 形态 |
| `approval.ts` | `approve_before_execute`：policy 直过判定 → pose 档位裁定（auto 直过/deny 免问直拒，source='pose'）→ `build_gate_card` 挂卡 → 注入值解析；`approve_batch`：同回合多写操作聚合一张卡（整批一决议；edit 注入 `edited_contents` 列表对齐动作数；超时取各动作最短窗口）；`resolve_decision`（单动作/合并卡共用：超时 expired / 注入非法 invalid / 正常 inject——auto 与字符串 edit 一律拒）；`DefaultInterruptPolicy`（auto_approve_keys/auto_approve_tools 直过名单 + 统一 timeout，不配置 = 全挂起不限时）；`ApprovalOptions`（clock 缺省确定值 0 / pose） |
| `contract.ts` | `approval_contract: MechanismContract`：id `'approval'`、effects `[]`（interrupt 是节点 ctx 契约非可注入端口）、depends `[]`（review_card 属 core） |

## 对外契约面

公共面「审批卡辅助」组：`src/index.ts` `export * from
'./kernel/approval/approval.js'`——逐名核对 19 名。值（16）：`ApprovalDecision`
`DECISION_ACCEPT` `DECISION_AUTO` `DECISION_EDIT` `DECISION_REJECT`
`DECISION_TERMINATE` `POSE_AUTO` `POSE_DENY` `POSE_REVIEW` `VALID_DECISIONS`
`VALID_POSES` `isApprovalPose` `normalizeApprovalPose` `DefaultInterruptPolicy`
`approve_before_execute` `approve_batch`；类型（3）：`ApprovalOptions`
`ApprovalInterruptContext` `InterruptPolicy`。

`approval_types.ts` 直有而未随 `approval.ts` 转出：`VALID_DECISION_SET`/
`VALID_POSE_SET`（内部白名单）。机制契约 `approval_contract` 经
`kernel/registry/contracts.ts` 入全量注册表（34 机制）。

## 数据形态

- `ApprovalDecision`：decision（五决议值面）+ action（动作描述 dict）+
  edited_content（edit 决议替换内容，其余 null）+ reason + source
  （policy=策略直过 / pose=姿态裁定 / inject=注入 / expired=超时默认拒绝 /
  invalid=注入非法 fail-closed）。
- 超时：`policy.timeout_for` 给出窗口（null = 不限时，缺省）→ 挂起负载写
  `expires_at`（epoch 秒）；重入读回已挂卡负载的持久化 `expires_at` 才是
  超时判定权威时钟。
- 合并卡：单 key 一次挂起；任一动作需审批 → 整批挂起；全批 policy 直过 →
  逐条 auto(source=policy)。

## Seam 与 IO 边界

机制契约 effects 空、depends 空：挂起/重入经 `ctx.interrupt`/
`ctx.get_interrupt_payload` 鸭子类型成员消费（成员式调用保留 this 绑定），
非本注册表端口面；时钟为注入 seam（缺省确定值 0，超时判定依赖宿主注入
真实时钟）；gate 卡构造委托 `core/review_card`；零日志（core 不落留痕）。

## 装配与消费

- `kernel/tool_pipeline`：gate `review` 判定委托 `approve_before_execute`
  挂 gate 卡（action 负载经 `strip_sensitive` 脱敏、pose 经 options 传入，
  reject/terminate 收口为拒绝结果）。
- `kernel/self_application`（apply/revert 审批分级与链尾限定）、
  `core/controlled_evolution/controlled_applier`（演化 apply 审批）、
  `kernel/self_tools`（`ApprovalInterruptContext` ctx 类型）、`kernel/runtime`
  （`_runtime_mechanisms` 挂卡接线、`_types`/`_runtime_assemble` policy 形态）。
- hosts/lib：`host.ts` 以 `DefaultInterruptPolicy` 为基类扩展宿主审批策略
  （auto-approve 名单/超时配置），经公共面消费；测试图直用
  `approve_before_execute`。
- 机制契约经 `kernel/registry/contracts.ts` 汇总；`runtime_contract` depends
  含 approval。

## 不变式与门禁

- 超时默认拒绝（fail-closed）：重入时 `now > expires_at` → reject
  （source=expired），防「超时后补批」；重入卡负载缺 `expires_at` 且无法
  判定窗口 = 无法证明未超时 → fail-closed 拒绝（宁拒勿放）；仅首次挂起
  （saved=None）允许按策略写入新窗口。
- 注入值防线：`auto` 为策略直过专属、外部注入无效（字符串与 dict 形态同
  口径拒绝）；edit 需 `edited_content`（合并卡需 `edited_contents` 与动作数
  对齐）；一切非法注入回落 reject（source=invalid）。
- policy 直过（should_approve=False）不被 pose 收回（显式预授权）；auto/deny
  姿态只改写「否则挂起」的结果；pose 非法值归一 review（fail-closed 保守）。
- 合并卡混合批次：policy 已直过的动作在任何 pose 下保持直过，避免被无关
  触发动作带偏。

## 测试

镜像测试 `test/kernel/approval/`：`approval.test.ts`（5 组：单动作全决议
分支 / 超时默认拒绝 fail-closed / 非法注入 fail-closed / gate 卡形态 /
审批姿态 pose 语义）、`approval_batch.test.ts`（approve_batch 合并卡）。

## 疑点与不一致

1. `approval.ts` 自带私有 `pyRepr` 拷贝（错误消息渲染）；pyRepr/pyTruthy
   家族在 core/py_repr.ts（自认单源）与 builder/self_tools/self_proposal/
   tool_vetting/permissions 多处并存，单源迁移未落地。
2. `approval_types.ts` 头注释「graph 引擎移植后由节点 ctx 满足该形状」为
   条件式措辞——现状 executor/节点 ctx 已提供 interrupt 原语、消费方以鸭子
   类型直用，注释时态与代码现状错位（陈旧表述）。
3. `DefaultInterruptPolicy.timeout_for(key, action)` 实现忽略两个入参、恒
   返回统一 `timeout`——接口带参而缺省实现不区分动作/窗口，按工具分窗口
   须宿主自行实现该接口（事实陈述，分层口径未见显式说明）。
