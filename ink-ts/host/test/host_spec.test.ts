import { describe, expect, it } from 'vitest';

import {
  findHostsRoot,
  hostPortHas,
  loadHostSpec,
  validateHostSpec,
  type HostSpec,
} from '../src/host_spec.js';

function baseSpec(): HostSpec {
  return {
    id: 'cli',
    kind: 'host',
    capability: 'host_tool',
    implemented: true,
    host: {
      surface: 'cli',
      transport: ['terminal', 'stdio'],
      approval: 'interactive',
      ports: {
        storage: ['sqlite', 'memory'],
        llm: ['llm_port'],
        exec: ['exec_envelope'],
        approval: ['interactive', 'flag'],
      },
    },
    renderer: { target: 'host', entry: 'cli/src/tui' },
  };
}

describe('host_spec', () => {
  it('findHostsRoot 从 cwd 探测到仓库根 hosts/', () => {
    const root = findHostsRoot();
    expect(root).not.toBeNull();
    expect(root).toBe(process.cwd());
  });

  it('loadHostSpec 读取 cli/web 并校验', () => {
    const cli = loadHostSpec('cli');
    expect(cli.host.surface).toBe('cli');
    expect(cli.implemented).toBe(true);
    expect(cli.renderer?.entry).toBe('cli/src/tui');
    const web = loadHostSpec('web');
    expect(web.host.surface).toBe('web');
    expect(web.host.transport).toContain('http+ws');
  });

  it('hostPortHas 按端口形状查询', () => {
    const spec = loadHostSpec('cli');
    expect(hostPortHas(spec, 'storage', 'sqlite')).toBe(true);
    expect(hostPortHas(spec, 'storage', 'postgres')).toBe(false);
    expect(hostPortHas(spec, 'llm', 'llm_port')).toBe(true);
  });

  it('validateHostSpec 拒绝非法面/端口', () => {
    const badSurface = baseSpec();
    badSurface.host.surface = 'desktop' as never;
    expect(() => validateHostSpec(badSurface)).toThrow(/surface 非法/);

    const badPorts = baseSpec();
    delete (badPorts.host.ports as Partial<typeof badPorts.host.ports>).exec;
    expect(() => validateHostSpec(badPorts)).toThrow(/ports\.exec/);

    const noNote = baseSpec();
    noNote.implemented = false;
    noNote.note = undefined;
    expect(() => validateHostSpec(noNote)).toThrow(/implemented=false/);
  });
});
