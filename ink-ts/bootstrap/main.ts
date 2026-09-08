/**
 * bootstrap —— 唯一进程入口（composition root 收敛面）。
 *
 * 读 hosts/<surface>.spec.json（hosts/ 向上探测）→ 校验该面 implemented=true
 * → 委托 cli.runCliMain 执行 stdio/run/serve/tui（cli 为进程实现库，不再自带
 * 语义入口）；换宿主 = 换 argv 面/spec + 重启装配（§五）。直接跑 cli 文件仍是
 * 同一 runCliMain 的兼容入口（cli e2e 不变），规范入口以本文件为准。
 *
 * 用法：tsx bootstrap/main.ts [stdio|run|serve|tui] [--approve] [--data-dir <dir>] ...
 */

import { loadHostSpec } from '../hosts/lib/src/host_spec.js';
import { parseArgs } from '../hosts/cli/src/argv.js';
import { runCliMain } from '../hosts/cli/src/index.js';

/** argv 形态 → host.spec 面（四份宿主 spec 之一；tauri/ide 无 CLI 形态）。 */
const MODE_SURFACE = {
  stdio: 'cli',
  run: 'cli',
  tui: 'cli',
  serve: 'web',
} as const;

type Mode = keyof typeof MODE_SURFACE;

async function bootstrap(): Promise<number> {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    return parsed.mode === 'stdio' ? 1 : 2;
  }
  if (parsed.options.help) {
    return runCliMain(argv);
  }
  const surface = MODE_SURFACE[parsed.options.mode as Mode];
  if (surface !== undefined) {
    const spec = loadHostSpec(surface);
    if (!spec.implemented) {
      process.stderr.write(`bootstrap: host.spec ${surface} implemented=false（装配实现在外部壳仓）\n`);
      return 2;
    }
  }
  return runCliMain(argv);
}

process.exitCode = await bootstrap();
