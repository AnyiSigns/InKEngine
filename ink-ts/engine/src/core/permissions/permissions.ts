/**
 * 声明式权限门禁（PermissionGate：默认拒绝 fail-closed 的权限判定原语）——
 * ink_engine.core.permissions 移植（含 NetworkPolicy / NetworkPolicySandbox）。
 *
 * 工具权限 = 声明式字符串集合（ToolSpec.permissions），形态
 * ``domain:action:pattern``（action 可省略，如 ``network:*.github.com``）：
 * - filesystem:read|write|delete:<路径 glob>——路径以工作根为基准的绝对路径；
 * - process:exec:<命令白名单>——``|`` 分隔的命令名/glob；
 * - network:connect:<域名后缀>——``*.github.com`` 匹配主域及其子域（默认禁网）。
 *
 * 判定三路（PermissionGate.check 返回 GateResult）：
 * - allow：权限声明命中，且门控分级不要求审批；
 * - review：权限命中但门控分级需审批——委托宿主审批（本模块自身不挂起，
 *   只标记需审批）；
 * - deny：权限未命中（fail-closed）或门控分级拒绝。
 *
 * 未声明权限的工具默认拒绝（fail-closed）；宿主可把 default_policy 放宽为
 * review/allow（明示安全让步）。门控分级判定由宿主注入（review_tier）。
 *
 * 沙箱是机制、非安全边界承诺——默认拒绝兜底 + 纵深防御，宿主可叠加 OS 级隔离。
 * 白名单审计：域动作集合为机制固有——域语义绑定（network 后缀匹配、
 * filesystem 路径边界），实际判定对未知域走 fnmatch 兜底（非收紧型：
 * 宿主自定义域不拒绝），清单仅作校验与文档。
 *
 * TS 移植说明：
 * - logging 留痕属可观测性副作用，TS core 零 IO 不落；本模块无时间/随机 seam；
 * - fnmatch 以同语义正则翻译实现（大小写敏感、通配与字符类跨路径分隔符匹配、
 *   全文锚定），字符类内正则有特殊位的转义规则与 Python re 存在差异的写法
 *   已按 JS 语义归一；
 * - SandboxViolation 暂无 TS 类映射，按既有移植口径以 new Error 表达
 *   （待 core.exceptions 其余领域异常移植后收敛至统一错误模块）。
 */

export const ALLOW = 'allow';
export const REVIEW = 'review';
export const DENY = 'deny';

// 各权限域支持的判定动作（供校验与文档；匹配时 action 支持 fnmatch 通配）
const DOMAIN_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  filesystem: ['read', 'write', 'delete', 'edit'],
  process: ['exec'],
  // search = web_search 端点的独立动作：查询串无法做域名白名单匹配，
  // 联网搜索从 connect 语义中独立——声明 network:search:* = 允许搜索
  // （pattern 为通配标记）；connect 仍服务 http_fetch 域名白名单
  network: ['connect', 'search'],
};

const KNOWN_DOMAINS: ReadonlySet<string> = new Set(Object.keys(DOMAIN_ACTIONS));

const FS_ACTIONS = DOMAIN_ACTIONS['filesystem']!;

const REGEX_SPECIAL = new Set(['\\', '^', '$', '.', '|', '?', '*', '+', '(', ')', '[', ']', '{', '}']);

// fnmatch 编译缓存：pattern → RegExp。容量上限 + 最旧即弃（Map 迭代序 =
// 插入序，超限淘汰最先插入的键）——模块级缓存不可无界膨胀（权限声明/
// 域名判定均可能输入不可信/高基数 pattern 串）
const FNMATCH_CACHE_MAX = 512;
const FNMATCH_CACHE = new Map<string, RegExp>();

/** 正则特殊字面量（类外）反斜杠转义。 */
function regexEscape(c: string): string {
  return '\\' + c;
}

/** fnmatch 字符类内文的转义：\\、^、[、] 一律加反斜杠（含首位成员），
 *  其余原样保留（- 的范围语义不变）——规避 JS 与 Python re 对类内首位
 *  ]/^ 处理差异导致的语义漂移。 */
function fnmatchClassBody(body: string): string {
  let out = '';
  let rest = body;
  if (rest.startsWith('!')) {
    // fnmatch 的否定标记 '!' → 正则否定 '^'
    out = '^';
    rest = rest.slice(1);
  }
  for (let k = 0; k < rest.length; k += 1) {
    const ch = rest.charAt(k);
    if (ch === '\\' || ch === '^' || ch === '[' || ch === ']') out += '\\' + ch;
    else out += ch;
  }
  return out;
}

/**
 * fnmatch 通配 → 正则（Python fnmatch.translate 的同语义翻译）。
 * '*'/'?' 匹配任意字符（含路径分隔符——不把 '/' 当边界）；'[seq]' /
 * '[!seq]' 字符类；反斜杠按字面匹配（filesystem 判定前已把反斜杠归一为
 * 正斜杠）。全文锚定（镜像 Python re 的 \z；末尾换行边界差异对路径/域名
 * 目标无影响，不处理）。
 */
function fnmatchTranslate(pattern: string): string {
  let res = '';
  let i = 0;
  const n = pattern.length;
  while (i < n) {
    const c = pattern.charAt(i);
    if (c === '*') {
      res += '.*';
      i += 1;
    } else if (c === '?') {
      res += '.';
      i += 1;
    } else if (c === '[') {
      let j = i + 1;
      if (j < n && pattern.charAt(j) === '!') j += 1;
      // 紧邻 '['（或否定标记）的 ']' 按字面成员（shell 惯例），并入类内文
      if (j < n && pattern.charAt(j) === ']') j += 1;
      while (j < n && pattern.charAt(j) !== ']') j += 1;
      if (j >= n) {
        // 缺配对 ']'：按字面 '[' 处理（fnmatch 行为）
        res += '\\[';
        i += 1;
        continue;
      }
      res += '[' + fnmatchClassBody(pattern.slice(i + 1, j)) + ']';
      i = j + 1;
    } else if (REGEX_SPECIAL.has(c)) {
      res += regexEscape(c);
      i += 1;
    } else {
      res += c;
      i += 1;
    }
  }
  return res;
}

/** 单段 fnmatch 匹配（大小写敏感；结果按 pattern 缓存，超限最旧即弃）。 */
function fnmatch(name: string, pattern: string): boolean {
  let re = FNMATCH_CACHE.get(pattern);
  if (re === undefined) {
    if (FNMATCH_CACHE.size >= FNMATCH_CACHE_MAX) {
      const oldest = FNMATCH_CACHE.keys().next();
      if (!oldest.done) FNMATCH_CACHE.delete(oldest.value);
    }
    re = new RegExp(`^(?:${fnmatchTranslate(pattern)})$`, 's');
    FNMATCH_CACHE.set(pattern, re);
  }
  return re.test(name);
}

/** ``|`` 分隔的多模式匹配（任一命中即真）。 */
function fnmatchAny(pattern: string, target: string): boolean {
  if (pattern.includes('|')) {
    return pattern.split('|').some((p) => fnmatch(target, p));
  }
  return fnmatch(target, pattern);
}

/** PurePosixPath.parts 的等价切分（路径越界判定用：重复/尾部斜杠折叠、'.'
 *  段去除、'..' 保留为独立段、绝对路径以 '/' 为根段）。 */
function posixParts(path: string): string[] {
  if (path === '') return [];
  const absolute = path.startsWith('/');
  const segments = (absolute ? path.slice(1) : path).split('/');
  const parts: string[] = [];
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    parts.push(seg);
  }
  if (absolute) parts.unshift('/');
  return parts;
}

/** Python repr 口径的字符串渲染（单引号优先；含单引号不含双引号时用双引号）。 */
function pyRepr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  const escaped = value
    .replace(/\\/g, '\\\\')
    .split(quote)
    .join('\\' + quote)
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return quote + escaped + quote;
}

/** 解析后的权限规则（``domain:action:pattern`` 三段式，action 可省略为 *）。 */
export class PermissionRule {
  readonly domain: string;
  readonly action: string;
  readonly pattern: string;

  constructor(domain: string, action: string, pattern: string) {
    this.domain = domain;
    this.action = action;
    this.pattern = pattern;
  }
}

/**
 * 声明式权限串 → 规则（缺省 action 为 *）。
 * 形态：``domain:action:pattern`` 或 ``domain:pattern``；未知域不拒绝
 * （宿主自定义域经同一 fnmatch 匹配），未知域误写由匹配自然失效。
 * 形态非法 / domain / pattern 为空抛 Error（Python ValueError 的映射）。
 */
export function parse_permission(spec: string): PermissionRule {
  const first = spec.indexOf(':');
  if (first === -1) {
    throw new Error(`权限声明须为 domain[:action]:pattern 形态: ${pyRepr(spec)}`);
  }
  const second = spec.indexOf(':', first + 1);
  if (second === -1) {
    const domain = spec.slice(0, first);
    const pattern = spec.slice(first + 1);
    if (!domain || !pattern) {
      throw new Error(`权限声明的 domain/pattern 不能为空: ${pyRepr(spec)}`);
    }
    return new PermissionRule(domain, '*', pattern);
  }
  const domain = spec.slice(0, first);
  const action = spec.slice(first + 1, second);
  const pattern = spec.slice(second + 1);
  if (!domain || !pattern) {
    throw new Error(`权限声明的 domain/pattern 不能为空: ${pyRepr(spec)}`);
  }
  return new PermissionRule(domain, action, pattern);
}

/**
 * 网络域匹配：``*.github.com`` 匹配 github.com 及其任意子域；其余 fnmatch。
 */
export function network_matches(pattern: string, host: string): boolean {
  if (pattern.startsWith('*.')) {
    const bare = pattern.slice(2);
    return host === bare || host.endsWith('.' + bare);
  }
  return fnmatch(host, pattern);
}

/**
 * 规则 × 单次判定的匹配（分域语义；network 为域名后缀匹配，其余 fnmatch）。
 * filesystem 判定前做路径归一（反斜杠转正斜杠）与越界拒绝——fnmatch 的
 * ``*``/``**`` 跨路径分隔符匹配，``/book/**`` 可放行 ``/book/../../etc/passwd``，
 * 权限层须先守住路径边界（含 ``..`` 段的路径一律拒绝）。
 */
export function rule_matches(rule: PermissionRule, operation: string, target: string): boolean {
  const actionHit = fnmatch(operation, rule.action);
  const legacySearchCompat =
    rule.domain === 'network' &&
    rule.action === 'connect' &&
    operation === 'search' &&
    rule.pattern === '*';
  if (!actionHit && !legacySearchCompat) return false;
  if (rule.domain === 'network') return network_matches(rule.pattern, target);
  if (rule.domain === 'filesystem') {
    const t = target.replace(/\\/g, '/');
    if (posixParts(t).includes('..')) return false;
    return fnmatchAny(rule.pattern.replace(/\\/g, '/'), t);
  }
  if (KNOWN_DOMAINS.has(rule.domain)) return fnmatchAny(rule.pattern, target);
  // 宿主自定义域：同样走 fnmatch（机制不给自定义域额外语义）。自定义域回退
  // = 非收紧匹配——未登记的域名/动作不会因此被拒，而是按 fnmatch 通配判定；
  // 宿主须自行约束自定义域的声明形态（域/动作拼写错误时声明静默不命中 =
  // 默认拒绝，不会误放行）。
  return fnmatchAny(rule.pattern, target);
}

/** 单次判定的结果（宿主按 decision 执行/审批/拒绝）。 */
export class GateResult {
  readonly decision: string;
  readonly tool: string;
  readonly operation: string;
  readonly target: string;
  readonly reason: string;

  constructor(decision: string, tool: string, operation: string, target: string, reason = '') {
    this.decision = decision;
    this.tool = tool;
    this.operation = operation;
    this.target = target;
    this.reason = reason;
  }
}

/**
 * 声明式权限门禁（fail-closed）。
 * default_policy: 工具未声明权限（或未命中）时的兜底——deny（默认，
 * 未声明权限工具默认拒绝）/ review（转审批）/ allow（明示让步）。
 * review_tier: 门控分级注入（宿主接线的分级判定）；返回 True 的工具在
 * 权限命中后仍转 review，False 直过。
 */
export class PermissionGate {
  readonly default_policy: string;
  readonly review_tier: ((tool: string) => boolean) | null;

  constructor(default_policy: string = DENY, review_tier: ((tool: string) => boolean) | null = null) {
    this.default_policy = default_policy;
    this.review_tier = review_tier;
  }

  /** 判定一次工具调用：权限声明命中 × 门控分级 → allow / review / deny。 */
  check(
    tool: string,
    operation: string,
    target: string,
    options: { permissions?: readonly string[] } = {},
  ): GateResult {
    const permissions = options.permissions ?? [];
    let hit = false;
    for (const spec of permissions) {
      if (rule_matches(parse_permission(spec), operation, target)) {
        hit = true;
        break;
      }
    }
    if (!hit) {
      if (this.default_policy === ALLOW) {
        return new GateResult(ALLOW, tool, operation, target, '未声明权限（宿主放宽为放行）');
      }
      if (this.default_policy === REVIEW) {
        return new GateResult(REVIEW, tool, operation, target, '未声明权限（宿主放宽为审批）');
      }
      let reason =
        permissions.length === 0
          ? '未声明权限或权限未命中，默认拒绝'
          : `权限未命中: ${pyRepr(target)}`;
      // filesystem 判定拒绝时附路径形态引导：模型传相对路径仅见「权限未命中」
      // 会盲目试错——判定处直接提示路径须以工作区根绝对前缀开头，
      // 减少无引导的形态试探。
      if (FS_ACTIONS.includes(operation) && permissions.some((p) => p.startsWith('filesystem:'))) {
        reason += '；filesystem 路径须以工作区根绝对前缀开头（如 /workspace/ 下的绝对路径）';
      }
      return new GateResult(DENY, tool, operation, target, reason);
    }
    if (this.review_tier !== null && this.review_tier(tool)) {
      return new GateResult(REVIEW, tool, operation, target, '门控分级需审批');
    }
    return new GateResult(ALLOW, tool, operation, target, '');
  }
}

/** 网络访问判定原语（默认禁网；白名单域名由宿主配置）。 */

export { NetworkPolicy, NetworkPolicySandbox } from './networkPolicy.js';
