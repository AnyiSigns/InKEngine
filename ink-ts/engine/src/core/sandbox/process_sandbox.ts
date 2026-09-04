/**
 * 进程沙箱（sandbox.py 的 ProcessSandbox / ProcessResult / _truncate 移植）。
 *
 * 受限子进程执行：白名单命令 + 超时 kill + 输出截断 + 工作目录限定 +
 * 环境变量清理（缺省干净环境，不含宿主变量）。网络判定在 permissions
 * 模块（NetworkPolicy：默认禁网，白名单域名由宿主配置），不在此列。
 *
 * core 零 IO：create_subprocess_exec 属进程执行体，经 SpawnSeam 注入
 * （宿主实现真实 spawn）；本模块保留编排语义——守卫 validate（fail-closed，
 * 缺省空白名单 = 全部拒绝）、运行环境组装（PATH setdefault）、wait_for
 * 超时 kill 后收尸、stdout/stderr 截断。未注入 seam 的 run 抛错提示。
 */

import { SandboxViolation } from '../errors.js';
import { DEFAULT_MAX_RESULT_CHARS } from '../tool_pipeline/tool_pipeline.js';

/** 子进程执行结果（退出码 + 截断输出 + 超时标记）。 */
export class ProcessResult {
  readonly exit_code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timed_out: boolean;

  constructor(exit_code: number, stdout: string, stderr: string, timed_out = false) {
    this.exit_code = exit_code;
    this.stdout = stdout;
    this.stderr = stderr;
    this.timed_out = timed_out;
  }
}

/** 受限子进程句柄 seam（asyncio.subprocess.Process 的消费面镜像）。 */
export interface SpawnHandle {
  readonly exit_code: number | null;
  communicate(): Promise<{ stdout: Uint8Array; stderr: Uint8Array }>;
  kill(): void;
}

/** 进程执行体 seam（create_subprocess_exec 镜像；真实 spawn 由宿主注入）。
 *  执行对象 = 校验对象：run 只把守卫通过的 command/args 交给 seam。 */
export interface SpawnSeam {
  spawn(
    command: string,
    args: readonly string[],
    options: { cwd: string | null; env: Readonly<Record<string, string>> },
  ): Promise<SpawnHandle>;
}

/** 输出截断（errors="replace" 解码 + 超限加截断标记，与 Python 同文案）。 */
export function _truncate(data: Uint8Array, limit: number): string {
  const text = new TextDecoder('utf-8').decode(data);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…（已截断）`;
}

/** wait_for 的超时信号（只由 _wait_for_timeout 抛出，不跨 seam 冒泡）。 */
class TimeoutSignal extends Error {}

/** asyncio.wait_for 的镜像：超时拒绝，底层 promise 到达后清理定时器。 */
function _wait_for_timeout<T>(promise: Promise<T>, seconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutSignal()), seconds * 1000);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Python repr 口径的命令名渲染（校验失败文案的 {target!r}）。 */
function _repr_command(command: string): string {
  const quote = command.includes("'") && !command.includes('"') ? '"' : "'";
  const escaped = command
    .replace(/\\/g, '\\\\')
    .replaceAll(quote, `\\${quote}`)
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `${quote}${escaped}${quote}`;
}

/**
 * 受限子进程执行（白名单命令 + 超时 kill + 输出截断 + 目录/环境限定）。
 *
 * allowlist: 白名单命令集合（缺省空 = 全部拒绝，fail-closed）；timeout:
 * 超时秒数（超时 kill 并标记 timed_out）；cwd: 工作目录限定（None = 继承
 * 引擎进程目录）；max_output: stdout/stderr 各自截断上限（字符，与工具结果
 * 文本截断同源常量，语义略不同但同量级共维护）；env: 环境变量白名单
 * （None = 干净环境，不含宿主变量）；path: 显式 PATH 注入（None = 不注入；
 * env 无 PATH 时裸命令名无法解析——白名单用裸命令名须注入 path 或改用
 * 绝对路径，引擎不替宿主决定平台默认值）。
 */
export class ProcessSandbox {
  readonly allowlist: readonly string[];
  readonly timeout: number;
  readonly cwd: string | null;
  readonly max_output: number;
  readonly env: Readonly<Record<string, string>> | null;
  readonly path: string | null;
  readonly spawner: SpawnSeam | null;

  constructor(
    allowlist: readonly string[] = [],
    timeout = 30.0,
    cwd: string | null = null,
    max_output = DEFAULT_MAX_RESULT_CHARS,
    env: Readonly<Record<string, string>> | null = null,
    path: string | null = null,
    spawner: SpawnSeam | null = null,
  ) {
    this.allowlist = allowlist;
    this.timeout = timeout;
    this.cwd = cwd;
    this.max_output = max_output;
    this.env = env;
    this.path = path;
    this.spawner = spawner;
  }

  /** 是否本沙箱守卫的操作域（多端点流水线各司其职的依据）。 */
  guards_operation(operation: string): boolean {
    return operation === 'exec';
  }

  /** 守卫校验：非 exec 操作/命令不在白名单/裸命令名缺 PATH 一律违规。 */
  validate(operation: string, target: string): null {
    if (operation !== 'exec') {
      throw new SandboxViolation(`不支持的进程操作: ${operation}`);
    }
    if (!this.allowlist.includes(target)) {
      throw new SandboxViolation(`命令不在白名单: ${target}`);
    }
    // 裸命令名 + 未注入 PATH + env 无 PATH：执行必失败且报错难懂
    // （FileNotFoundError）——在守卫期给出明确指引（fail-closed，不自动
    // 注入平台默认值）
    if (
      !target.includes('/') &&
      !target.includes('\\') &&
      this.path === null &&
      !(this.env ?? {}).PATH
    ) {
      throw new SandboxViolation(
        `命令 ${_repr_command(target)} 为裸命令名但未配置 PATH（ProcessSandbox.path ` +
          '或 env.PATH）：请注入 PATH 或改用绝对路径',
      );
    }
    return null;
  }

  /** 执行白名单命令（参数透传，默认禁 shell——不经 shell 解释）。 */
  async run(command: string, args: readonly string[] = []): Promise<ProcessResult> {
    this.validate('exec', command);
    if (this.spawner === null) {
      throw new Error('进程执行需要宿主执行体（ProcessSandbox.spawner 未注入）');
    }
    const run_env: Record<string, string> = {};
    if (this.env !== null) Object.assign(run_env, this.env);
    if (this.path !== null && run_env.PATH === undefined) {
      run_env.PATH = this.path;
    }
    const proc = await this.spawner.spawn(command, [...args], {
      cwd: this.cwd,
      env: run_env,
    });
    try {
      const io = await _wait_for_timeout(proc.communicate(), this.timeout);
      return new ProcessResult(
        proc.exit_code ?? 0,
        _truncate(io.stdout, this.max_output),
        _truncate(io.stderr, this.max_output),
      );
    } catch (error) {
      if (!(error instanceof TimeoutSignal)) throw error;
      proc.kill();
      await proc.communicate();
      return new ProcessResult(-1, '', '', true);
    }
  }
}
