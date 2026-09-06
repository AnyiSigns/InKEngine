/**
 * CLI 宿主装配（冷启一次，三形态共用）。
 *
 * 委托 @ink-ts/host createHost（composition root）：配置 → 五件套 +
 * 产品配方 → Runtime.boot → bridge 命令面。cli 进程是唯一引擎进程载体，
 * 装配一次、进程生命周期内复用；run 形态一次性使用、serve/stdio 长驻。
 *
 * 图配方 = cli 产品占位图（graphs.ts），审批姿态 --approve 显式声明传入
 * 宿主 config（fail-closed 缺省）。
 *
 * 模型配置冷启装配：data_dir/config.json 持久化的 model_config（设置页
 * models.config.put 落盘）启动读入并合并进 HostConfigInput——显式传入槽
 * （CLI 参数/env 面）优先，缺席槽取持久化值；重启后运行期配置仍生效。
 *
 * 数据目录生命周期：data_dir 缺省 = 本模块自建临时目录（每进程独立）；
 * assembleCliHost 记住该归属，dispose 时先关停 host 再删除临时目录（进程
 * 收尾不留垃圾）；显式传入的 data_dir 属调用方所有，dispose 不触碰。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createHost, load_persisted_model_config } from '@ink-ts/host';
import type { HostConfigInput, HostHandle, ModelConfigInput } from '@ink-ts/host';

import type { GraphName } from './argv.js';
import { buildCliGraphRecipe } from './graphs.js';

export interface CliHostOptions {
  approve: boolean;
  graph: GraphName;
  data_dir?: string;
  events_dir?: string;
  /** 显式模型配置（CLI/env 面；缺省仅取 data_dir/config.json 持久化值）。 */
  model_config?: ModelConfigInput | null;
}

/** 缺省数据目录：每进程独立临时目录（镜像 headless 缺省语义，不污染 cwd）。 */
function defaultDataDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'ink-ts-cli-'));
}

/** config.json 槽位补入：显式传入键优先，缺席键取持久化值。 */
function mergePersistedModelConfig(
  explicit: ModelConfigInput | null | undefined,
  persisted: Record<string, unknown>,
): ModelConfigInput {
  const merged: Record<string, unknown> = { ...persisted };
  if (explicit !== null && explicit !== undefined) {
    for (const [key, value] of Object.entries(explicit)) {
      if (value !== undefined) merged[key] = value;
    }
  }
  return merged as unknown as ModelConfigInput;
}

/** 冷启装配一次 host（运行目录缺省临时；events 缺省 data_dir/events）。 */
export async function assembleCliHost(
  options: CliHostOptions,
): Promise<HostHandle> {
  const ownsDataDir = options.data_dir === undefined;
  const data_dir = options.data_dir ?? defaultDataDir();
  const config: HostConfigInput = {
    autoApprove: options.approve,
    data_dir,
    events_dir: options.events_dir ?? path.join(data_dir, 'events'),
  };
  try {
    const persisted = load_persisted_model_config(data_dir);
    if (persisted !== null) {
      config.model_config = mergePersistedModelConfig(options.model_config, persisted);
    }
    const handle = await createHost(config, {
      graph_recipe: buildCliGraphRecipe(options.graph, options.approve),
    });
    return ownsDataDir ? withTempDirCleanup(handle, data_dir) : handle;
  } catch (error) {
    // 装配失败不泄漏自建临时目录（显式 data_dir 属调用方，不动）
    if (ownsDataDir) rmSync(data_dir, { recursive: true, force: true });
    throw error;
  }
}

/** 包一层 dispose：原 host 关停后删除自建临时 data_dir（幂等）。 */
function withTempDirCleanup(handle: HostHandle, data_dir: string): HostHandle {
  let cleaned = false;
  const dispose = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    try {
      await handle.dispose();
    } finally {
      rmSync(data_dir, { recursive: true, force: true });
    }
  };
  return { ...handle, dispose };
}
