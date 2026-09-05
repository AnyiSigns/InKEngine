/**
 * CLI 启动参数解析。审批语义：CLI 内不允许默认放行——autoApprove 只在
 * 显式传入 --approve 时成立（可信自动化场景的显式声明，详见宿主语义）。
 * 未知参数/位置参数一律拒绝（fail-closed），由入口回显用法并以退出码 1
 * 结束；CLI 不设工作目录选项（进程 cwd 即宿主启动上下文）。
 */

export interface CliOptions {
  approve: boolean;
  help: boolean;
}

export type ParseArgsResult = { ok: true; options: CliOptions } | { ok: false; error: string };

const HELP_TEXT = [
  'ink-ts cli — 唯一进程载体（stdio JSON-RPC）',
  '',
  '用法:',
  '  ink-ts-cli [--approve] [--help]',
  '',
  '  --approve  显式声明允许审批直过（仅限可信自动化；缺省拒绝放行）',
  '  --help     显示本帮助',
].join('\n');

export function parseArgs(argv: readonly string[]): ParseArgsResult {
  const options: CliOptions = { approve: false, help: false };
  for (const arg of argv) {
    if (arg === '--approve') options.approve = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else return { ok: false, error: `未知参数: ${arg}` };
  }
  return { ok: true, options };
}

export { HELP_TEXT };
