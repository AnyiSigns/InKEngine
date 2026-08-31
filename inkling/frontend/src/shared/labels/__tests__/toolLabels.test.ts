/**
 * 机械名中文化测试：四层兜底解析、权限档中文、工具族语义化、蛇形替换。
 */

import {
  classifyToolFamily,
  describeToolSemantics,
  extractHostname,
  extractMetric,
  extractSnakeTokens,
  permissionLabel,
  replaceSnakeTokens,
  resolveToolLabel,
} from '@/shared/labels/toolLabels';

describe('resolve_tool_label 四层兜底', () => {
  it('title 通道（宿主解析载荷）优先于内置词典', () => {
    expect(resolveToolLabel({ tool: 'inspect_knowledge', title: '挂载后新名' })).toBe('挂载后新名');
    expect(resolveToolLabel({ tool: 'inspect_knowledge' })).toBe('观察知识集');
  });

  it('title 兜底 → 词典 → label 兜底 → 原始名保底', () => {
    expect(resolveToolLabel({ tool: 'custom_tool_x', title: '标题甲' })).toBe('标题甲');
    expect(resolveToolLabel({ tool: 'custom_tool_x', title: '', label: '标签乙' })).toBe('标签乙');
    expect(resolveToolLabel({ tool: 'custom_tool_x', title: 42, label: null })).toBe('custom_tool_x');
    expect(resolveToolLabel({ tool: 'custom_tool_x' })).toBe('custom_tool_x');
  });

  it('title 优先于 label（title > 词典 > label 顺序）', () => {
    expect(resolveToolLabel({ tool: 'custom_tool_x', title: '标题', label: '标签' })).toBe('标题');
  });
});

describe('权限档中文', () => {
  it('allow/review/deny 三档中文化，未知档原样', () => {
    expect(permissionLabel('allow')).toBe('自动放行');
    expect(permissionLabel('review')).toBe('待审批');
    expect(permissionLabel('deny')).toBe('已拒绝');
    expect(permissionLabel('')).toBe('—');
    expect(permissionLabel('custom')).toBe('custom');
  });
});

describe('工具族判定 + 语义化渲染', () => {
  it('族判定：os/file/network/research/mcp/generic', () => {
    expect(classifyToolFamily('launch_app')).toBe('os');
    expect(classifyToolFamily('file_write')).toBe('file');
    expect(classifyToolFamily('fetch')).toBe('network');
    expect(classifyToolFamily('inspect_graph')).toBe('research');
    expect(classifyToolFamily('mcp_call')).toBe('mcp');
    expect(classifyToolFamily('something_else')).toBe('generic');
  });

  it('OS 族：动作 + 目标 + 结果', () => {
    const semantics = describeToolSemantics({
      tool: 'launch_app',
      permission: 'review',
      summary: '启动完成',
      args: '{"app": "绘图板"}',
    });
    expect(semantics.action).toBe('启动应用');
    expect(semantics.lines).toEqual([
      { key: '目标', value: '绘图板' },
      { key: '结果', value: '启动完成' },
    ]);
  });

  it('文件族：路径 + 操作 + 摘要', () => {
    const semantics = describeToolSemantics({
      tool: 'file_edit',
      permission: 'allow',
      summary: '已保存 1 处修改',
      args: '{"path": "~/inkling/rules.md"}',
    });
    expect(semantics.lines[0]).toEqual({ key: '路径', value: '~/inkling/rules.md' });
    expect(semantics.lines[1].key).toBe('摘要');
  });

  it('网络族：域 + 结果', () => {
    const semantics = describeToolSemantics({
      tool: 'fetch',
      permission: 'review',
      summary: '已取回 12KB',
      args: '{"url": "https://docs.example.org/guide"}',
    });
    expect(semantics.lines[0]).toEqual({ key: '域', value: 'docs.example.org' });
    expect(extractHostname('https://a.b.c/path')).toBe('a.b.c');
  });

  it('研究族：步骤 + 指标（摘要中数字提取）', () => {
    const semantics = describeToolSemantics({
      tool: 'review_material',
      permission: 'allow',
      summary: '评审结果：0.85 分',
    });
    expect(semantics.action).toBe('复核材料');
    expect(semantics.lines[0].key).toBe('步骤');
    expect(semantics.lines[1]).toEqual({ key: '指标', value: '0.85 分' });
    expect(extractMetric('暂无指标')).toBeUndefined();
  });

  it('MCP 族：描述 + 权限档', () => {
    const semantics = describeToolSemantics({
      tool: 'mcp_web_search',
      permission: 'allow',
      summary: '搜索服务可用',
    });
    expect(semantics.lines[0]).toEqual({ key: '描述', value: '搜索服务可用' });
    expect(semantics.lines[1]).toEqual({ key: '权限档', value: '自动放行' });
  });

  it('通用族：描述 + 权限档（无明显域归属）', () => {
    const semantics = describeToolSemantics({
      tool: 'random_helper',
      permission: 'deny',
    });
    expect(semantics.action).toBe('random_helper');
    expect(semantics.lines).toEqual([{ key: '权限档', value: '已拒绝' }]);
  });
});

describe('思考正文蛇形 token → 中文化', () => {
  it('词典键替换为中文标签；未收录词形保留', () => {
    const text = '先调用 inspect_knowledge 再执行 file_read 与 unknown_token_abc';
    const replaced = replaceSnakeTokens(text);
    expect(replaced).toContain('观察知识集');
    expect(replaced).toContain('读取文件');
    expect(replaced).toContain('unknown_token_abc');
    expect(replaced).not.toContain('inspect_knowledge');
  });

  it('原始链可回取（extractSnakeTokens 全量）', () => {
    const tokens = extractSnakeTokens('a inspect_knowledge -> b file_write -> c web_search');
    expect(tokens).toEqual(['inspect_knowledge', 'file_write', 'web_search']);
  });
});
