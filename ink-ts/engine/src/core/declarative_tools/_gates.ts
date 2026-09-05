/**
 * 声明式工具流水线的门禁包装与懒解析沙箱（declarative_tools.py
 * :885-998 移植）。
 *
 * - _DefinitionGate：定义级权限门禁——按声明式定义声明的权限判定（防
 *   宽松 spec 覆盖）。调用方传入的 spec.permissions 不参与判定；声明式
 *   工具的权限边界 = 定义声明的权限（定义期已校验非空且合法）。
 * - _NetworkReviewGate：网络域名审批桥——白名单外 connect 强制转审批
 *   （审批即网关）：NetworkPolicySandbox.unlisted_policy="review" 时，
 *   白名单外域名在门禁层强制 REVIEW（挂卡审批，accept 后放行，沙箱
 *   同态放行）；白名单命中保持内层判定（免审批快速路径）。内层判定
 *   为 DENY 不升级（审批不越过声明权限拒绝）。
 * - _AutoDefinitionSandbox：按调用时定义现取守卫的声明式沙箱——每次
 *   校验按**当前调用工具自身定义**（spec.name 反查）构造守卫，事后注册
 *   的定义立即获得硬边界（构建期快照无此能力），且守卫语义与构建期
 *   接线等价（定义即权威）。跨工具共享注册表时，工具 A 的 root 硬边界
 *   不得被工具 B 的 root 放过。无 name 的旧调用面回落端点无关的
 *   exec/FS 操作域；定义缺失 = fail-closed 拒绝（无沙箱边界的操作不
 *   得放行）。
 *
 * name 位形参说明：ToolPipeline 按运行时形参个数探测 name 感知
 * （guards_operation >1 位、validate >2 位），故两方法声明必填 name 位。
 */
import { SandboxViolation } from '../errors.js';
import { FS_OPERATIONS } from '../sandbox/index.js';
import { DENY, REVIEW, GateResult } from '../permissions/permissions.js';
import { NetworkPolicySandbox } from '../permissions/networkPolicy.js';
import { pyRepr } from '../py_repr.js';
import type { GateSeam, SandboxSeam } from '../tool_pipeline/_types.js';
import type { DeclarativeToolExecutors } from './executors.js';
import { endpoint_registry } from './endpoint_registry.js';
import type { EndpointTypeRegistry } from './endpoint_types.js';

/**
 * 定义级网络策略解析：调用工具声明自带 network_policy 时返回其策略沙箱
 * （逐工具生效——每次调用按当前定义现取，事后注册的定义同样立即生效）；
 * 工具无声明或定义缺失 = null（不施加定义级网络边界）。unlisted 处置档
 * 与流水线 build 级同一旋钮（主机级 deny 收紧时定义级同样 fail-closed）。
 */
export function _definition_network_sandbox(
  executors: DeclarativeToolExecutors,
  name: string,
  unlisted: string,
): NetworkPolicySandbox | null {
  const definition = name !== undefined && name !== null && name !== ''
    ? executors.definitions[name]
    : undefined;
  if (definition === undefined || definition.network_policy === null) {
    return null;
  }
  return new NetworkPolicySandbox(definition.network_policy.allow_domains, unlisted);
}

/** 定义级权限门禁：按声明式定义声明的权限判定（防宽松 spec 覆盖）。 */
export class _DefinitionGate implements GateSeam {
  readonly _executors: DeclarativeToolExecutors;
  readonly _inner: GateSeam;

  constructor(executors: DeclarativeToolExecutors, inner: GateSeam) {
    this._executors = executors;
    this._inner = inner;
  }

  check(
    name: string,
    operation: string,
    target: string,
    options: { permissions?: readonly string[] } = {},
  ): GateResult {
    const definition = this._executors.definitions[name];
    if (definition === undefined) {
      // 无声明式定义 = 未登记工具：显式拒绝（fail-closed）——回退到调用方
      // 权限会放开「未登记定义但已登记权限」的绕过窗口
      return new GateResult(DENY, name, operation, target, `工具 ${name} 无声明式定义（未登记），拒绝执行`);
    }
    return this._inner.check(name, operation, target, {
      permissions: definition.permissions,
    });
  }
}

/** 网络域名审批桥：白名单外 connect → 强制转审批（审批即网关）。
 *
 * 策略集按工具名解析（流水线装配注入）：宿主级网络策略（review 档）+
 * 定义级网络策略（review 档）并集——任一策略判 connect 域名需 review 即
 * 升级挂卡（AND 保守方向：两套白名单都命中才免审批）。deny 档策略的硬拒
 * 由沙箱环节承担（unlisted_policy=deny 的策略不入审批集，requires_review
 * 恒 False，见 NetworkPolicySandbox）。 */
export class _NetworkReviewGate implements GateSeam {
  readonly _inner: GateSeam;
  readonly _policies: (name: string) => readonly NetworkPolicySandbox[];

  constructor(
    inner: GateSeam,
    policies: (name: string) => readonly NetworkPolicySandbox[],
  ) {
    this._inner = inner;
    this._policies = policies;
  }

  check(
    name: string,
    operation: string,
    target: string,
    options: { permissions?: readonly string[] } = {},
  ): GateResult {
    const verdict = this._inner.check(name, operation, target, options);
    if (verdict.decision !== DENY) {
      for (const sandbox of this._policies(name)) {
        if (sandbox.requires_review(operation, target)) {
          return new GateResult(REVIEW, name, operation, target, '域名不在白名单（已转审批，审批通过后放行）');
        }
      }
    }
    return verdict;
  }
}

/**
 * 定义级网络策略沙箱：声明自带 network_policy 的工具按其定义级白名单
 * 守卫（非名单域名按 unlisted 档：review 放行交审批桥 / deny 硬拒）。
 *
 * 逐工具生效 + 懒解析：每次校验按当前调用工具自身定义现取策略，事后注册
 * 的定义立即获得守卫（与 _AutoDefinitionSandbox 同哲学）。与宿主级网络
 * 沙箱并存时 = AND（两套策略都通过才放行——安全保守方向）；工具无定义级
 * 策略时本沙箱直通（宿主级沙箱另行把关）。操作域只在 connect（http_fetch
 * 域），其余操作不属网络边界。
 */
export class _DefinitionNetworkSandbox implements SandboxSeam {
  readonly _executors: DeclarativeToolExecutors;
  readonly _host: NetworkPolicySandbox | null;
  readonly _unlisted: string;

  constructor(
    executors: DeclarativeToolExecutors,
    host: NetworkPolicySandbox | null,
    unlisted: string,
  ) {
    this._executors = executors;
    this._host = host;
    this._unlisted = unlisted;
  }

  guards_operation(operation: string, name: string): boolean {
    if (operation !== 'connect') return false;
    if (this._host !== null) return true; // 宿主级网络守卫全局生效 → 定义级并列判定（AND）
    return _definition_network_sandbox(this._executors, name, this._unlisted) !== null;
  }

  validate(operation: string, target: string, name: string): string | null {
    const policy = _definition_network_sandbox(this._executors, name, this._unlisted);
    if (policy === null) return target; // 无定义级策略：宿主级沙箱另行把关（或本无网络边界）
    return policy.validate(operation, target);
  }
}

/** 按调用时定义现取守卫的声明式沙箱（懒解析接线）。 */
export class _AutoDefinitionSandbox implements SandboxSeam {
  readonly _executors: DeclarativeToolExecutors;
  readonly _registry: EndpointTypeRegistry;

  constructor(executors: DeclarativeToolExecutors, registry: EndpointTypeRegistry | null = null) {
    this._executors = executors;
    this._registry = registry ?? endpoint_registry;
  }

  /** 守卫域由定义端点决定（ToolPipeline 透传 name 按调用工具判定）：
   *  端点声明了沙箱守卫操作才拦（process_exec → exec、file_ops → FS
   *  操作、自定义带沙箱端点）；无 name（旧调用面）回落端点无关的
   *  exec/FS 操作域。 */
  guards_operation(operation: string, name: string): boolean {
    const definition = this._executors.definitions[name];
    if (definition !== undefined) {
      const spec = this._registry.get(String(definition.endpoint));
      return spec !== undefined && spec.sandbox_ops.includes(operation);
    }
    return operation === 'exec' || (FS_OPERATIONS as readonly string[]).includes(operation);
  }

  /** 按当前调用工具自身定义构造沙箱守卫（跨工具共享注册表时，工具 A 的
   *  root 硬边界不得被工具 B 的 root 放过）。定义缺失 = fail-closed 拒绝
   *  （无沙箱边界的操作不得放行）；已注册端点按其注册表条目的
   *  sandbox_builder 构造守卫，未声明本地沙箱的端点（mcp/web_search/…）
   *  以门禁+审批为边界（validate 直通返回 target）。 */
  validate(operation: string, target: string, name: string): string | null {
    const definition = name !== undefined && name !== null && name !== ''
      ? this._executors.definitions[name]
      : undefined;
    if (definition !== undefined) {
      const spec = this._registry.get(String(definition.endpoint));
      if (spec !== undefined) {
        if (spec.sandbox_builder !== null) {
          const sandbox: SandboxSeam = spec.sandbox_builder(definition);
          const resolved = sandbox.validate(operation, target);
          return resolved !== null ? resolved : target;
        }
        return target;
      }
    }
    throw new SandboxViolation(
      `无声明式定义守卫操作 ${pyRepr(operation)}（工具 ${pyRepr(name)} 目标 ${pyRepr(target)} 无沙箱边界）`,
    );
  }
}
