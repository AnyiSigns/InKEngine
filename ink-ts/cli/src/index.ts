/**
 * CLI 进程入口：解析参数 → stdio 逐行 JSON-RPC 服务。宿主层允许 node 内置
 * IO；审批放行仅来自 --approve 显式声明，从不默认放行。
 */

import { createInterface } from 'node:readline';
import { parseArgs, HELP_TEXT } from './argv.js';
import { buildHandlers } from './handlers.js';
import { handleRequest, parseLine } from './rpc.js';

async function serve(opts: { autoApprove: boolean }): Promise<void> {
  const handlers = buildHandlers();
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    void Promise.resolve()
      .then(() => {
        const { request, error } = parseLine(trimmed);
        if (error) return error;
        if (!request) return { jsonrpc: '2.0' as const, id: null, error: { code: -32600, message: 'invalid request' } };
        return handleRequest(request, handlers, { autoApprove: opts.autoApprove });
      })
      .then((response) => process.stdout.write(`${JSON.stringify(response)}\n`));
  });
  await new Promise<void>((resolve) => rl.on('close', resolve));
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return;
  }
  await serve({ autoApprove: opts.approve });
}

await main();
