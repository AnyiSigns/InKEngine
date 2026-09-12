/**
 * POSIX shell 词法切分（shlex.split 移植：install_cmds 字符串兼容形态的解析）。
 *
 * 字符串形态的安装命令经 shlex 分词——引号参数安全（含空格路径不裂开），
 * 取代按空格拆分的脆弱语义。纯文本处理（core 零 IO、零第三方依赖），词法
 * 规则对齐 CPython shlex 的 posix 取词：
 * - 空白（空格/制表/换行/回车/纵向与横向制表）切分 token；
 * - 单引号内一切按字面（反斜杠不转义），未闭合抛错；
 * - 双引号内反斜杠仅转义 $ ` " \ 与换行（反斜杠+换行 = 去除），未闭合抛错；
 * - 引号外的反斜杠转义下一字符（含空白与引号）；反斜杠+换行 = 行续接；
 * - 结尾孤立的反斜杠按 posix 丢弃。
 */

/** shlex 空白字符集（缺省 whitespace 面）。 */
const WHITESPACE = new Set([' ', '\t', '\r', '\n', '\u000b', '\u000c']);

/**
 * 分词（镜像 shlex.split(s, comments=False, posix=True)）。
 *
 * 引号未闭合时抛错（镜像 CPython 的 ValueError：No closing quotation），
 * 由调用方按安装失败收口（句柄置 failed + 审计）。
 */
export function shlex_split(command: string): string[] {
  const tokens: string[] = [];
  let token = '';
  let building = false;
  let i = 0;
  const n = command.length;
  while (i < n) {
    const ch = command[i]!;
    if (ch === "'") {
      building = true;
      const close = command.indexOf("'", i + 1);
      if (close === -1) throw new Error('No closing quotation');
      token += command.slice(i + 1, close);
      i = close + 1;
      continue;
    }
    if (ch === '"') {
      building = true;
      i += 1;
      let closed = false;
      while (i < n) {
        const c = command[i]!;
        if (c === '"') {
          closed = true;
          i += 1;
          break;
        }
        if (c === '\\' && i + 1 < n) {
          const next = command[i + 1]!;
          if ('$`"\\\n'.includes(next)) {
            token += next;
            i += 2;
            continue;
          }
          token += '\\';
          i += 1;
          continue;
        }
        if (c === '\\') {
          token += '\\';
          i += 1;
          continue;
        }
        token += c;
        i += 1;
      }
      if (!closed) throw new Error('No closing quotation');
      continue;
    }
    if (ch === '\\') {
      building = true;
      if (i + 1 < n) {
        const next = command[i + 1]!;
        if (next === '\n') {
          i += 2;
          continue;
        }
        token += next;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (WHITESPACE.has(ch)) {
      if (building) {
        tokens.push(token);
        token = '';
        building = false;
      }
      i += 1;
      continue;
    }
    building = true;
    token += ch;
    i += 1;
  }
  if (building) tokens.push(token);
  return tokens;
}
