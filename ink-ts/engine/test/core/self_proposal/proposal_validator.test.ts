// gate: 超限(382 行) - 按类型校验用例共享同一组 fixture 编排，拆文件降低校验面回归可读性
/**
 * 自指层提案协议校验面单测：按类型校验语义（Python test_self_proposal.py
 * ProposalValidator 用例移植）。
 *
 * 覆盖：界面三层白名单/运行期组件白名单更新/主题 token/工具定义与命名
 * 规范（MCP 豁免）/规则解析/知识条目与注入 schema/图与 harness/事件类型
 * renderer 契约/环境声明/产物哈希，以及违规清单附合法形态示例骨架。
 *
 *  deferred（引擎执行器集成面另行覆盖）：
 * - 引擎执行器集成用例（propose_patch → apply_patch → 审批分级 → 补丁链
 *   落链，经执行器跑完整回路）对应 Python test_self_application.py 集成面，
 *   待 self_application 迁入 ink-ts 后补测；本文件只覆盖提案协议本身
 *   （纯 ProposalValidator 校验语义，零执行器依赖）。
 */

import { describe, expect, it } from 'vitest';

import {
  PatchKind,
  ProposalValidator,
  SelfProposal,
} from '../../../src/core/self_proposal/index.js';
import {
  FIELD_OBJECT,
  FIELD_STRING,
  SchemaField,
  SchemaSpec,
} from '../../../src/core/schema/schemaValidator.js';

function _proposal(
  kind: PatchKind,
  payload: Record<string, unknown>,
  base_version = 1,
): SelfProposal {
  return new SelfProposal({
    kind,
    payload,
    base_version,
    rationale: '测试提案',
    meta: { round_id: 'r1' },
  });
}

interface ValidatorKwargs {
  knowledge_schema?: SchemaSpec | null;
}

function _validator(kwargs: ValidatorKwargs = {}): ProposalValidator {
  return new ProposalValidator({
    allowed_components: ['column', 'message_list'],
    allowed_channels: ['state'],
    allowed_theme_tokens: ['bg', 'fg'],
    ...kwargs,
  });
}

describe('ProposalValidator.ui 补丁（界面三层白名单）', () => {
  it('合法界面描述通过；未注册组件/未放行绑定通道拒绝', () => {
    const validator = _validator();
    const ok = _proposal(PatchKind.UI, {
      spec: {
        name: 'boot.panel',
        root: {
          kind: 'container',
          type: 'column',
          children: [{ kind: 'component', type: 'message_list' }],
        },
      },
    });
    expect(validator.validate(ok)).toEqual([]);

    const badComponent = _proposal(PatchKind.UI, {
      spec: { name: 'x', root: { kind: 'component', type: 'evil_component' } },
    });
    expect(validator.validate(badComponent).some((v) => v.includes('组件未注册'))).toBe(true);

    const badBind = _proposal(PatchKind.UI, {
      spec: {
        name: 'x',
        root: {
          kind: 'component',
          type: 'message_list',
          bind: { channel: '_internal', path: 'secret' },
        },
      },
    });
    expect(validator.validate(badBind).some((v) => v.includes('未放行'))).toBe(true);
  });

  it('运行期组件白名单更新（出厂组件停用即时剔除 → 后续 ui 补丁被拒）', () => {
    const validator = _validator();
    const proposal = _proposal(PatchKind.UI, {
      spec: { name: 'x', root: { kind: 'component', type: 'message_list' } },
    });
    expect(validator.validate(proposal)).toEqual([]);
    validator.set_allowed_components(['column']);
    expect(validator.validate(proposal).some((v) => v.includes('组件未注册'))).toBe(true);
  });
});

describe('ProposalValidator.theme 补丁（主题 token 白名单）', () => {
  it('白名单内通过；未声明 token / 缺 tokens 拒绝', () => {
    const validator = _validator();
    const ok = _proposal(PatchKind.THEME, { tokens: { bg: '#111', fg: '#eee' } });
    expect(validator.validate(ok)).toEqual([]);
    const bad = _proposal(PatchKind.THEME, { tokens: { evil_token: '#000' } });
    expect(validator.validate(bad).some((v) => v.includes('未声明'))).toBe(true);
    const missing = validator.validate(_proposal(PatchKind.THEME, {}));
    expect(missing.length > 0).toBe(true);
    expect(missing[0]).toContain('缺 tokens');
  });
});

describe('ProposalValidator.tool 补丁（声明式工具定义 + 命名规范）', () => {
  it('合法工具通过；缺权限 / 端点必填配置缺失拒绝', () => {
    const validator = _validator();
    const ok = _proposal(PatchKind.TOOL, {
      name: 'listfiles',
      description: '列出文件',
      permissions: ['filesystem:read:/workspace'],
      endpoint: 'file_ops',
      endpoint_config: { root: '/workspace' },
    });
    expect(validator.validate(ok)).toEqual([]);
    const noPerms = _proposal(PatchKind.TOOL, {
      name: 't',
      description: 'x',
      permissions: [],
    });
    expect(validator.validate(noPerms).some((v) => v.includes('权限'))).toBe(true);
    const badEndpoint = _proposal(PatchKind.TOOL, {
      name: 't',
      description: 'x',
      permissions: ['filesystem:read:/w'],
      endpoint: 'file_ops',
      endpoint_config: {},
    });
    expect(validator.validate(badEndpoint).some((v) => v.includes('root'))).toBe(true);
  });

  it('命名规范断言（新增/自写工具统一执行）：下划线/超长命名 → 提案期拒绝', () => {
    const validator = _validator();
    const snake = _proposal(PatchKind.TOOL, {
      name: 'list_files',
      description: '列出文件',
      permissions: ['filesystem:read:/workspace'],
      endpoint: 'file_ops',
      endpoint_config: { root: '/workspace' },
    });
    const snakeViolations = validator.validate(snake);
    expect(
      snakeViolations.some(
        (v) => v.includes('违反命名规范') && v.includes('禁用字符'),
      ),
    ).toBe(true);
    const overlong = _proposal(PatchKind.TOOL, {
      name: 'x'.repeat(25),
      description: 'x',
      permissions: ['filesystem:read:/workspace'],
      endpoint: 'file_ops',
      endpoint_config: { root: '/workspace' },
    });
    expect(validator.validate(overlong).some((v) => v.includes('长度超限'))).toBe(true);
  });

  it('MCP 远程工具豁免命名断言（名字来自第三方服务器清单）', () => {
    const validator = _validator();
    const mcpTool = _proposal(PatchKind.TOOL, {
      name: 'web_search',
      description: '远程搜索工具',
      permissions: ['mcp:call:search_provider'],
      endpoint: 'mcp',
      endpoint_config: { server_id: 'search_provider' },
    });
    expect(validator.validate(mcpTool)).toEqual([]);
  });
});

describe('ProposalValidator.rule 补丁（规则声明解析校验）', () => {
  it('合法规则通过；缺 rule / 非法声明拒绝并附示例', () => {
    const validator = _validator();
    const ok = _proposal(PatchKind.RULE, {
      rule: {
        id: 'r1',
        predicate: 'equals',
        path: 'status',
        config: { value: 'active' },
        severity: 'warning',
        description: '状态须为激活',
      },
    });
    expect(validator.validate(ok)).toEqual([]);
    const missing = validator.validate(_proposal(PatchKind.RULE, {}));
    expect(missing[0]).toBe('rule 补丁缺 rule（规则声明 dict）');
    expect(missing.some((v) => v.includes('合法形态示例'))).toBe(true);
  });
});

describe('ProposalValidator.knowledge 补丁（知识条目构造 + 结构 schema）', () => {
  it('合法条目通过；层级非法拒绝', () => {
    const validator = _validator();
    const ok = _proposal(PatchKind.KNOWLEDGE, {
      entry: {
        id: 'k1',
        level: 'user',
        kind: 'rule',
        data: { rule: { id: 'k1', predicate: 'present', path: 'x' } },
        title: '领域规则',
        tags: ['写作'],
      },
    });
    expect(validator.validate(ok)).toEqual([]);
    const badLevel = _proposal(PatchKind.KNOWLEDGE, {
      entry: { id: 'k2', level: 'galaxy', kind: 'rule', data: {} },
    });
    expect(validator.validate(badLevel).some((v) => v.includes('层级非法'))).toBe(true);
  });

  it('注入 schema 校验对象 = entry_data（ENG1-16：data 内缺声明字段 = 违规）', () => {
    const dataSchema = new SchemaSpec({
      name: 'knowledge.data',
      fields: [
        new SchemaField({ name: 'rule', required: true, kind: FIELD_OBJECT }),
        new SchemaField({ name: 'note', required: true, kind: FIELD_STRING }),
      ],
    });
    const validator = new ProposalValidator({ knowledge_schema: dataSchema });
    // data 缺声明字段 note → 违规（schema 作用于 data，不含条目级字段）
    const missing = _proposal(PatchKind.KNOWLEDGE, {
      entry: {
        id: 'k1',
        level: 'user',
        kind: 'rule',
        data: { rule: { id: 'r1' } },
      },
    });
    const violations = validator.validate(missing);
    expect(violations.some((v) => v.includes('note'))).toBe(true);
    // data 形态合规 → 通过（条目级字段 id/level/kind 不参与该 schema）
    const ok = _proposal(PatchKind.KNOWLEDGE, {
      entry: {
        id: 'k1',
        level: 'user',
        kind: 'rule',
        data: { rule: { id: 'r1' }, note: '说明' },
      },
    });
    expect(validator.validate(ok)).toEqual([]);
    // kind=rule 的最小结构校验与 schema 校验并存（双闸不互斥）
    const badRule = _proposal(PatchKind.KNOWLEDGE, {
      entry: {
        id: 'k2',
        level: 'user',
        kind: 'rule',
        data: { note: '无 rule 声明' },
      },
    });
    expect(
      validator.validate(badRule).some((v) => v.includes('data 须含 dict 形态 rule')),
    ).toBe(true);
  });
});

describe('ProposalValidator.harness 补丁（harness 声明 + 图校验）', () => {
  it('合法 harness 通过；非法图定义拦截；缺 definition 拒绝', () => {
    const validator = _validator();
    const ok = _proposal(PatchKind.HARNESS, {
      definition: {
        name: 'novel',
        description: '小说领域',
        keywords: ['小说'],
        graph: null,
        tools: [],
      },
    });
    expect(validator.validate(ok)).toEqual([]);
    const badGraph = _proposal(PatchKind.HARNESS, {
      definition: {
        name: 'novel',
        description: 'x',
        graph: { name: 'g', entry: 'ghost', nodes: {}, edges: {} },
      },
    });
    const violations = validator.validate(badGraph);
    expect(violations.length > 0).toBe(true);
    const missing = validator.validate(_proposal(PatchKind.HARNESS, {}));
    expect(missing[0]).toBe('harness 补丁缺 definition（harness 声明 dict）');
    expect(missing.some((v) => v.includes('合法形态示例'))).toBe(true);
  });
});

describe('ProposalValidator.event_type 补丁（renderer 契约）', () => {
  it('合法事件通过；缺 name 拒绝；无 renderer 拒绝；system 豁免', () => {
    const validator = _validator();
    const ok = _proposal(PatchKind.EVENT_TYPE, {
      name: 'quest_start',
      renderer: 'QuestRow',
      system: false,
    });
    expect(validator.validate(ok)).toEqual([]);
    const violations = validator.validate(
      _proposal(PatchKind.EVENT_TYPE, { renderer: 'X' }),
    );
    expect(violations.length > 0).toBe(true);
    expect(violations[0]).toContain('缺 name');
    // 新事件类型必须带渲染组件（renderer 契约）：无 renderer = 拒绝注册
    const noRenderer = _proposal(PatchKind.EVENT_TYPE, {
      name: 'no_renderer_evt',
      system: false,
    });
    expect(validator.validate(noRenderer).some((v) => v.includes('renderer'))).toBe(true);
    // 系统信号不入回合步骤序列（装配器合成注入），豁免 renderer 要求
    const systemEvt = _proposal(PatchKind.EVENT_TYPE, {
      name: 'sys_signal',
      system: true,
    });
    expect(validator.validate(systemEvt)).toEqual([]);
  });
});

describe('ProposalValidator.environment 补丁（环境声明构造校验）', () => {
  it('合法环境通过；runtime 非法拒绝', () => {
    const validator = _validator();
    const ok = _proposal(PatchKind.ENVIRONMENT, {
      name: 'node_env',
      runtime: 'local',
      tools: ['node'],
      install_cmds: ['npm install -g pkg'],
    });
    expect(validator.validate(ok)).toEqual([]);
    const violations = validator.validate(
      _proposal(PatchKind.ENVIRONMENT, { name: 'e', runtime: 'docker' }),
    );
    expect(violations.length > 0).toBe(true);
    expect(violations[0]).toContain('runtime 非法');
  });
});

describe('ProposalValidator.artifact 补丁（产物哈希形态）', () => {
  it('sha256 hex 通过；短哈希拒绝', () => {
    const validator = _validator();
    const ok = _proposal(PatchKind.ARTIFACT, {
      artifact_id: 'js_bundle-abc123',
      kind: 'js_bundle',
      hashes: { 'index.js': 'a'.repeat(64) },
    });
    expect(validator.validate(ok)).toEqual([]);
    const shortHash = _proposal(PatchKind.ARTIFACT, {
      artifact_id: 'a',
      kind: 'js_bundle',
      hashes: { 'index.js': 'abc' },
    });
    expect(validator.validate(shortHash).some((v) => v.includes('sha256 hex'))).toBe(true);
  });
});

describe('ProposalValidator 违规清单附合法形态示例骨架', () => {
  it('tool 补丁违规附合法形态示例；无违规不附', () => {
    const validator = _validator();
    const badTool = _proposal(PatchKind.TOOL, {
      name: 't',
      description: 'x',
      permissions: [],
    });
    const violations = validator.validate(badTool);
    const exampleLines = violations.filter((v) => v.startsWith('合法形态示例: '));
    expect(exampleLines.length > 0).toBe(true);
    expect(exampleLines[0]!.includes('endpoint')).toBe(true);
    expect(exampleLines[0]!.includes('permissions')).toBe(true);

    const okTool = _proposal(PatchKind.TOOL, {
      name: 'listfiles',
      description: '列出文件',
      permissions: ['filesystem:read:/workspace'],
      endpoint: 'file_ops',
      endpoint_config: { root: '/workspace' },
    });
    expect(validator.validate(okTool)).toEqual([]);
  });
});
