/**
 * CLI 进程入口：解析参数 → stdio JSON-RPC 服务。宿主层允许 node 内置
 * IO；审批放行仅来自 --approve 显式声明，从不默认放行。未知启动参数即
 * 拒绝并以退出码 1 结束。
 */

import { parseArgs, HELP_TEXT } from './argv.js';
import { buildHandlers } from './handlers.js';
import { serve } from './server.js';

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n\n${HELP_TEXT}\n`);
    process.exitCode = 1;
    return;
  }
  if (parsed.options.help) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return;
  }
  await serve({ autoApprove: parsed.options.approve, handlers: buildHandlers() });
}

await main();
