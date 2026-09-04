/**
 * 声明式工具执行流水线装配（declarative_tools.py build_declarative_pipeline
 * :1001-1070 移植）——轻路径的引擎侧桥接。
 *
 * extractor = 端点类型操作推导（endpoint_operation）、executor = 端点
 * 执行体分发（DeclarativeToolExecutors.dispatch）——声明式工具经此走
 * 完整流水线（门禁 → 沙箱 → 守卫 → 审批 → 审计）。
 *
 * 门禁默认 fail-closed：未注入 gate 时按 PermissionGate 默认策略（未
 * 声明权限/未命中 = 拒绝）兜底；判定一律按**定义声明的权限**
 * （_DefinitionGate 包装，调用方 spec 权限不参与）；沙箱自动接线：
 * http_fetch 经 network_policy 并入网络守卫（白名单命中 = 免审批快速
 * 路径；unlisted_policy=review 档白名单外域名转审批、deny 档硬拒），
 * 带沙箱的端点（process_exec/file_ops/自定义声明 sandbox_ops 者）由
 * _AutoDefinitionSandbox 按调用时定义现取守卫（白名单/根目录在定义期
 * 强制声明，缺声明注册即拒绝；事后注册的新定义同样立即获得守卫）。
 *
 * registry 指定端点类型注册表（缺省 = 模块级 endpoint_registry——宿主
 * 自定义端点注册进同一注册表后此处自动生效）。
 */
import { PermissionGate } from '../permissions/permissions.js';
import { NetworkPolicy, NetworkPolicySandbox } from '../permissions/networkPolicy.js';
import { DEFAULT_MAX_RESULT_CHARS } from '../tool_pipeline/_types.js';
import { ToolPipeline } from '../tool_pipeline/tool_pipeline.js';
import type {
  AuditSink,
  GateSeam,
  Guard,
  SandboxSeam,
  TraceSink,
} from '../tool_pipeline/_types.js';
import { make_declarative_extractor, make_declarative_failure_reason } from './bridge.js';
import type { DeclarativeToolExecutors } from './executors.js';
import type { EndpointTypeRegistry } from './endpoint_types.js';
import { _AutoDefinitionSandbox, _DefinitionGate, _NetworkReviewGate } from './_gates.js';

export interface BuildDeclarativePipelineOptions {
  /** 权限门禁（缺省 = PermissionGate 默认 deny 兜底，再经定义门禁包装）。 */
  gate?: GateSeam | null;
  sandboxes?: readonly SandboxSeam[];
  /** 定义级网络策略（并入沙箱环节；缺省 = 不接入网络守卫）。 */
  network_policy?: NetworkPolicy | null;
  /** 白名单外域名处置（"review" 默认 = 转审批；"deny" = fail-closed 硬拒）。 */
  network_unlisted_policy?: string;
  guards?: readonly Guard[];
  audit?: AuditSink | null;
  max_result_chars?: number;
  trace_sink?: TraceSink | null;
  registry?: EndpointTypeRegistry | null;
}

/**
 * 声明式工具执行流水线装配。
 */
export function build_declarative_pipeline(
  executors: DeclarativeToolExecutors,
  options: BuildDeclarativePipelineOptions = {},
): ToolPipeline {
  // 门禁默认 fail-closed：未注入 gate 按 PermissionGate 默认策略兜底
  let gate: GateSeam = options.gate ?? new PermissionGate();
  // 定义门禁收口：判定一律按定义声明的权限（调用方 spec 权限不参与）
  gate = new _DefinitionGate(executors, gate);
  let net_sandbox: NetworkPolicySandbox | null = null;
  let sandboxes: readonly SandboxSeam[] = options.sandboxes ?? [];
  if (options.network_policy !== null && options.network_policy !== undefined) {
    net_sandbox =
      options.network_policy instanceof NetworkPolicySandbox
        ? options.network_policy
        : new NetworkPolicySandbox(
            options.network_policy.allow_domains,
            options.network_unlisted_policy ?? 'review',
          );
    sandboxes = [...sandboxes, net_sandbox];
  }
  if (net_sandbox !== null && net_sandbox.unlisted_policy === 'review') {
    // 审批即网关：白名单外域名由门禁桥强制挂卡，审批通过后放行
    gate = new _NetworkReviewGate(gate, net_sandbox);
  }
  sandboxes = [...sandboxes, new _AutoDefinitionSandbox(executors, options.registry ?? null)];

  return new ToolPipeline({
    gate,
    extractor: make_declarative_extractor(executors),
    failure_reason: make_declarative_failure_reason(executors),
    sandboxes,
    guards: options.guards ?? [],
    executor: executors.dispatch.bind(executors),
    audit: options.audit ?? null,
    max_result_chars: options.max_result_chars ?? DEFAULT_MAX_RESULT_CHARS,
    allow_unchecked: false,
    trace_sink: options.trace_sink ?? null,
  });
}
