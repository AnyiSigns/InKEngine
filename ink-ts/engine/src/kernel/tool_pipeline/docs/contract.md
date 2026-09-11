# kernel/tool_pipeline — 统一工具执行流水线（契约文档）

> 就近导航：本目录 `README.md` · 层权威：`docs/subsystems/engine.md` + `engine/AGENTS.md`

## 定位

工具调用的机制环节规范化装配（`tool_pipeline.py` 移植）：权限门禁 → 沙箱
守卫 → 单调守卫 → 分发执行 → 审计 → 结果观察，环节全可注入、缺省
fail-closed，宿主无需重写。与 `kernel/tool_vetting` 分工：本机制管「运行中
执行」（每次调用的门禁/沙箱/审批/审计），tool_vetting 管「挂载前信任」。

## 文件与职责

| 文件 | 职责 |
| --- | --- |
| `_types.ts` | 八 seam 形态（`GateSeam`/`SandboxSeam`/`Extractor`/`FailureReasonHook`/`Guard`/`Executor`/`AuditSink`/`TraceSink`）、`ToolResult`、`DEFAULT_MAX_RESULT_CHARS`=100_000（ENG6-6 共享截断常量）、`sandbox_guarded`/`sandbox_resolve`（name 感知分发，`acceptsName` 以形参个数探测对齐 Python `inspect.signature`）、`_substitute_target`（args 中原始 target 递归替换为沙箱解析结果）——跨域契约模块 |
| `tool_pipeline.ts` | `ToolPipeline.execute` 主链：路径解析前置（gate 前经沙箱 resolve 预解析绝对路径并回写 args，字面量保留 `resolved_pre_target` 双判——ENG6-4 统一两闸基准）→ 权限门禁（`review` 委托 `approve_before_execute` 挂 gate 卡；`edit` 决议作为新 args 重提取重过门禁，限 1 轮；pose=auto 缺准入自动授予/deny 免问直拒）→ 沙箱守卫（校验结果回写执行参数）→ 单调守卫（抛异常即拒）→ 分发执行 → 审计 + 结果观察（截断 + 溢出标记 + auto 决议前缀标注）；所有返回路径经 `_finish` 收口轨迹 |
| `contract.ts` | `tool_pipeline_contract: MechanismContract`：id `'tool_pipeline'`、effects `[]`（编排语义零副作用端口）、depends `['approval', 'permissions']` |

## 对外契约面

公共面「统一工具执行流水线」组（`src/index.ts`，逐名核对 10 名）：值
`ToolPipeline` `ToolResult`；类型 `AuditSink` `Executor` `Extractor`
`FailureReasonHook` `GateSeam` `Guard` `SandboxSeam` `TraceSink`——均从
`./kernel/tool_pipeline/tool_pipeline.js` 直取（目录无 barrel）。

目录另转出而公共面未收：`ALLOW`/`DENY`/`REVIEW`（公共面经 kernel/permissions
组 `export *` 可达）、`DEFAULT_MAX_RESULT_CHARS`（公共面不可达，消费方全部
经相对路径）。机制契约 `tool_pipeline_contract` 经 `kernel/registry/
contracts.ts` 入全量注册表（34 机制）。

## 数据形态

- `ToolResult`：`ok`（是否成功执行）/`decision`/`output`（截断后文本）/
  `overflow`（超限标记，全量由宿主存 locator 取回）/`approval`（决议透传，
  edit 的 `edited_content` 供执行器）/`error`；decision 观测值域 allow/
  deny/reject/terminate/error（见疑点 1）。
- `ToolTrace`（`core/tool_orchestrator` 形态）：tool/ok/decision/args（脱敏
  后）/error/duration_ms（monotonic 差 × 1000）。
- 审批面：`DECISION_ACCEPT`='accept'/`DECISION_EDIT`/`DECISION_REJECT`/
  `DECISION_TERMINATE`/`DECISION_AUTO`（`kernel/approval`）；审批姿态
  `POSE_AUTO`/`POSE_REVIEW`/`POSE_DENY` 经 `STATE_ROUND_POSE` 回合种子读入
  （缺省 review，fail-closed）。
- `GateSeam.check(tool, operation, target, {permissions}) → GateResult`
  （decision allow/review/deny + reason）；`SandboxSeam.validate(operation,
  target, name?) → string | null`（解析后绝对路径/命令，null = 不解析）；
  `guards_operation?` 声明守卫域（未声明 = 全量判定）。

## Seam 与 IO 边界

机制契约 effects 为空——编排语义零副作用端口：gate/沙箱/单调守卫/executor/
audit/trace 全为鸭子类型注入 seam；review 委托 `approval` 机制
`approve_before_execute` 挂卡，interrupt 重入属节点 ctx 契约面；真实执行体
（进程 spawn 信封）由宿主在 executor 接线侧完成，本机制 src 不引用
SpawnSeam/ProcessSandbox/FileSandbox 等执行信封面。单调时钟 seam（等价
`time.monotonic`）缺省确定值 0（core 零 IO 可复现）；logging 留痕不移植
（core 零日志）；审计缺省经 `ctx.emit` 发 `tool_audit` 事件（成员式调用
保留 this 绑定）。

## 装配与消费

- 引擎级装配：`kernel/runtime/_runtime_boot` 构造 `new ToolPipeline({
  gate: toolGate, extractor: unifiedExtractor, failure_reason,
  executor: unifiedExecutor, approval_policy })`（introspection/self/
  declarative 三源统一分发；该装配点未注入 sandboxes/guards），挂
  `_runtime_base.tool_pipeline`；`core/execution_runtime` 持类型引用。
- 端点级装配：`core/declarative_tools/pipeline.ts` 另构造声明式端点流水线
  （`_gates.ts` 装配 `GateSeam`/`SandboxSeam`）；`core/harness/registry`
  传 `max_result_chars`。
- 节点消费：`core/nodes`（`seams.ts`/`llm_decider.ts`/`tool_pipeline.ts`）
  经 `EngineNodeSeams.tool_pipeline` 消费；`kernel/introspection` 消费
  `Executor` 形态；`kernel/sandbox/process_sandbox`、`adapters/mcp/_result`、
  `kernel/self_tools` 复用 `DEFAULT_MAX_RESULT_CHARS` 截断常量。
- 机制契约经 `kernel/registry/contracts.ts` 汇总；`runtime_contract`
  depends 含 tool_pipeline。

## 不变式与门禁

- fail-closed 缺省：未配置提取器/提取不出判定目标 = 拒绝（`allow_unchecked`
  须宿主显式让步且仅对「有意不做判定」生效）；DENY 与任何未知 gate decision
  一律拒绝；未配置执行器拒绝。
- 两闸基准统一（ENG6-4）：gate 判定对象 = 执行对象（预解析回写），字面量
  `resolved_pre_target` 双判防规则失配；沙箱异常（`SandboxViolation`）即拒。
- edit 决议重走校验链限 1 轮（宿主编辑可能改写路径/命令绕过已校验边界）；
  pose 只改写审批/准入裁定、不跳过任何机制校验（auto 缺准入自动授予仍走
  沙箱/守卫/执行器）。
- 值级脱敏：审批卡 action 负载与轨迹 args 经 `strip_sensitive`（凭据不进
  卡面/不随轨迹落库）；审计 + 轨迹 `_finish` 统一收口不遗漏；trace/审计
  失败只忽略（观测不阻断执行）。

## 测试

镜像测试 `test/kernel/tool_pipeline/tool_pipeline.test.ts`（9 组）：fail-closed
底线、权限门禁、沙箱守卫、单调守卫、结果观察、审计与轨迹、审批决议、审批卡
与轨迹值级脱敏、审批姿态（pose）在流水线的语义。

## 疑点与不一致

1. `_types.ts` `ToolResult` 注释列 decision 取值「allow/deny/accept/
   terminate/error」：当前 `execute()` 全部路径实际产生 allow/deny/reject/
   terminate/error（审批拒绝分支写 `DECISION_REJECT`='reject'；approve 后
   继续执行并落 'allow'）——'accept' 不在结果面出现，注释与代码不符
   （`approval_types.ts` DECISION_* 值核验）。
2. 公共面入口注释（`src/index.ts`「权限门禁 → 沙箱守卫 → 审批 → 分发」）
   与模块头六环节口径（含单调守卫/审计/结果观察，审批内嵌于门禁 phase）
   不一致——环节概括命名差异。
3. `DEFAULT_MAX_RESULT_CHARS` 注释自称「引擎工具流水线默认值，多源共享」，
   但公共面未收（index.ts 未从本目录导出该名），消费方（adapters/mcp、
   kernel/sandbox、self_tools、declarative_tools、harness）全部经相对路径
   ——公共面收窄口径未见显式说明。
4. 引擎级装配（`_runtime_boot`）的 `new ToolPipeline({...})` 未注入
   sandboxes/guards（沙箱守卫依赖端点级流水线各自装配）——两层装配的沙箱
   覆盖口径未见显式说明。
