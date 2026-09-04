/**
 * 工具可信度闸门单测：清单校验 + 静态审查 + 影子运行观察模式——逐点对标
 * ink_engine/tests/test_tool_vetting.py（os/shutil/tempfile 动作已 seam
 * 化注入，见 src/core/tool_vetting/_types.ts 的 FsSeam）。
 *
 * 覆盖：清单序列化往返与非法拒绝、未知来源签名缺失拒绝、权限声明非法
 * 拒绝、静态审查钩子命中（review/strict rejected）、钩子异常 = 违规、
 * 全部通过 verified、影子运行缺工作区失败 + 零写 plumbing（untrusted
 * 恒真）、code_files_exist 前置钩子与默认附加（ENG6-7 回归）。
 *
 * 延后用例（真实 fs/tempdir/executor 属宿主 seam）：静态钩子读真实文件、
 * shadow_run 写虚拟化 diff（新增/修改/删除）与 async executor 写影子目录
 * 的实弹用例——需注入真实文件系统实现（node:fs 后端）后方可对标；届时
 * FakeFs 换宿主 fs 即可，机制断言不变。
 */
import { describe, expect, it } from 'vitest';

import { GraphDefinitionError } from '../../../src/core/errors.js';
import {
  ToolManifest,
  ToolSource,
  ToolVetting,
  VettingVerdict,
  code_files_exist,
} from '../../../src/core/tool_vetting/tool_vetting.js';
import type { FsSeam } from '../../../src/core/tool_vetting/_types.js';

/** 内存 FsSeam 假体：默认全抛错，测试按需覆写（未触达动作不实现）。 */
function fakeFs(overrides: Partial<FsSeam>): FsSeam {
  const raise = (): never => {
    throw new Error('FakeFs 未实现的 seam 动作被触达');
  };
  const base: FsSeam = {
    mkdtemp: raise,
    rmtree: raise,
    is_dir: raise,
    is_file: raise,
    is_symlink: raise,
    readlink: raise,
    copy2: raise,
    symlink_to: raise,
    mkdir: raise,
    iterdir: raise,
    rglob: raise,
    stat_size: raise,
  };
  return { ...base, ...overrides };
}

/** 断言调用抛 GraphDefinitionError 且消息命中模式（Python pytest.raises 镜像）。 */
function graphError(fn: () => unknown, pattern: RegExp): Error {
  let thrown: unknown;
  try {
    fn();
  } catch (exc) {
    thrown = exc;
  }
  expect(thrown).toBeInstanceOf(GraphDefinitionError);
  expect((thrown as Error).message).toMatch(pattern);
  return thrown as Error;
}

/** Python 测试的 _manifest 辅助：市场来源 + 签名 + 64 位哈希 + 权限声明。 */
function makeManifest(overrides: { [key: string]: unknown } = {}): ToolManifest {
  const data: { [key: string]: unknown } = {
    name: 'search_web',
    source: 'market',
    signature: 'signed-by-vendor',
    hashes: { 'search.py': 'a'.repeat(64) },
    permissions: ['network:connect:*.search.com'],
    dependencies: ['requests>=2'],
    meta: { author: 'vendor' },
  };
  Object.assign(data, overrides);
  return ToolManifest.from_dict(data);
}

describe('清单校验（ToolManifest）', () => {
  it('序列化往返还原（to_dict → from_dict）', () => {
    const manifest = makeManifest();
    const restored = ToolManifest.from_dict(manifest.to_dict());
    expect(restored.to_dict()).toEqual(manifest.to_dict());
    expect(restored.source).toBe(ToolSource.MARKET);
  });

  it('非法清单拒绝（缺 name/来源分类非法/哈希声明非法）', () => {
    graphError(() => ToolManifest.from_dict({ source: 'market' }), /缺 name/);
    graphError(() => ToolManifest.from_dict({ name: 't', source: 'tor' }), /来源分类非法/);
    graphError(() => ToolManifest.from_dict({ name: 't', hashes: { 'a.py': 42 } }), /哈希声明非法/);
  });
});

describe('vet：清单闸门 fail-closed', () => {
  it('未知来源且无签名 = rejected（签名缺失拒绝）', async () => {
    const vetting = new ToolVetting();
    const result = await vetting.vet(
      new ToolManifest({ name: 'ghost', source: ToolSource.UNKNOWN }),
    );
    expect(result.ok).toBe(false);
    expect(result.verdict).toBe(VettingVerdict.REJECTED);
    expect(result.reason).toContain('签名缺失拒绝');
  });

  it('权限声明逐项解析非法 = rejected', async () => {
    const vetting = new ToolVetting();
    const result = await vetting.vet(makeManifest({ permissions: ['not-a-valid-permission'] }));
    expect(result.verdict).toBe(VettingVerdict.REJECTED);
    expect(result.checks.some((check) => check.detail.includes('权限声明非法'))).toBe(true);
  });

  it('未声明权限 = rejected（fail-closed）', async () => {
    const vetting = new ToolVetting();
    const result = await vetting.vet(makeManifest({ permissions: [] }));
    expect(result.verdict).toBe(VettingVerdict.REJECTED);
    expect(result.reason).toContain('未声明权限');
  });

  it('全过 = verified', async () => {
    const vetting = new ToolVetting();
    const result = await vetting.vet(makeManifest());
    expect(result.ok).toBe(true);
    expect(result.verdict).toBe(VettingVerdict.VERIFIED);
  });
});

describe('vet：静态审查命中判定', () => {
  const SOURCE = 'tool.py';

  it('钩子命中默认降级 review（可人工放行，非严格）', async () => {
    const files = new Set([SOURCE]);
    const vetting = new ToolVetting({
      fs: fakeFs({ is_file: (p) => files.has(p) }),
      static_hooks: [
        (paths) =>
          paths.filter((p) => p === SOURCE).map((p) => `${p}: 命中恶意模式 os.system`),
      ],
    });
    const result = await vetting.vet(makeManifest(), [SOURCE]);
    expect(result.ok).toBe(true);
    expect(result.verdict).toBe(VettingVerdict.REVIEW);
    expect(result.reason).toContain('恶意模式');
  });

  it('strict 钩子命中 = rejected（高危形态）', async () => {
    const files = new Set([SOURCE]);
    const vetting = new ToolVetting({
      fs: fakeFs({ is_file: (p) => files.has(p) }),
      static_hooks: [(paths) => paths.filter((p) => p === SOURCE).map((p) => `${p}: 命中 eval`)],
    });
    const result = await vetting.vet(makeManifest(), [SOURCE], { strict: true });
    expect(result.ok).toBe(false);
    expect(result.verdict).toBe(VettingVerdict.REJECTED);
  });

  it('钩子抛异常 = 违规降级 review', async () => {
    const files = new Set([SOURCE]);
    const vetting = new ToolVetting({
      fs: fakeFs({ is_file: (p) => files.has(p) }),
      static_hooks: [
        () => {
          throw new Error('扫描器崩溃');
        },
      ],
    });
    const result = await vetting.vet(makeManifest(), [SOURCE]);
    expect(result.verdict).toBe(VettingVerdict.REVIEW);
    expect(result.reason).toContain('扫描器崩溃');
  });
});

describe('shadow_run：观察模式（写虚拟化属真实 fs seam，此处验机制环）', () => {
  it('工作区缺失 = ok False（不含任何文件面动作）', async () => {
    const vetting = new ToolVetting({ fs: fakeFs({ is_dir: () => false }) });
    const result = await vetting.shadow_run(() => 'x', {}, { workdir: 'nope' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('不存在');
  });

  it('零写运行：副本快照 diff 为空，结果恒 untrusted', async () => {
    const workdir = '/mem/real-work';
    const vetting = new ToolVetting({
      fs: fakeFs({
        is_dir: (p) => p === workdir,
        mkdtemp: () => 'mem://forge-shadow-1',
        mkdir: () => undefined,
        iterdir: (p) => (p === workdir ? [] : []),
        rglob: () => [],
        rmtree: () => undefined,
      }),
    });
    const result = await vetting.shadow_run(() => 'done', {}, { workdir });
    expect(result.ok).toBe(true);
    expect(result.writes).toEqual([]);
    expect(result.output).toBe('done');
    expect(result.untrusted).toBe(true);
  });
});

describe('code_files_exist：存在性前置钩子', () => {
  it('缺失文件 → 违规清单（存在性经注入 fs 判定）', () => {
    const fs = fakeFs({ is_file: (p) => p === 'ok.py' });
    const result = code_files_exist(['ok.py', 'missing.py'], fs);
    expect(result.length).toBe(1);
    expect(result[0]).toContain('missing.py');
  });

  it('ENG6-7 回归：默认附加 code_files_exist——静态审查默认非空操作', async () => {
    const source = 't.py';
    const files = new Set([source]);
    const fs = fakeFs({ is_file: (p) => files.has(p) });
    const manifest = makeManifest();
    const vetting = new ToolVetting({ fs });
    const clean = await vetting.vet(manifest, [source]);
    expect(clean.verdict).toBe(VettingVerdict.VERIFIED);
    const missing = await vetting.vet(manifest, ['ghost.py']);
    expect(missing.verdict).toBe(VettingVerdict.REVIEW);
    expect(missing.checks.some((check) => check.detail.includes('代码文件缺失'))).toBe(true);
    // 宿主注入钩子时存在性校验仍保留（叠加）
    const vetting2 = new ToolVetting({ fs, static_hooks: [() => []] });
    const result = await vetting2.vet(manifest, ['ghost.py']);
    expect(result.verdict).toBe(VettingVerdict.REVIEW);
  });
});
