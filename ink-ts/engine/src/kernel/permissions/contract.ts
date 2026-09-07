/**
 * permissions 机制件契约声明：声明式权限门禁（fail-closed 判定原语）。
 *
 * 契约面：effects 声明本机制消费的副作用端口白名单——permissions 承载
 * fnmatch 通配翻译、路径越界判定、网络域匹配与门禁分级（PermissionGate /
 * NetworkPolicy / NetworkPolicySandbox），判定全部为纯函数（fnmatch 编译
 * 缓存带界淘汰）；review 档只返回「需审批」标记，实际挂起委托宿主/门禁桥
 * 执行，本机制自身不挂起、不落存储、不触模型与执行端口。违规以 core 异常
 * （SandboxViolation）表达，属判定结果而非执行信封消费。
 *
 * depends 为空：permissions 不直接依赖任何其它机制件（网络策略与门禁主
 * 文件同目录互引，属机制内部面）。契约化归属见
 * engine/src/kernel/registry/contract_types.ts。
 */

import type { MechanismContract } from '../registry/contract_types.js';

/** permissions 机制契约：零机制间依赖，零副作用端口（纯判定原语）。 */
export const permissions_contract: MechanismContract = {
  id: 'permissions',
  contract: {
    effects: [],
  },
  depends: [],
};
