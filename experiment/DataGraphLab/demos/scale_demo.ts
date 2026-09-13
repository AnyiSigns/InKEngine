/**
 * scaling 协议演示 CLI（D 表：main --grid --seeds，产 results.csv）。
 *
 * 只做参数解析与 runScale/writeScaleResults 转调（C.8 全链路都在 eval/scale.js，
 * 本文件不持有第二份协议逻辑）：`--grid "1000,10000" --seeds "0,1,2"` → runScale
 * 落 `--out`（缺省 `runs/scale-demo-<stamp>/`）下 results.{json,csv}，stdout 打印
 * runDir。真实实验（默认 6×5 网格 + k% 副轴）成本以小时计——演示请显式给小网格。
 */

import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PKG_ROOT, runScale, stamp, writeScaleResults } from '../eval/scale.js';

export interface ScaleDemoOptions {
  readonly grid: number[];
  readonly seeds: number[];
  readonly out: string;
}

/** `--grid "100,300"` → [100,300]；空串/非法 token 即抛（不静默回退默认网格）。 */
export function parseList(raw: string, label: string, allowZero: boolean): number[] {
  const parts = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  const out = parts.map((p) => Number(p));
  if (out.length === 0 || out.some((v) => !Number.isInteger(v) || v < (allowZero ? 0 : 1))) {
    throw new Error(`scale_demo: ${label} 须为逗号分隔的${allowZero ? '非负' : '正'}整数序列（收到 ${raw}）`);
  }
  return out;
}

export function parseArgs(argv: readonly string[]): ScaleDemoOptions {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const grid = get('--grid') !== undefined ? parseList(get('--grid')!, '--grid', false) : [100, 300];
  const seeds = get('--seeds') !== undefined ? parseList(get('--seeds')!, '--seeds', true) : [0];
  return { grid, seeds, out: get('--out') ?? join(PKG_ROOT, 'runs', `scale-demo-${stamp()}`) };
}

/** 入口包装（返回退出码）：runScale 内部已落盘一次，这里补一次显式写（同路径幂等）。 */
export function main(argv: readonly string[] = process.argv.slice(2)): number {
  try {
    const opts = parseArgs(argv);
    const runDir = resolve(opts.out);
    const report = runScale({ grid: opts.grid, seeds: opts.seeds, outRoot: dirname(runDir), runId: basename(runDir) });
    writeScaleResults(join(report.runDir, 'results.json'), join(report.runDir, 'results.csv'), report);
    console.log(report.runDir);
    return 0;
  } catch (err) {
    console.error(`scale_demo: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = main();
