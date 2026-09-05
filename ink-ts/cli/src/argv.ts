/**
 * CLI 三形态启动参数解析（stdio | run | serve）。
 *
 * 形态：stdio = 长驻 JSON-RPC（dev/测试/无人值守，缺省形态，兼容旧调用）；
 * run = 一次性驱动面（--round/--op/--os-op/--audit 互斥 + JSON 信封 stdout +
 * exit 0/1/2，镜像 inkling/cli headless 语义，仅取语义）；serve = 本地
 * http/ws（回环鉴权 + 事件订阅通道，S8 前端通道）。
 *
 * 审批语义（D8）：autoApprove 只在显式 --approve 时成立（fail-closed 缺省）。
 * 用法错误：stdio 形态沿用旧约定 exit 1；run/serve 形态按 headless 语义
 * exit 2（参数用法问题）。未知参数一律拒绝。
 */

export const CLI_MODES = ['stdio', 'run', 'serve'] as const;
export type CliMode = (typeof CLI_MODES)[number];

export const GRAPH_NAMES = ['assistant', 'gate'] as const;
export type GraphName = (typeof GRAPH_NAMES)[number];

/** run 形态一次性命令（互斥）。 */
export type RunCommand = 'round' | 'op' | 'os_op' | 'audit';

export interface RunFlags {
  command: RunCommand;
  /** round 输入文本 / op 方法名 / os_op 工具名 / audit 动作（export）。 */
  arg: string;
  /** op 参数 JSON 串（缺省 "{}"）。 */
  args?: string;
  trace_id?: string;
  thread_id?: string;
  round_id?: string;
}

export interface ServeFlags {
  host: string;
  port: number;
  /** 静态托管目录（缺省 = cli 内置 assets 占位）。 */
  static_dir?: string;
  /** Vite dev 代理目标（缺省不代理）。 */
  vite_proxy?: string;
  /** 显式鉴权 token（缺省进程内随机生成）。 */
  token?: string;
}

export interface CliOptions {
  mode: CliMode;
  approve: boolean;
  graph: GraphName;
  help: boolean;
  data_dir?: string;
  events_dir?: string;
  run?: RunFlags;
  serve?: ServeFlags;
}

export type ParseArgsResult =
  | { ok: true; options: CliOptions }
  | { ok: false; error: string; mode: CliMode };

/** 取带值 flag 的 (值, 消费位置) 形态：支持 `--flag=value` 与 `--flag value`。 */
function takeValue(
  flag: string,
  token: string,
  rest: readonly string[],
  index: number,
): { ok: true; value: string; next: number } | { ok: false; error: string } {
  const eq = token.indexOf('=');
  if (eq >= 0) return { ok: true, value: token.slice(eq + 1), next: index + 1 };
  const next = rest[index + 1];
  if (next === undefined) return { ok: false, error: `${flag} 缺参数值` };
  return { ok: true, value: next, next: index + 2 };
}

/** 每形态只允许的参数白名单之外的参数即拒绝（fail-closed；--help/-h 全局放行）。 */
const MODE_ALLOWED_FLAGS: Record<CliMode, ReadonlySet<string>> = {
  stdio: new Set(['--approve', '--graph', '--data-dir', '--events-dir']),
  run: new Set([
    '--approve',
    '--graph',
    '--data-dir',
    '--events-dir',
    '--round',
    '--op',
    '--os-op',
    '--audit',
    '--args',
    '--trace-id',
    '--thread-id',
    '--round-id',
  ]),
  serve: new Set([
    '--approve',
    '--graph',
    '--data-dir',
    '--events-dir',
    '--port',
    '--host',
    '--static',
    '--vite',
    '--token',
  ]),
};

export function parseArgs(argv: readonly string[]): ParseArgsResult {
  // 形态选择：首参为子命令（stdio/run/serve）即选定；否则回落 stdio（兼容旧调用）。
  let mode: CliMode = 'stdio';
  let offset = 0;
  const first = argv[0];
  if ((CLI_MODES as readonly string[]).includes(first ?? '')) {
    mode = first as CliMode;
    offset = 1;
  }
  const options: CliOptions = { mode, approve: false, graph: 'assistant', help: false };
  const allowed = MODE_ALLOWED_FLAGS[mode];
  const fail = (error: string): ParseArgsResult => ({ ok: false, error, mode });

  let index = offset;
  while (index < argv.length) {
    const token = argv[index] as string;
    const flag = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
    if (flag === '--help' || flag === '-h') {
      options.help = true;
      index += 1;
      continue;
    }
    if (!allowed.has(flag)) {
      return fail(`未知参数: ${token}`);
    }
    if (flag === '--approve') {
      options.approve = true;
      index += 1;
      continue;
    }
    if (flag === '--graph' || flag === '--data-dir' || flag === '--events-dir') {
      const taken = takeValue(flag, token, argv, index);
      if (!taken.ok) return { ...taken, mode };
      index = taken.next;
      if (flag === '--graph') {
        if (!(GRAPH_NAMES as readonly string[]).includes(taken.value)) {
          return fail(`未知图配方: ${taken.value}（可用: ${GRAPH_NAMES.join(', ')}）`);
        }
        options.graph = taken.value as GraphName;
      } else if (flag === '--data-dir') {
        options.data_dir = taken.value;
      } else {
        options.events_dir = taken.value;
      }
      continue;
    }
    if (mode === 'run') {
      const taken = takeValue(flag, token, argv, index);
      if (!taken.ok) return { ...taken, mode };
      index = taken.next;
      const run = options.run ?? (options.run = {} as RunFlags);
      if (flag === '--round' || flag === '--op' || flag === '--os-op' || flag === '--audit') {
        const command = flag.slice(2) === 'os-op' ? 'os_op' : (flag.slice(2) as RunCommand);
        if (run.command !== undefined) {
          return fail('互斥参数：--round / --op / --os-op / --audit 仅可指定其一');
        }
        run.command = command;
        run.arg = taken.value;
      } else if (flag === '--args') {
        run.args = taken.value;
      } else if (flag === '--trace-id') {
        run.trace_id = taken.value;
      } else if (flag === '--thread-id') {
        run.thread_id = taken.value;
      } else if (flag === '--round-id') {
        run.round_id = taken.value;
      }
      continue;
    }
    if (mode === 'serve') {
      const taken = takeValue(flag, token, argv, index);
      if (!taken.ok) return { ...taken, mode };
      index = taken.next;
      const serve = options.serve ?? (options.serve = {} as ServeFlags);
      if (flag === '--host') {
        serve.host = taken.value;
      } else if (flag === '--port') {
        const port = Number(taken.value);
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          return fail(`--port 须为 0-65535 的整数: ${taken.value}`);
        }
        serve.port = port;
      } else if (flag === '--static') {
        serve.static_dir = taken.value;
      } else if (flag === '--vite') {
        serve.vite_proxy = taken.value;
      } else if (flag === '--token') {
        serve.token = taken.value;
      }
      continue;
    }
    // stdio：仅 --approve/--graph/--data-dir/--events-dir/--help 已在上层处理
    return fail(`未知参数: ${token}`);
  }

  // --help 短路：不校验形态专属必选参数（run 缺驱动参数等仅 help 时放行）
  if (options.help) {
    return { ok: true, options };
  }
  if (mode === 'run') {
    const run = options.run;
    if (run === undefined || run.command === undefined) {
      return fail('run 形态需指定 --round / --op / --os-op / --audit 之一');
    }
    if (run.command === 'audit' && run.arg !== 'export') {
      return fail(`不支持的审计动作: ${run.arg}（仅 export）`);
    }
  } else if (mode === 'stdio' && (options.run !== undefined || options.serve !== undefined)) {
    return fail('run/serve 专属参数不能用于当前形态（缺省形态 = stdio）');
  }
  return { ok: true, options };
}

const HELP_TEXT = [
  'ink-ts cli — 唯一进程载体，三形态：stdio（JSON-RPC）/ run（一次性驱动）/ serve（本地 http+ws）',
  '',
  '用法:',
  '  ink-ts-cli [stdio] [--approve] [--graph <assistant|gate>] [--data-dir <dir>] [--events-dir <dir>]',
  '  ink-ts-cli run (--round <text> | --op <方法名> | --os-op <工具名> | --audit export) \\',
  '    [--args <json>] [--trace-id <id>] [--thread-id <id>] [--round-id <id>] [--approve] [--graph <名>]',
  '  ink-ts-cli serve [--port <0-65535>] [--host <地址>] [--static <dir>] [--vite <url>]',
  '    [--token <token>] [--approve] [--graph <名>] [--data-dir <dir>]',
  '',
  '形态与参数:',
  '  stdio  长驻 JSON-RPC（缺省形态；host.ping/host.info + host bridge 方法面）',
  '  run    一次性命令：--round/--op/--os-op/--audit 互斥；JSON 信封走 stdout，',
  '         诊断走 stderr；成功 exit 0，运行失败 exit 1，用法错误 exit 2（fail-closed）',
  '  serve  本地 http/ws 服务：/health /rpc /ws + 静态托管/Vite 代理占位；',
  '         启动时 stdout 打印 listen 行（含 url/ws/token）',
  '',
  '公共:',
  '  --approve    显式声明允许审批直过（仅限可信自动化；缺省拒绝放行，D8）',
  '  --graph      装配图配方（assistant=默认产品占位/gate=审批挂卡演示）',
  '  --data-dir   运行数据目录（缺省每进程独立临时目录）',
  '  --events-dir 事件 JSONL 目录（缺省 data_dir/events；D9）',
  '  --help/-h    显示本帮助',
  '',
  'run 专用:',
  '  --round      发起一次回合（回合输入文本）',
  '  --op         调一次 host bridge 方法（rounds.* / records.* / approval.* /',
  '               audit.export / host.ping / host.info；参数经 --args JSON）',
  '  --os-op      单 OS 工具调用（需 exec 原生件接线；本阶段返回 fail-closed 占位错误）',
  '  --audit      审计动作（当前仅 export）',
  '  --args       参数 JSON 串（缺省 {}）',
  '  --trace-id   透传 trace_id（缺省自动生成）',
  '  --thread-id  回合线程 id（缺省 hl-<trace_id>）',
  '  --round-id   回合 id（缺省 hlr-<trace_id>）',
  '',
  'serve 专用:',
  '  --port       监听端口（缺省 0 = 系统分配；输出 listen 行可读）',
  '  --host       监听地址（缺省 127.0.0.1 回环）',
  '  --static     静态托管目录（缺省 cli 内置占位）',
  '  --vite       Vite dev 代理目标（缺省不代理）',
  '  --token      鉴权 token（缺省随机生成；/rpc 走 Authorization Bearer 或',
  '               x-ink-token，/ws 走 ?token= 或 ink_ts_token cookie）',
].join('\n');

export { HELP_TEXT };
