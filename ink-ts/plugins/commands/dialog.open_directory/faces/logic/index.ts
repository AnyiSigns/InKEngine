/**
 * dialog.open_directory 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/dialog.ts
 * 迁入，语义零改）。原生目录选择（稳定原生面在 exec Rust 的 dialog op；exec 未装配
 * /非交互会话失败 → unavailable，web 回退手动路径；用户取消 → null）。
 */

import { BridgeError, ExecClient, locateNativeBinary } from '@ink-ts/host';
import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';

function nativeExec(): ExecClient {
  const binary = locateNativeBinary('exec');
  if (binary === null || binary === '') {
    throw new BridgeError('原生目录选择未装配（先 cargo build ink-ts/exec）', 'unavailable');
  }
  return new ExecClient({ binary });
}

export default function createDialogOpenDirectory(_deps: HostBridgeDeps): BridgeHandler {
  /** dialog 域桥接组（open_directory → 绝对路径数组或 null=取消）。 */
  const handler: BridgeHandler = async (params): Promise<unknown> => {
    const raw = typeof params === 'object' && params !== null && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {};
    const title = typeof raw['title'] === 'string' ? raw['title'] : '选择目录';
    const client = nativeExec();
    try {
      const outcome = await client.call(
        { tool: 'dialog', op: 'dialog', args: { title } },
        {
          approved: true,
          by: 'host:dialog',
          trace_id: null,
          endpoint: 'dialog',
          roots: [],
          allowlist: [],
          timeout_secs: 120,
          max_chars: 1024,
        },
      );
      const output = outcome.output as { path?: unknown };
      const path = output['path'];
      if (path === null || path === undefined) return null;
      if (typeof path !== 'string' || path === '') return null;
      return [path];
    } catch (err) {
      throw new BridgeError(
        `原生目录选择失败: ${err instanceof Error ? err.message : String(err)}`,
        'unavailable',
      );
    } finally {
      await client.close();
    }
  };

  return handler;
}
