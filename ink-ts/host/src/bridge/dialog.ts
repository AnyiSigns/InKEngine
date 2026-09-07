/**
 * dialog 桥接组：原生目录选择（稳定原生面在 exec Rust 的 dialog op）。
 *
 * serve/web 同机时浏览器无法弹 OS 目录框：host 把请求转 exec 原生件
 * （exec 进程内以 rfd 弹原生目录选择器），所选路径回给 web。exec 二进制
 * 未装配/非交互会话失败 → BridgeError('unavailable')，web 回退手动路径；
 * 用户取消 → null（不弹回退）。
 */

import { BridgeError, type BridgeHandler } from './_types.js';
import { ExecClient } from '../exec/client.js';
import { locateNativeBinary } from '../exec/binary.js';

function nativeExec(): ExecClient {
  const binary = locateNativeBinary('exec');
  if (binary === null || binary === '') {
    throw new BridgeError('原生目录选择未装配（先 cargo build ink-ts/exec）', 'unavailable');
  }
  return new ExecClient({ binary });
}

/** dialog 命令声明（方法名唯一真源；装配由 index 聚合此表）。 */
export const DIALOG_COMMANDS = [
  'dialog.open_directory',
] as const;

export type DialogCommand = (typeof DIALOG_COMMANDS)[number];

/** dialog 域桥接组（open_directory → 绝对路径数组或 null=取消）。 */
export function buildDialogCommands(): Readonly<Record<DialogCommand, BridgeHandler>> {
  const handlers: Record<DialogCommand, BridgeHandler> = {
    'dialog.open_directory': async (params) => {
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
    },
  };
  return handlers;
}
