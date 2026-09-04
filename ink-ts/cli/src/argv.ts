/**
 * CLI 启动参数解析。审批语义：CLI 内不允许默认放行——autoApprove 只在
 * 显式传入 --approve 时成立（可信自动化场景的显式声明，详见宿主语义）。
 */

export interface CliOptions {
  approve: boolean;
  help: boolean;
  cwd: string;
}

const HELP_TEXT = [
  'ink-ts cli — 唯一进程载体（stdio JSON-RPC）',
  '',
  '用法:',
  '  ink-ts-cli [--approve] [--help]',
  '',
  '  --approve  显式声明允许审批直过（仅限可信自动化；缺省拒绝放行）',
  '  --help     显示本帮助',
].join('\n');

export function parseArgs(argv: readonly string[], env: Record<string, string | undefined> = process.env): CliOptions {
  const opts: CliOptions = { approve: false, help: false, cwd: env.INK_TS_CWD ?? process.cwd() };
  for (const arg of argv) {
    if (arg === '--approve') opts.approve = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
  }
  return opts;
}

export { HELP_TEXT };
