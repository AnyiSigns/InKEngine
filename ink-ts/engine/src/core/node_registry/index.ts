/**
 * node_registry 公开面（声明式结点类型注册表数据）。
 *
 * 决策 4 数据面：结点类型注册 = node_registry:<set> 登记数据（boot 种子登记 +
 * 运行期持久登记 + 重启恢复）；池治理 disable/archive/建议经受控通道回写登记行。
 * 执行体（工厂闭包）不随数据持久——登记行只存绑定名，运行时装配按绑定名恢复。
 */

export {
  NODE_REGISTRY_COLLECTION_PREFIX,
  NodeRegistration,
  node_registry_collection,
} from './types.js';
export type {
  NodeRegistrationInit,
  NodeRegistrationProvenance,
  NodeRegistrationStatus,
  NodeRegistrationSuggestion,
} from './types.js';

export {
  NodeRegistryStore,
  registration_output_fields,
} from './store.js';
export type {
  NodeRegistryRecordsSource,
  NodeRegistryStoreOptions,
  NodeRegistryWrite,
} from './store.js';

export { node_registry_governance_target } from './governance_target.js';
export type { NodeRegistryGovernanceOptions } from './governance_target.js';
