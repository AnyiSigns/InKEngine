/**
 * 浏览器桥/容器形态提供器 + 环境提供器注册表（environments.py 移植）。
 *
 * web_bridge：浏览器端形态（iframe 桥，无需后端环境）——ensure 恒就绪，run
 * 显式不支持（浏览器端执行体由前端桥承载，不经后端子进程）。
 * container：服务化演进后置的占位——桌面无容器运行时不阻塞（local 为默认
 * 形态），占位 ensure/destroy/run 显式说明未落地，不静默假装可用。
 * EnvironmentProviders：提供器注册表（插拔：新运行时 = 注册新提供器）；缺省
 * 装配 local/web_bridge/container，宿主可覆盖注册（同名覆盖 = 配置驱动）；
 * 取用未注册提供器显式报错（fail-closed，不静默回落）。
 *
 * 状态标注（机制就绪 / 宿主接线点待定）：EnvironmentProviders 为宿主装配
 * 按需接线能力——引擎侧当前无装配消费方；运行/安装须宿主提供 fs/进程
 * seam（LocalProvider 的 which/mkdirs/ProcessSandbox.spawner），缺省注册表
 * 提供 local/web_bridge/container 三形态但未接线。
 */
import { GraphDefinitionError } from '../errors.js';

import {
  DEFAULT_ENVS_DIR,
  ENV_STATUS_DESTROYED,
  ENV_STATUS_READY,
} from './constants.js';
import { LocalProvider } from './local_provider.js';
import { EnvironmentHandle, EnvironmentSpec, RuntimeKind } from './spec.js';
import type { EnvironmentProvider } from './_types.js';

/** 浏览器端形态提供器（iframe 桥，无安装/运行概念；run 显式拒绝）。 */
export class WebBridgeProvider implements EnvironmentProvider {
  readonly name = 'web_bridge';

  async ensure(spec: EnvironmentSpec): Promise<EnvironmentHandle> {
    if (spec.runtime !== RuntimeKind.WEB_BRIDGE) {
      throw new GraphDefinitionError(
        `浏览器桥提供器不承接 ${spec.runtime} 环境: ${spec.name}`,
      );
    }
    return new EnvironmentHandle({ env_id: spec.name, spec });
  }

  async destroy(handle: EnvironmentHandle): Promise<void> {
    handle.status = ENV_STATUS_DESTROYED;
  }

  async run(
    handle: EnvironmentHandle,
    _command: string,
    _args: readonly string[] = [],
  ): Promise<never> {
    throw new GraphDefinitionError(
      `浏览器桥环境不支持后端子进程运行: ${handle.spec.name}`,
    );
  }
}

/** 容器形态提供器（服务化演进后置的占位：显式说明未落地，不静默假装可用）。 */
export class ContainerProvider implements EnvironmentProvider {
  readonly name = 'container';

  async ensure(spec: EnvironmentSpec): Promise<never> {
    throw new GraphDefinitionError(
      `容器提供器为服务化演进后置形态，当前未落地: ${spec.name}`,
    );
  }

  async destroy(_handle: EnvironmentHandle): Promise<never> {
    throw new GraphDefinitionError('容器提供器未落地');
  }

  async run(
    _handle: EnvironmentHandle,
    _command: string,
    _args: readonly string[] = [],
  ): Promise<never> {
    throw new GraphDefinitionError('容器提供器未落地');
  }
}

/** 缺省装配：local（默认）/web_bridge/container 三形态工厂。 */
const DEFAULT_FACTORIES = [LocalProvider, WebBridgeProvider, ContainerProvider] as const;

/** 环境提供器注册表（插拔 U 盘：新运行时 = 注册新提供器）。 */
export class EnvironmentProviders {
  private readonly _providers: Map<string, EnvironmentProvider> = new Map();

  constructor(init: { envs_dir?: string } = {}) {
    const envs_dir = init.envs_dir ?? DEFAULT_ENVS_DIR;
    for (const factory of DEFAULT_FACTORIES) {
      const provider =
        factory === LocalProvider
          ? new factory(undefined, { envs_dir })
          : new factory();
      this._providers.set(provider.name, provider);
    }
  }

  /** 覆盖注册（同名覆盖 = 配置驱动）。 */
  register(provider: EnvironmentProvider): void {
    this._providers.set(provider.name, provider);
  }

  /** 取用提供器；未注册显式报错（fail-closed，不静默回落）。 */
  get(name: string): EnvironmentProvider {
    const provider = this._providers.get(name);
    if (provider === undefined) {
      throw new GraphDefinitionError(`环境提供器未注册: ${name}`);
    }
    return provider;
  }

  /** 已注册提供器名清单。 */
  names(): string[] {
    return [...this._providers.keys()];
  }
}
