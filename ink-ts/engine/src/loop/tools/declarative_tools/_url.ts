/**
 * urllib.parse.urlsplit 的有限取数面（scheme/hostname）——声明式工具
 * 判定目标推导与受控取回执行体的纯函数 URL 解析。core 零 IO、零第三方，
 * 不复刻完整 WHATWG/urllib 语义，只取本模块需要的两字段：
 *
 * - scheme：协议名（小写；须以字母开头，否则按无协议处理，与 Python
 *   urlsplit 对 "not-a-url" 的宽容一致——不抛错只回落空协议）；
 * - hostname：仅 ``scheme://authority`` 形态才存在（userinfo 剥除、
 *   IPv6 括号剥除、端口剥除）；无 authority / 非 // 形态 = null。
 *
 * 两端点提取器仅凭 scheme/hostname 判定出网语义，不消费 path/query——
 * 凭据（user:pass@）剥除在 authority 层完成，不进入判定目标。
 */

export interface UrlsplitFields {
  /** 协议名（小写；无法解析协议 = ''）。 */
  scheme: string;
  /** 主机名（剥 userinfo/端口/IPv6 括号；缺 authority = null）。 */
  hostname: string | null;
}

/** 解析 URL → (scheme, hostname)；镜像 urllib.parse.urlsplit 的宽容行为。 */
export function url_split(url: string): UrlsplitFields {
  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(url);
  if (schemeMatch === null) return { scheme: '', hostname: null };
  const scheme = schemeMatch[1]!.toLowerCase();
  const rest = url.slice(schemeMatch[0].length);
  if (!rest.startsWith('//')) return { scheme, hostname: null };
  // authority 结束于 / ? #（Python urlsplit 的 netloc 取法）
  let end = rest.length;
  for (let i = 2; i < rest.length; i += 1) {
    const ch = rest.charAt(i);
    if (ch === '/' || ch === '?' || ch === '#') {
      end = i;
      break;
    }
  }
  const authority = rest.slice(2, end);
  // userinfo 剥除（lastIndexOf('@')：裸 @ 属 userinfo 分隔符）
  const at = authority.lastIndexOf('@');
  const hostPort = at === -1 ? authority : authority.slice(at + 1);
  if (hostPort.startsWith('[')) {
    // IPv6 字面量 [addr]:port——hostname 不含方括号
    const close = hostPort.indexOf(']');
    if (close === -1) return { scheme, hostname: null };
    return { scheme, hostname: hostPort.slice(1, close) };
  }
  const colon = hostPort.indexOf(':');
  const bare = colon === -1 ? hostPort : hostPort.slice(0, colon);
  return { scheme, hostname: bare || null };
}
