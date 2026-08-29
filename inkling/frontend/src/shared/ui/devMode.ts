/**
 * 消息流诊断开关（事件负载可见性闸门）。
 *
 * 默认关闭：原始事件 JSON / 未登记事件兜底卡等诊断信息不进入消息流；
 * 持久化走 uiStateStore（key = dev.mode）。设置页已不再提供开发者模式
 * 开关，该值保留用于消息流诊断可见性的内部判定。
 */

import { useUiState } from './uiStateStore';

export const DEV_MODE_KEY = 'dev.mode';

export function useDevMode(): [boolean, (next: boolean) => void] {
  return useUiState<boolean>(DEV_MODE_KEY, false);
}
