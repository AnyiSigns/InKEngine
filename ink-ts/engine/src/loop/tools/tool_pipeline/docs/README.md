# tool_pipeline（kernel/tool_pipeline）

统一工具执行流水线（权限门禁 → 沙箱守卫 → 单调守卫 → 分发执行 → 审计 →
结果观察）：机制环节全可注入、缺省 fail-closed；执行体属宿主 seam，core
不实现真实工具。

## 文件
- `_types.ts` — 数据面与注入 seam：`GateSeam`/`SandboxSeam`/`Extractor`/`FailureReasonHook`/`Guard`/`Executor`/`AuditSink`/`TraceSink` 八 seam、`ToolResult`、`DEFAULT_MAX_RESULT_CHARS`（100_000）、`sandbox_guarded`/`sandbox_resolve` name 感知分发、`_substitute_target` 参数回写（跨域契约模块）。
- `tool_pipeline.ts` — `ToolPipeline.execute` 主链：路径解析前置（ENG6-4 两闸基准统一）→ 权限门禁（review 委托 `approve_before_execute` 挂卡、edit 重走校验链限 1 轮、pose 档位裁定）→ 沙箱守卫 → 单调守卫 → 分发执行 → 审计 + 截断；全部返回路径经 `_finish` 收口轨迹。
- `contract.ts` — 机制契约：id `tool_pipeline`、effects 空（编排语义零端口）、depends `['approval','permissions']`。

## 依赖
- 上游（本目录实际 import）：`core/errors`（`SandboxViolation`）、`core/json`、`core/nodes/constants`（`STATE_ROUND_POSE`）、`core/security`（`strip_sensitive`）、`core/tool_orchestrator/_types`（`ToolTrace`）、`kernel/approval`（`approve_before_execute`/`ApprovalDecision`/`DECISION_*`/`POSE_AUTO`/`normalizeApprovalPose`）、`kernel/llm/tools`（`ToolSpec`）、`kernel/permissions`（`ALLOW`/`DENY`/`REVIEW`/`GateResult`）、`kernel/registry/contract_types`。
- 下游（实际 import 本目录）：`src/index.ts` 公共面（`ToolPipeline`/`ToolResult` + 8 seam 类型）；`kernel/runtime`（`_runtime_boot` 构造引擎级流水线、`_runtime_base` 持有）、`kernel/sandbox/process_sandbox`（截断常量）、`kernel/self_tools`、`kernel/introspection`（`Executor`）、`kernel/registry/contracts`；`core/nodes`（seams/llm_decider/tool_pipeline 类型）、`core/harness`、`core/declarative_tools`（`pipeline.ts` 另构造流水线实例）、`core/execution_runtime`；`adapters/mcp`（截断常量）；测试 `test/kernel/tool_pipeline`。
