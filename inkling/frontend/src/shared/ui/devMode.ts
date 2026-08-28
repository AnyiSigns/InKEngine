/**
 * 开发者模式开关（界面内部机制可见性的单一闸门）。
 *
 * 关闭（默认）：主界面只呈现会话产品面——消息流、会话、工作区；
 *   原始事件 JSON / 结点 id / trace / 账本内部 / 机制视图入口一律隐藏。
 * 开启：设置「高级」区出现机制视图入口，事件负载等诊断信息可见。
 *
 * 持久化走 uiStateStore（key = dev.mode），重启不保留语义由存储实现决定。
 */

import { useUiState } from './uiStateStore';

export const DEV_MODE_KEY = 'dev.mode';

export function useDevMode(): [boolean, (next: boolean) => void] {
  return useUiState<boolean>(DEV_MODE_KEY, false);
}
