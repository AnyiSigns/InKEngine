/**
 * 绑定源上下文（stateChannel / eventChannel 共用）。
 *
 * 渲染器挂载点注入 ChannelHub（bind 订阅数据源）；缺省 = null，
 * 绑定组件显示未绑定提示（测试环境无 hub 时组件仍可渲染）。
 */

import { createContext, useContext } from 'react';

import type { ChannelHub } from '@/shared/session/channelHub';

export interface BindSource {
  hub: ChannelHub;
}

const BindSourceContext = createContext<BindSource | null>(null);

export const BindSourceProvider = BindSourceContext.Provider;

export function getBindSource(): BindSource | null {
  return useContext(BindSourceContext);
}
