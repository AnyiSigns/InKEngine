/**
 * 环境管理（environments.py 移植）：环境声明是数据，提供器是机制。
 *
 * 环境声明（EnvironmentSpec）随补丁链版本化/回退；提供器按声明提供/销毁/
 * 运行环境（本地沙箱运行 / 浏览器桥 / 容器占位）。导出面镜像 Python __all__
 * （另附类型导出供宿主编排使用）。
 */
export {
  DEFAULT_ENVS_DIR,
  ENV_STATUS_DESTROYED,
  ENV_STATUS_FAILED,
  ENV_STATUS_INSTALLING,
  ENV_STATUS_READY,
} from './constants.js';
export { LocalProvider } from './local_provider.js';
export type { LocalProviderOptions, Mkdirs, ToolLookup } from './local_provider.js';
export { ContainerProvider, EnvironmentProviders, WebBridgeProvider } from './providers.js';
export { EnvironmentHandle, EnvironmentSpec, RuntimeKind } from './spec.js';
export type { RuntimeKindValue } from './spec.js';
export type { InstallCmd, InstallCmdMap } from './install_cmd.js';
export type { EnvAuditStorage, EnvironmentProvider } from './_types.js';
