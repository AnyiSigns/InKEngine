import { createAppBackend, type AppBackend } from '@/app/backend';
import { McpMarket } from './McpMarket';

/** 插件自建 AppBackend 单例（阶段 7b 定案 B：serve 未接线时夹具兜底）。 */
const backend: AppBackend = createAppBackend();

export default function McpMarketEntry() {
  return <McpMarket backend={backend} />;
}
