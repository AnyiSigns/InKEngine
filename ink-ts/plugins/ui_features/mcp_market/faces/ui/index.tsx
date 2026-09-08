import { createAppBackend, type AppBackend } from '@app/backend';
import { McpMarket } from './McpMarket';

/**
 * mcp_market ui 面入口（阶段 9b 试点：声明式接入）。
 *
 * spec faces.ui.access store:["appBackend"] —— 壳装配层（hosts/web settings_floater
 * 经 sliceUiAccess 按声明切片）注入共享 AppBackend 单例；不再模块级自建
 * createAppBackend()（推翻阶段 7b 定案 B 的自建单例，随 9b 统一宿主注入）。
 * 缺注入路径（壳外直接挂载）时惰性回退自建实例，保证不白屏。
 */

let fallbackBackend: AppBackend | undefined;

function getFallbackBackend(): AppBackend {
  fallbackBackend ??= createAppBackend();
  return fallbackBackend;
}

export default function McpMarketEntry(props: Record<string, unknown>) {
  const backend = (props.appBackend as AppBackend | undefined) ?? getFallbackBackend();
  return <McpMarket backend={backend} />;
}
