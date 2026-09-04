/**
 * 事件类型注册表最小接口（specs 注册辅助函数依赖，避免与 registry 循环）。
 */

import type { EventTypeSpec } from './eventTypeSpec.js';

export interface EventTypeRegistryLike {
  register(spec: EventTypeSpec): void;
}
