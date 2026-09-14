/**
 * rounds.send 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/rounds.ts 迁入，
 * 语义零改）。实现 = plugins/commands/_shared/rounds.ts 共享域（每宿主共享状态：
 * 串行队列/在途登记/会话簿记经 buildRoundsCommands 按 deps 缓存单例）。
 */

import { buildRoundsCommands } from '../../../_shared/rounds.js';
import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';

export default function createRoundsSend(deps: HostBridgeDeps): BridgeHandler {
  return buildRoundsCommands(deps)['rounds.send'];
}
