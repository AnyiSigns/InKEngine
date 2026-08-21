/**
 * 领域组件包加载器：按 manifest 清单（contracts.renderer_components）
 * 注册领域组件进渲染器注册表。
 *
 * 清单 = 种子 manifest.json 的 contracts 段（夹具见 contracts.fixture.json，
 * 集成期注入 M0 真实 manifest）；清单外的领域组件名不注册——渲染器
 * 白名单拒绝（未声明组件不渲染）。
 */

import { logger } from '@/shared/logger';
import { registerComponent } from '@/renderer/componentRegistry';
import { KnowledgeRow } from './knowledge/knowledge_row';

export interface DomainManifest {
  id?: string;
  contracts?: {
    renderer_components?: string[];
  };
}

/** 领域组件实现表（组件名 → 实现；注册前须经清单白名单校验）。 */
const DOMAIN_COMPONENTS: Record<string, () => Parameters<typeof registerComponent>[1]> = {
  knowledge_row: () => KnowledgeRow,
};

/** 已加载状态（幂等：重复调用不重复注册）。 */
let loaded = false;
const registeredSoFar: string[] = [];

/**
 * 按 manifest 加载领域组件包：清单白名单 ∩ 实现表 = 实际注册集；
 * 清单未声明或实现缺失的组件名记录并跳过（不注册 = 渲染侧拒绝）。
 */
export function loadDomainComponents(manifest: DomainManifest | null): string[] {
  if (loaded) return [...registeredSoFar];
  loaded = true;

  const whitelist = manifest?.contracts?.renderer_components ?? [];
  for (const name of whitelist) {
    const factory = DOMAIN_COMPONENTS[name];
    if (!factory) {
      logger.warn('domains', '清单声明但实现缺失，跳过注册', { component: name });
      continue;
    }
    registerComponent(name, factory());
    registeredSoFar.push(name);
  }
  if (registeredSoFar.length > 0) {
    logger.info('domains', '领域组件包已加载', { registered: registeredSoFar.join(',') });
  }
  return [...registeredSoFar];
}
