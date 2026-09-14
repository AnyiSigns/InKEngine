// gate: test-exempt - 域服务装配面（结构契约 + 运行时装载；构造链由 hosts
// assembly/createHost 测试覆盖，同 ports seam 口径）
/**
 * 宿主域服务装配面（S4 域逻辑下沉：域实现位 = plugins/domains/<id>，
 * hosts/lib 只留装配注入——域插件经既有 face/loader 装载，契约由本文件窄面
 * 互通）。
 *
 * 与 ports seam 同构但 init 形态不同：域服务工厂 `(init?) => 域服务实例`
 * 需要宿主注入 init（如 data_dir 台账目录），故装配侧显式传 init 构造。
 *
 * 缺省语义：插件源无 manifest / 域插件缺失 = 对应域 null（消费方降级，如
 * deps.workspace undefined → 命令面内存兜底）；插件声明存在但装载/契约不符
 * = fail-closed 抛错（与 face/loader 一致）。
 */

import type { WorkspaceStore } from '../bridge/_types.js';

/** 域服务装配产物（每域一项；null = 未装配/宿主降级）。 */
export interface DomainsSeam {
  /** 工作区授权台账（plugins/domains/workspace；data_dir 持久化）。 */
  workspace: WorkspaceStore | null;
}

function factoryOf(module: unknown, id: string): (init: Record<string, unknown>) => unknown {
  const factory = (module as { default?: unknown } | null | undefined)?.['default'];
  if (typeof factory !== 'function') {
    throw new Error(`域服务插件 ${id} 缺默认工厂（faces/logic 契约 = default(init) => 域服务实例）`);
  }
  return factory as (init: Record<string, unknown>) => unknown;
}

/** 域服务实例兜底（缺省 = null 入 seam；消费方以 undefined 等价降级）。 */
function instanceOrNull(factory: (init: Record<string, unknown>) => unknown, id: string, init: Record<string, unknown>): unknown {
  const instance = factory(init);
  if (typeof instance !== 'object' || instance === null) {
    throw new Error(`域服务插件 ${id} 默认工厂产出非对象（契约 = 域服务实例）`);
  }
  return instance;
}

/** 装载域服务 seam（createHost 冷启与 restore 后重装共用同一路径；faces 由
 *  caller 已装载的 host logic face 全量传入，本 seam 只取域位不重复装载）。 */
export function buildDomainsSeam(
  faces: Record<string, unknown>,
  init: { data_dir: string },
): DomainsSeam {
  const workspaceModule = faces['workspace'];
  if (workspaceModule === undefined || workspaceModule === null) {
    return { workspace: null };
  }
  const workspaceFactory = factoryOf(workspaceModule, 'workspace');
  return { workspace: instanceOrNull(workspaceFactory, 'workspace', { data_dir: init.data_dir }) as WorkspaceStore };
}