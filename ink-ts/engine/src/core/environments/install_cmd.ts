/**
 * 安装命令条目（install_cmds）形态、校验与解析（environments.py 的安装命令面）。
 *
 * 条目两种形态：
 * - 字符串（兼容形态，经 shlex 分词——引号参数安全）；
 * - 结构化 dict ``{cmd, args}``（推荐形态：命令与参数分离，不再按空格拆分）。
 *
 * 扩展键宿主语义保留（dict[str, Any]：校验只看 cmd/args，其余原样随声明
 * 序列化往返）。错误消息带 Python repr 口径渲染（对 Py 文案可读性对齐）。
 */
import { GraphDefinitionError } from '../errors.js';
import { isRecord } from '../json.js';

import { pyRepr } from './_repr.js';
import { shlex_split } from './_shlex.js';

/** 结构化安装命令（cmd 与 args 分离；args 缺省 = 无参数）。 */
export interface InstallCmdMap {
  readonly cmd: string;
  readonly args?: readonly string[];
  [extra: string]: unknown;
}

/** 安装命令条目：字符串（兼容形态）或结构化形态。 */
export type InstallCmd = string | InstallCmdMap;

/** 条目不可变拷贝：字符串原样；结构化形态浅拷贝（args 数组另拷贝）。 */
export function copyInstallCmd(entry: InstallCmd): InstallCmd {
  if (typeof entry === 'string') return entry;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    out[key] = Array.isArray(value) ? [...value] : value;
  }
  return out as InstallCmd;
}

/** 可读展示形态（审计/日志用；与解析同源：结构化 → "cmd args…"）。 */
export function displayInstallCmd(cmd: InstallCmd): string {
  if (typeof cmd === 'string') return cmd;
  const command = String(cmd['cmd'] ?? '');
  const rawArgs = cmd['args'];
  const argsText = Array.isArray(rawArgs) ? rawArgs.map(String).join(' ') : '';
  return [command, argsText].filter((part) => part !== '').join(' ');
}

/** 条目形态校验（镜像 _validate_install_cmd：字符串须非空；结构化须 cmd+args
 *  合式；其余形态显式拒绝）。断言函数：通过即收窄为 InstallCmd。 */
export function validateInstallCmd(cmd: unknown, env_name: string): asserts cmd is InstallCmd {
  if (typeof cmd === 'string') {
    if (cmd === '') {
      throw new GraphDefinitionError(`环境 ${env_name} 的 install_cmds 须为非空命令条目`);
    }
    return;
  }
  if (isRecord(cmd)) {
    const command = cmd['cmd'];
    if (typeof command !== 'string' || command === '') {
      throw new GraphDefinitionError(
        `环境 ${env_name} 的安装命令条目缺 cmd（字符串）: ${pyRepr(cmd)}`,
      );
    }
    // cmd.get('args') or () 的布尔口径：falsy（缺省/空）一律按空参数放行
    const rawArgs = cmd['args'];
    const args = rawArgs ? rawArgs : [];
    if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
      throw new GraphDefinitionError(
        `环境 ${env_name} 的安装命令条目 args 须为字符串清单: ${pyRepr(cmd)}`,
      );
    }
    return;
  }
  throw new GraphDefinitionError(
    `环境 ${env_name} 的 install_cmds 条目须为字符串或 (cmd, args) 结构: ${pyRepr(cmd)}`,
  );
}

/** 安装命令条目 → [命令, 参数]。字符串形态经 shlex 分词（引号参数安全）；
 *  结构化形态直取 (cmd, args)。分词后为空（空白串）显式报错。 */
export function parseInstallCmd(cmd: InstallCmd): [string, readonly string[]] {
  if (typeof cmd !== 'string') {
    const rawArgs = cmd['args'];
    const args = Array.isArray(rawArgs) ? (rawArgs.map(String) as string[]) : [];
    return [String(cmd['cmd'] ?? ''), args];
  }
  const parts = shlex_split(cmd);
  if (parts.length === 0) {
    throw new GraphDefinitionError(`安装命令条目为空: ${pyRepr(cmd)}`);
  }
  return [parts[0]!, parts.slice(1)];
}
