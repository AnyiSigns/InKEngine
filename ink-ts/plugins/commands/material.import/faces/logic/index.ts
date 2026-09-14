/**
 * material.import 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/material.ts
 * 迁入，语义零改）。既有资料批量导入（扫描 → 逐文件 doc.parse/直读 → 归一文本
 * 随结果返回；越限 fail-closed，MaterialError code 透传归类）。
 */

import { BridgeError } from '@ink-ts/host';
import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';
// material 域值随域插件（S4 域组1 遗留改口：域组2 补正）
import { MaterialError, scanMaterial } from '../../../../domains/material/faces/logic/index.js';

interface MaterialImportParams {
  root: string;
  recursive?: boolean;
  max_depth?: number;
  max_files?: number;
  max_file_bytes?: number;
  text_cap?: number;
}

export default function createMaterialImport(deps: HostBridgeDeps): BridgeHandler {
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
  return importMaterial;
}
