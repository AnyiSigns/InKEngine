/**
 * records.sessions 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/records.ts
 * 迁入，语义零改）。实现 = plugins/commands/_shared/records.ts 共享域。
 */

import { buildRecordsCommands } from '../../../_shared/records.js';
import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';

export default function createRecordsSessions(deps: HostBridgeDeps): BridgeHandler {
  return buildRecordsCommands(deps)['records.sessions'];
}
