/**
 * 网络守卫沙箱接线：NetworkPolicy（白名单判定）与 NetworkPolicySandbox
 * （http_fetch 操作域判定 + unlisted_policy 白名单外处置）。从权限主文件
 * 拆分以保持单文件行数纪律。
 */

import { network_matches } from './permissions.js';

export class NetworkPolicy {
  readonly allow_domains: readonly string[];

  constructor(allow_domains: readonly string[] = []) {
    this.allow_domains = allow_domains;
  }

  /** 域名是否放行（白名单后缀匹配，未命中 = 禁网）。 */
  allows(host: string): boolean {
    return this.allow_domains.some((p) => network_matches(p, host));
  }
}

/**
 * 网络守卫的沙箱接线形态（沙箱环节消费）。
 * http_fetch 端点经此做域名判定：操作须为 connect（其余操作一律违规）；
 * 白名单域名放行（快速路径）。unlisted_policy 决定白名单外域名的处置：
 * - ``"deny"``（默认）：域名未命中白名单抛错（默认禁网，fail-closed）
 *   ——审批也不能放行（收紧面）；
 * - ``"review"``：白名单外域名不再硬拦，而是由流水线门禁桥强制转审批——
 *   审批决议 accept 后放行（审批即网关；白名单 = 免审批快速路径）。
 * 违规抛 SandboxViolation（与 Python 同源，供 ToolPipeline 沙箱环节 catch
 * 收口为拒绝结果——Fail-closed 不静默）。
 */
import { SandboxViolation } from '../errors.js';

export class NetworkPolicySandbox extends NetworkPolicy {
  readonly unlisted_policy: string;

  constructor(allow_domains: readonly string[] = [], unlisted_policy = 'deny') {
    super(allow_domains);
    this.unlisted_policy = unlisted_policy;
  }

  /** 白名单外域名是否须转审批（review 档）；deny 档恒 False。 */
  requires_review(operation: string, target: string): boolean {
    return (
      operation === 'connect' &&
      this.unlisted_policy === 'review' &&
      !this.allows(target)
    );
  }

  /** 是否本沙箱守卫的操作域（多端点流水线各司其职的依据）。 */
  guards_operation(operation: string): boolean {
    return operation === 'connect';
  }

  validate(operation: string, target: string): string | null {
    if (operation !== 'connect') {
      throw new SandboxViolation(`不支持的网络操作: ${operation}`);
    }
    if (!this.allows(target)) {
      if (this.unlisted_policy === 'review') {
        // 白名单外域名已由门禁桥强制转审批；审批通过后此处放行
        // （审批即网关，沙箱不再二次硬拦）
        return target;
      }
      throw new SandboxViolation(`域名不在白名单: ${target}`);
    }
    return target;
  }
}

