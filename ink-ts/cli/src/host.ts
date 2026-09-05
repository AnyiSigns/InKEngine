/**
 * CLI 宿主装配（冷启一次，三形态共用）。
 *
 * 委托 @ink-ts/host createHost（composition root）：配置 → 五件套 +
 * 产品配方 → Runtime.boot → bridge 命令面。cli 进程是唯一引擎进程载体，
 * 装配一次、进程生命周期内复用；run 形态一次性使用、serve/stdio 长驻。
 *
 * 图配方 = cli 产品占位图（graphs.ts），审批姿态 --approve 显式声明传入
 * 宿主 config（D8 fail-closed 缺省）。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createHost } from '@ink-ts/host';
import type { HostConfigInput, HostHandle } from '@ink-ts/host';

import type { GraphName } from './argv.js';
import { buildCliGraphRecipe } from './graphs.js';

export interface CliHostOptions {
  approve: boolean;
  graph: GraphName;
  data_dir?: string;
  events_dir?: string;
}

/** 缺省数据目录：每进程独立临时目录（镜像 headless 缺省语义，不污染 cwd）。 */
function defaultDataDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'ink-ts-cli-'));
}

/** 冷启装配一次 host（运行目录缺省临时；events 缺省 data_dir/events）。 */
export async function assembleCliHost(
  options: CliHostOptions,
): Promise<HostHandle> {
  const data_dir = options.data_dir ?? defaultDataDir();
  const config: HostConfigInput = {
    autoApprove: options.approve,
    data_dir,
    events_dir: options.events_dir ?? path.join(data_dir, 'events'),
  };
  return createHost(config, {
    graph_recipe: buildCliGraphRecipe(options.graph, options.approve),
  });
}
