/**
 * material 命令面（material.import）：既有资料批量导入入口。
 *
 * 语义：扫描 → 逐文件 doc.parse（doc ext）/ 直读（text ext）→ 归一文本
 * 随结果返回（调用方再入会话/知识集）；越限 fail-closed（MaterialError
 * code 透传归类）。参数覆盖三项上限（可配置），默认见 material/scan.ts。
 */

import type { MaterialCommand } from './commands.generated.js';
export { MATERIAL_COMMANDS, type MaterialCommand } from './commands.generated.js';
import { BridgeError, type BridgeHandler } from './_types.js';
import type { HostBridgeDeps } from './_types.js';
import { MaterialError, scanMaterial } from '../material/scan.js';

interface MaterialImportParams {
  root: string;
  recursive?: boolean;
  max_depth?: number;
  max_files?: number;
  max_file_bytes?: number;
  text_cap?: number;
}


export function buildMaterialCommands(deps: HostBridgeDeps): Readonly<Record<MaterialCommand, BridgeHandler>> {
  const importMaterial: BridgeHandler = async (raw): Promise<unknown> => {
    const params = raw as MaterialImportParams | null;
    if (typeof params !== 'object' || params === null || typeof params.root !== 'string' || params.root === '') {
      throw new BridgeError('material.import 需 params.root（扫描目录）', 'invalid_params');
    }
    if (
      params.max_depth !== undefined && params.max_depth !== null && !Number.isInteger(params.max_depth)
    ) {
      throw new BridgeError('material.import max_depth 须为整数', 'invalid_params');
    }
    try {
      return await scanMaterial(
        {
          root: params.root,
          recursive: params.recursive ?? true,
          ...(Number.isInteger(params.max_depth) ? { maxDepth: params.max_depth as number } : {}),
          ...(Number.isInteger(params.max_files) ? { maxFiles: params.max_files as number } : {}),
          ...(Number.isInteger(params.max_file_bytes)
            ? { maxFileBytes: params.max_file_bytes as number }
            : {}),
          ...(Number.isInteger(params.text_cap) ? { textCap: params.text_cap as number } : {}),
        },
        { parse: deps.docParse },
      );
    } catch (error) {
      if (error instanceof MaterialError) {
        throw new BridgeError(`material.import ${error.message}`, error.code);
      }
      throw error;
    }
  };
  return { 'material.import': importMaterial };
}
