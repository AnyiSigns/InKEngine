/**
 * 机械名中文化（纯展示层）：工具名 → 中文标签、权限档中文、工具族语义化。
 *
 * 全部为无副作用纯函数（不依赖 DOM/React），组件层只消费本模块的
 * 字符串结果——展示语义与数据契约解耦，集成期换真实描述字段即可。
 *
 * resolve_tool_label 四层兜底：① 内置中文词典（机器名直查）
 * ② 负载 title ③ 负载 label ④ 原始机器名。
 */

export type ToolFamily = 'os' | 'file' | 'network' | 'research' | 'mcp' | 'self' | 'generic';

export const FAMILY_LABELS: Record<ToolFamily, string> = {
  os: '系统控制',
  file: '文件',
  network: '网络',
  research: '研究',
  mcp: 'MCP 连接',
  self: '进化自指',
  generic: '通用',
};

/** 内置中文词典（与出厂工具表/引擎观察工具同源；未知机器名走兜底）。 */
const TOOL_DICTIONARY: Record<string, string> = {
  // 研究域（材料流水线）
  collect_material: '收集材料',
  parse_material: '解析材料',
  validate_material: '校验材料',
  review_material: '复核材料',
  distill_knowledge: '蒸馏知识',
  mutate_knowledge: '变异知识',
  research_pipeline: '研究管线',
  // 观察/自进化提案（研究自指）
  inspect_graph: '观察回合图',
  inspect_rules: '观察规则集',
  inspect_knowledge: '观察知识集',
  inspect_ui: '观察界面描述',
  inspect_tools: '观察工具表',
  propose_patch: '提议补丁',
  propose_domain_manifest: '提议领域清单',
  propose_mcp_mount: '提议挂载 MCP',
  task_manager: '维护待办清单',
  // OS 域（设备控制）
  system_query: '查询系统信息',
  ui_query: '查询界面',
  file_query: '查询文件',
  launch_app: '启动应用',
  open_file: '打开文件',
  set_volume: '设置音量',
  set_brightness: '设置亮度',
  shell_exec: '执行 Shell 命令',
  notify: '发送通知',
  sleep: '前台等待',
  ui_click: '模拟点击',
  ui_type: '模拟输入',
  window_focus: '聚焦窗口',
  window_minimize: '最小化窗口',
  doc_parse: '解析文档',
  doc_generate: '生成文档',
  screenshot_capture: '屏幕截图',
  material_import: '导入材料',
  // 网络域
  fetch: '抓取网页',
  web_search: '网页搜索',
  web_crawl: '网页爬取',
  // 文件域
  file_read: '读取文件',
  file_write: '写入文件',
  file_edit: '编辑文件',
  // 引擎内置端点
  process_exec: '进程执行',
  file_ops: '文件操作',
  mcp_call: 'MCP 调用',
  mcp_market: 'MCP 市场',
};

/** 词典逆查（蛇形 token → 中文标签的直接查表面）。 */
export function lookupToolLabel(toolName: string): string | null {
  return TOOL_DICTIONARY[toolName] ?? null;
}

/**
 * 四层兜底解析工具展示名：
 * ① title（宿主侧解析的 tool_start 载荷标题）→ ② 内置词典 →
 * ③ label → ④ 原始机器名（兜底保底，绝不出空）。
 */
export function resolveToolLabel(source: { tool: string; title?: unknown; label?: unknown }): string {
  if (typeof source.title === 'string' && source.title.trim() !== '') return source.title.trim();
  const byDictionary = lookupToolLabel(source.tool);
  if (byDictionary) return byDictionary;
  if (typeof source.label === 'string' && source.label.trim() !== '') return source.label.trim();
  return source.tool;
}

/** 权限档中文（自动放行 / 待审批 / 已拒绝；未知档位原样返回）。 */
export function permissionLabel(permission: string): string {
  if (permission === 'allow') return '自动放行';
  if (permission === 'review') return '待审批';
  if (permission === 'deny') return '已拒绝';
  return permission || '—';
}

/** 运行状态中文（工具行/条目状态胶囊的补充面；未知态原样返回）。 */
export function toolStatusLabel(status: string): string {
  if (status === 'running') return '进行中';
  if (status === 'pending') return '排队中';
  if (status === 'done') return '完成';
  if (status === 'error') return '失败';
  return status;
}

/** 工具族判定（按名称前缀/词典/领域启发式；未知 → generic）。 */
export function classifyToolFamily(toolName: string): ToolFamily {
  const name = toolName.toLowerCase();
  if (name.startsWith('mcp')) return 'mcp';
  if (
    /^file_/.test(name) ||
    /^fs_/.test(name) ||
    /^open_file$/.test(name) ||
    /^dir_/.test(name) ||
    /^path_/.test(name)
  ) {
    return 'file';
  }
  if (
    name.startsWith('web_') ||
    name.startsWith('http') ||
    name.startsWith('url_') ||
    name.startsWith('fetch') ||
    name.startsWith('search')
  ) {
    return 'network';
  }
  if (
    name.startsWith('inspect_') ||
    name.startsWith('propose_') ||
    name.startsWith('research_') ||
    name.startsWith('collect_') ||
    name.startsWith('parse_') ||
    name.startsWith('validate_') ||
    name.startsWith('score_') ||
    name.startsWith('review_') ||
    name.startsWith('distill_') ||
    name.startsWith('mutate_') ||
    name.startsWith('simulate_') ||
    name.startsWith('analyze_')
  ) {
    return 'research';
  }
  if (name === 'self' || name.startsWith('self_')) return 'self';
  if (
    name.startsWith('process_') ||
    name.startsWith('shell_') ||
    name.startsWith('system_') ||
    name.startsWith('screen_') ||
    name.startsWith('launch_') ||
    name.startsWith('set_') ||
    name.startsWith('os_') ||
    /^(notify|sleep|ui_click|ui_type|ui_query|window_focus|window_minimize|open_file|file_query)$/.test(name)
  ) {
    return 'os';
  }
  return 'generic';
}

/** 语义概要行：目标/路径/域 提取（按族归类；提取不到 = 空）。 */
function extractTarget(family: ToolFamily, args: Record<string, unknown> | null): string | undefined {
  if (!args) return undefined;
  if (family === 'os') {
    const keys = ['target', 'app', 'value', 'query', 'message', 'action', 'path'] as const;
    for (const key of keys) {
      const value = args[key];
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
      if (value !== undefined && value !== null && typeof value !== 'object') return String(value);
    }
  }
  if (family === 'file') {
    const path = args.path ?? args.target ?? args.file;
    return typeof path === 'string' ? path : undefined;
  }
  if (family === 'network') {
    const url = args.url ?? args.domain ?? args.host;
    if (typeof url === 'string') return extractHostname(url);
    return undefined;
  }
  return undefined;
}

/** URL → 主机名（域名面；非 URL 字符串原样返回）。 */
export function extractHostname(url: string): string {
  const match = /^https?:\/\/([^/]+)/i.exec(url);
  return match ? match[1] : url;
}

/** 指标提取：从结果摘要里捞第一组「数字+单位」（研究族步骤指标面）。 */
export function extractMetric(summary: string): string | undefined {
  const match = /([0-9]+(?:\.[0-9]+)?\s*(?:%|条|个|分|次|ms|s|MB|KB))/i.exec(summary);
  return match ? match[1] : undefined;
}

export interface ToolSemantics {
  /** 头部主行（label + 权限档在组件拼装；此处返回族内动作词） */
  action: string;
  /** 语义要点行（目标/路径/域/指标等，无则空） */
  lines: Array<{ key: string; value: string }>;
}

/**
 * 工具族语义化：
 * OS = 动作 + 目标 + 结果；文件 = 路径 + 操作 + 摘要；网络 = 域 + 结果；
 * 研究 = 步骤 + 指标；MCP = 描述 + 权限档；通用 = 标签 + 权限档。
 */
export function describeToolSemantics(message: {
  tool: string;
  title?: string;
  permission?: string;
  summary?: string;
  args?: string;
}): ToolSemantics {
  const family = classifyToolFamily(message.tool);
  const label = resolveToolLabel({ tool: message.tool, title: message.title });
  const summary = message.summary ?? '';
  let args: Record<string, unknown> | null = null;
  if (message.args) {
    try {
      const parsed = JSON.parse(message.args) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
    } catch {
      args = null;
    }
  }

  if (family === 'os') {
    const target = extractTarget('os', args);
    const lines: Array<{ key: string; value: string }> = [];
    if (target) lines.push({ key: '目标', value: target });
    if (summary) lines.push({ key: '结果', value: summary });
    return { action: label, lines };
  }
  if (family === 'file') {
    const path = extractTarget('file', args);
    const lines: Array<{ key: string; value: string }> = [];
    if (path) lines.push({ key: '路径', value: path });
    if (summary) lines.push({ key: '摘要', value: summary });
    return { action: label, lines };
  }
  if (family === 'network') {
    const host = extractTarget('network', args);
    const lines: Array<{ key: string; value: string }> = [];
    if (host) lines.push({ key: '域', value: host });
    if (summary) lines.push({ key: '结果', value: summary });
    return { action: label, lines };
  }
  if (family === 'research' || family === 'self') {
    const metric = extractMetric(summary);
    const lines: Array<{ key: string; value: string }> = [];
    if (summary) lines.push({ key: '步骤', value: summary });
    if (metric) lines.push({ key: '指标', value: metric });
    return { action: label, lines };
  }
  if (family === 'mcp') {
    const lines: Array<{ key: string; value: string }> = [];
    if (summary) lines.push({ key: '描述', value: summary });
    if (message.permission) lines.push({ key: '权限档', value: permissionLabel(message.permission) });
    return { action: label, lines };
  }
  const lines: Array<{ key: string; value: string }> = [];
  if (summary) lines.push({ key: '描述', value: summary });
  if (message.permission) lines.push({ key: '权限档', value: permissionLabel(message.permission) });
  return { action: label, lines };
}

/** 蛇形 token（含中划线）匹配器：词典键或通用 snake_case 词形。 */
const SNAKE_PATTERN = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

/**
 * 推理正文中的蛇形 token → 中文标签替换（已知词典键替换；
 * 未收录的 snake 词形保留原样）。原始链在组件侧以「查看原文」折叠展开。
 */
export function replaceSnakeTokens(text: string): string {
  if (!text) return text;
  return text.replace(SNAKE_PATTERN, (token) => TOOL_DICTIONARY[token.toLowerCase()] ?? token);
}

/** 提取文本中的全部 snake token（原始链展示面）。 */
export function extractSnakeTokens(text: string): string[] {
  const seen: string[] = [];
  for (const match of text.matchAll(SNAKE_PATTERN)) {
    if (!seen.includes(match[0])) seen.push(match[0]);
  }
  return seen;
}
