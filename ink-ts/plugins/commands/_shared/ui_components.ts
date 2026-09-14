/**
 * 命令插件共享私有件（非插件：无 spec.json，生成器跳过；同 ports/_shared 先例）。
 * 本文件 = hosts/lib/src/bridge/ui_components.ts 原样迁入（S3 命令逻辑下沉，语义零改）：
 * ui_components.get/set_disabled 两命令共享停用集入参读取。
 */

import { BridgeError } from '@ink-ts/host';

/** 停用集入参读取（{ disabled: string[] }；非数组显式报错）。 */
export function disabledParam(raw: unknown): string[] {
  const params =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const disabled = params['disabled'];
  if (!Array.isArray(disabled) || !disabled.every((name) => typeof name === 'string')) {
    throw new BridgeError('ui_components.set_disabled 需 { disabled: string[] }', 'invalid_params');
  }
  return disabled as string[];
}
