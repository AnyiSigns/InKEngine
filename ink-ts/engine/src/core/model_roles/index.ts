/**
 * core/model_roles 公开收敛面（替代 core/tiers；角色模型槽机制单点）。
 */

export {
  DEFAULT_ROLE,
  MODEL_ROLES,
  ROLE_AGENT,
  ROLE_AUDIT,
  ROLE_CONFIG_ALIASES,
  ROLE_ROUTER,
  RoleModelConfig,
  RoleModelStats,
  build_role_model_chain,
  resolve_role_model,
  role_call_label,
  role_config_key,
} from './modelRoles.js';
export type { RoleCallStat, RoleModelChain } from './modelRoles.js';
