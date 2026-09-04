/**
 * core/uiSchema.ts 测试：序列化往返 + 结构校验 + 三层白名单门禁——
 * 对标 pytest test_ui_schema.py。
 *
 * 覆盖：UIBind/UINode/UISpec 序列化往返、非法结构显式拒绝（类型/缺
 * type/绑定声明非法）、校验器语义（root 缺失、组件白名单、绑定通道
 * 白名单、主题 token 白名单、component 携带 children、递归违规路径
 * 报告）、渲染器接口结构可检查。
 */

import { describe, expect, it } from 'vitest';

import { GraphDefinitionError } from '../../../src/core/errors.js';
import {
  BIND_CHANNEL_KEY,
  BIND_KEY,
  DEFAULT_BIND_CHANNELS,
  NODE_KIND_COMPONENT,
  NODE_KIND_CONTAINER,
  UIBind,
  UINode,
  UIRenderer,
  UISchemaValidator,
  UISpec,
} from '../../../src/core/ui_schema/uiSchema.js';

const BIND_PATH_KEY = 'path';

const VALID_LAYOUT = {
  name: 'boot.panel',
  version: 3,
  root: {
    kind: NODE_KIND_CONTAINER,
    type: 'column',
    children: [
      {
        kind: NODE_KIND_COMPONENT,
        type: 'text',
        props: { content: '你好' },
        [BIND_KEY]: { [BIND_CHANNEL_KEY]: 'state', path: 'round.title' },
      },
      { kind: NODE_KIND_COMPONENT, type: 'input', props: {} },
    ],
  },
  theme: { bg: '#111', accent: '#3b82f6' },
};

const ALLOWED_COMPONENTS = ['text', 'input', 'column'];
const ALLOWED_CHANNELS = DEFAULT_BIND_CHANNELS;
const ALLOWED_TOKENS = ['bg', 'fg', 'accent'];

function validator(): UISchemaValidator {
  return new UISchemaValidator();
}

/** pytest.raises(GraphDefinitionError, match=...) 的 TS 对应：类型 + 消息。 */
function expectGraphError(fn: () => unknown, match: RegExp): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(GraphDefinitionError);
  expect((caught as Error).message).toMatch(match);
}

describe('UIBind 数据绑定', () => {
  it('round-trip 往返保持（channel/path）', () => {
    const bind = new UIBind({ channel: 'state', path: 'round.count' });
    const restored = UIBind.from_dict(bind.to_dict());
    expect(restored.channel).toBe('state');
    expect(restored.path).toBe('round.count');
    expect(restored.to_dict()).toEqual(bind.to_dict());
  });

  it('非法声明显式拒绝（缺 channel / 路径非字符串）', () => {
    expectGraphError(() => UIBind.from_dict({ [BIND_PATH_KEY]: 'x' }), /缺 channel/);
    expectGraphError(
      () => UIBind.from_dict({ [BIND_CHANNEL_KEY]: 'state', [BIND_PATH_KEY]: 7 }),
      /绑定路径非法/,
    );
  });
});

describe('UINode 布局节点', () => {
  it('嵌套节点 round-trip 往返保持', () => {
    const node = new UINode({
      kind: NODE_KIND_CONTAINER,
      type: 'column',
      children: [
        new UINode({ kind: NODE_KIND_COMPONENT, type: 'text', props: { content: 'a' } }),
        new UINode({
          kind: NODE_KIND_CONTAINER,
          type: 'row',
          children: [new UINode({ kind: NODE_KIND_COMPONENT, type: 'input' })],
        }),
      ],
    });
    const restored = UINode.from_dict(node.to_dict());
    expect(restored.to_dict()).toEqual(node.to_dict());
  });

  it('非法 kind 显式拒绝', () => {
    expectGraphError(() => UINode.from_dict({ kind: 'magic', type: 'x' }), /布局节点类型非法/);
  });

  it('缺 type 显式拒绝', () => {
    expectGraphError(() => UINode.from_dict({ kind: NODE_KIND_COMPONENT }), /缺 type/);
  });
});

describe('UISpec 界面描述', () => {
  it('合法描述 round-trip 往返保持', () => {
    const spec = UISpec.from_dict(VALID_LAYOUT);
    expect(spec.name).toBe('boot.panel');
    expect(spec.version).toBe(3);
    expect(spec.root).not.toBeNull();
    expect(spec.root!.kind).toBe(NODE_KIND_CONTAINER);
    expect(spec.theme).toEqual({ bg: '#111', accent: '#3b82f6' });
    expect(spec.root!.children[0]!.bind).not.toBeNull();
    expect(spec.root!.children[0]!.bind!.channel).toBe('state');
    expect(UISpec.from_dict(spec.to_dict()).to_dict()).toEqual(spec.to_dict());
  });

  it('未定形界面（root 缺省）round-trip 保持', () => {
    const spec = new UISpec({ name: 'boot.panel' });
    const restored = UISpec.from_dict(spec.to_dict());
    expect(restored.root).toBeNull();
    expect(restored.to_dict()).toEqual({ name: 'boot.panel', version: 1 });
  });

  it('非法描述显式拒绝（缺 name / theme 非 dict）', () => {
    expectGraphError(() => UISpec.from_dict({ root: null }), /缺 name/);
    expectGraphError(() => UISpec.from_dict({ name: 'x', theme: 'dark' }), /theme 须为 dict/);
  });
});

describe('UISchemaValidator 校验语义', () => {
  it('三层白名单齐备的合法界面零违规', () => {
    const violations = validator().validate(VALID_LAYOUT, {
      allowed_components: ALLOWED_COMPONENTS,
      allowed_channels: ALLOWED_CHANNELS,
      allowed_theme_tokens: ALLOWED_TOKENS,
    });
    expect(violations).toEqual([]);
  });

  it('validate_ok 布尔判定入口', () => {
    expect(
      validator().validate_ok(VALID_LAYOUT, {
        allowed_components: ALLOWED_COMPONENTS,
        allowed_channels: ALLOWED_CHANNELS,
        allowed_theme_tokens: ALLOWED_TOKENS,
      }),
    ).toBe(true);
  });

  it('缺 root → 违规', () => {
    const violations = validator().validate(
      { name: 'x' },
      { allowed_components: ALLOWED_COMPONENTS },
    );
    expect(violations[0]).toContain('缺 root');
  });

  it('组件白名单：未注册组件 = 违规不渲染', () => {
    const layout = {
      root: {
        kind: NODE_KIND_COMPONENT,
        type: 'shell_exec',
        props: { command: 'rm -rf /' },
      },
    };
    const violations = validator().validate(layout, {
      allowed_components: ['text'],
      allowed_channels: ALLOWED_CHANNELS,
    });
    expect(violations.some((v) => v.includes('组件未注册') && v.includes('shell_exec'))).toBe(true);
  });

  it('绑定白名单：内部通道（如 approval）不放行', () => {
    const layout = {
      root: {
        kind: NODE_KIND_COMPONENT,
        type: 'text',
        [BIND_KEY]: { [BIND_CHANNEL_KEY]: 'approval', path: 'secret' },
      },
    };
    const violations = validator().validate(layout, {
      allowed_components: ['text'],
      allowed_channels: ALLOWED_CHANNELS,
    });
    expect(
      violations.some((v) => v.includes('bind.channel 未放行') && v.includes('approval')),
    ).toBe(true);
  });

  it('绑定路径保留前缀（_ 开头段）拒绝；常规路径不受影响', () => {
    const layout = {
      root: {
        kind: NODE_KIND_COMPONENT,
        type: 'text',
        [BIND_KEY]: { [BIND_CHANNEL_KEY]: 'state', path: '_internal.patch_chain' },
      },
    };
    const violations = validator().validate(layout, {
      allowed_components: ['text'],
      allowed_channels: ALLOWED_CHANNELS,
    });
    expect(
      violations.some((v) => v.includes('bind.path 命中保留前缀') && v.includes('_internal')),
    ).toBe(true);

    const okLayout = {
      root: {
        kind: NODE_KIND_COMPONENT,
        type: 'text',
        [BIND_KEY]: { [BIND_CHANNEL_KEY]: 'state', path: 'round.current' },
      },
    };
    expect(
      validator().validate_ok(okLayout, {
        allowed_components: ['text'],
        allowed_channels: ALLOWED_CHANNELS,
      }),
    ).toBe(true);
  });

  it('主题白名单：未声明 token = 违规', () => {
    const layout = { root: null, theme: { evil_style: 'url(//x)' } };
    const violations = validator().validate(layout, {
      allowed_theme_tokens: ALLOWED_TOKENS,
    });
    expect(
      violations.some((v) => v.includes('theme token 未声明') && v.includes('evil_style')),
    ).toBe(true);
  });

  it('component 携带 children = 违规', () => {
    const layout = {
      root: {
        kind: NODE_KIND_COMPONENT,
        type: 'text',
        children: [{ kind: NODE_KIND_COMPONENT, type: 'input' }],
      },
    };
    const violations = validator().validate(layout, {
      allowed_components: ['text', 'input'],
      allowed_channels: ALLOWED_CHANNELS,
    });
    expect(violations.some((v) => v.includes('不允许携带 children'))).toBe(true);
  });

  it('递归违规带节点路径（root.children[1].type）', () => {
    const layout = {
      root: {
        kind: NODE_KIND_CONTAINER,
        type: 'column',
        children: [
          { kind: NODE_KIND_COMPONENT, type: 'text' },
          { kind: NODE_KIND_COMPONENT, type: 'unknown_component' },
        ],
      },
    };
    const violations = validator().validate(layout, {
      allowed_components: ['text'],
      allowed_channels: ALLOWED_CHANNELS,
    });
    expect(violations.some((v) => v.includes('root.children[1].type'))).toBe(true);
  });

  it('缺省白名单 fail-closed：未传组件白名单 = 任何组件不放行', () => {
    const layout = { root: { kind: NODE_KIND_COMPONENT, type: 'text' } };
    const violations = validator().validate(layout);
    expect(violations.some((v) => v.includes('组件未注册'))).toBe(true);
  });

  it('未知字段忽略（schema 演进宽容）', () => {
    const layout = { ...VALID_LAYOUT, extra_field: { anything: true } };
    const violations = validator().validate(layout, {
      allowed_components: ALLOWED_COMPONENTS,
      allowed_channels: ALLOWED_CHANNELS,
      allowed_theme_tokens: ALLOWED_TOKENS,
    });
    expect(violations).toEqual([]);
  });
});

describe('UIRenderer 渲染器接口', () => {
  it('结构可检查（实现须可被识别为 UIRenderer）', () => {
    class BootRenderer {
      render(spec: UISpec): string {
        return `render:${spec.name}`;
      }
    }
    const renderer: UIRenderer = new BootRenderer();
    expect(renderer.render(new UISpec({ name: 'boot.panel' }))).toBe('render:boot.panel');
  });
});
