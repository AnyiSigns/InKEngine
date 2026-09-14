import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  ARCH_VERSION,
  currentArch,
  readWeightsJson,
  writeWeightsJson,
  type WeightsFile,
} from '../controller/checkpoint.js';
import { H, Policy } from '../controller/policy.js';
import { ACT_DIM, OBS_DIM } from '../controller/features.js';
import { GRAPH } from '../runner/graph.js';

const work = mkdtempSync(join(tmpdir(), 'dgl-ckpt-'));
const ROUTING_SAMPLE = ['add3', 'mul2', 'mod7', 'exit'];
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

// 确定性临时名：mkdtemp 目录名即进程内唯一串，自增计数器保证同进程不碰撞——
// 替代 Math.random()（G0.1 口径：测试也不许引未播种随机源）。
const WORK_BASE = basename(work);
let tmpSeq = 0;
function tmpName(tag: string): string {
  tmpSeq += 1;
  return join(work, `${tag}-${WORK_BASE}-${String(tmpSeq).padStart(3, '0')}.json`);
}

function toPlain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function validFile(): { file: WeightsFile; path: string } {
  const p = Policy.random(9, 'lang', 'progress');
  const path = tmpName('valid');
  p.save(path, { seed: 9, code_hash: 'ffff0000' });
  return { file: readWeightsJson(path), path };
}

describe('arch 契约（跨语言唯一权重建）', () => {
  it('规范串格式与三套特征集取值', () => {
    expect(ARCH_VERSION).toBe(4);
    expect(currentArch('lang', 'progress')).toBe('v4:lang:867:83:128:progress');
    expect(currentArch('hash_only', 'none')).toBe(`v4:hash_only:${OBS_DIM.hash_only}:${ACT_DIM}:${H}:none`);
    expect(currentArch('struct', 'progress')).toContain(':struct:875:');
  });

  it('写→读往返参数逐位一致；Policy.load 后行为与保存方一致', () => {
    const p = Policy.random(9, 'hash_only');
    const path = tmpName('roundtrip');
    p.save(path);
    const f = readWeightsJson(path);
    expect(f.arch).toBe(currentArch('hash_only', 'progress'));
    expect(f.dims.featureSet).toBe('hash_only');
    expect(f.dims.obsDim).toBe(671);
    expect(f.params.wo.data).toEqual(p.params.wo.data);
    expect(f.params.ws.data).toEqual(p.params.ws.data);
    expect(f.params.wo.data.length).toBe(H * 671);
    expect(f.train_meta).toEqual({});
    const q = Policy.load(path, { featureSet: 'hash_only', head: 'progress' });
    const obs = { x: 3, answer: null, verdict: null, hist: ['add3'] };
    const instr = '加三然后翻倍';
    expect(q.act(instr, obs, ROUTING_SAMPLE, GRAPH)).toBe(p.act(instr, obs, ROUTING_SAMPLE, GRAPH));
  });

  it('head=none 的空 critic 参数也往返一致', () => {
    const p = Policy.random(2, 'lang', 'none');
    expect(p.params.wp.data.length).toBe(0);
    expect(p.params.bp.data.length).toBe(0);
    const path = tmpName('none-head');
    p.save(path);
    const f = readWeightsJson(path, { head: 'none' });
    expect(f.dims.head).toBe('none');
    expect(() => Policy.load(path).progressHead(new Float32Array(OBS_DIM.lang))).toThrow(/head=none/);
    expect(() => Policy.load(path, { head: 'progress' })).toThrow(/head/);
  });
});

describe('fail-fast 审计（禁跨版本静默加载）', () => {
  it('arch 篡改一位 → read throw', () => {
    const { path } = validFile();
    const raw = readFileSync(path, 'utf8').replace('"v4:lang:867', '"v4:lang:868');
    const bad = tmpName('arch');
    writeFileSync(bad, raw, 'utf8');
    expect(() => readWeightsJson(bad)).toThrow(/arch/);
  });

  it('dims 与 arch 不自洽 → write 与 read 都 throw', () => {
    const { file } = validFile();
    const skewed = { ...file, dims: { ...file.dims, head: 'none' } } as WeightsFile;
    expect(() => writeWeightsJson(tmpName('skew-w'), skewed)).toThrow(/arch/);
    const skewed2 = { ...file, dims: { ...file.dims, obsDim: 123 } } as WeightsFile;
    expect(() => writeWeightsJson(tmpName('skew-w2'), skewed2)).toThrow(/obsDim/);
    const onDisk = tmpName('skew-r');
    writeFileSync(onDisk, JSON.stringify(skewed), 'utf8');
    expect(() => readWeightsJson(onDisk)).toThrow(/arch/);
  });

  it('data 长度与 shape 不符 → throw', () => {
    const { file } = validFile();
    const short = toPlain(file) as WeightsFile;
    (short.params.bo as unknown as { data: number[] }).data = [1, 2];
    expect(() => writeWeightsJson(tmpName('short'), short)).toThrow(/params\.bo\.data/);
  });

  it('NaN/Inf 注入：write 前拒绝；落盘退化成 null 后 read 也拒绝', () => {
    const { file } = validFile();
    const poison = toPlain(file) as WeightsFile;
    (poison.params.ws as unknown as { data: number[] }).data[0] = Number.NaN;
    expect(() => writeWeightsJson(tmpName('nan-w'), poison)).toThrow(/params\.ws\.data/);
    const onDisk = tmpName('nan-r');
    const obj = toPlain(file) as unknown as { params: { ws: { data: number[] } } };
    obj.params.ws.data[0] = Number.POSITIVE_INFINITY;
    writeFileSync(onDisk, JSON.stringify(obj), 'utf8');
    expect(() => readWeightsJson(onDisk)).toThrow(/params\.ws\.data/);
  });

  it('float32 执法：非 f32 精确值 write 前拒绝；原样落盘后 read 也拒绝', () => {
    const { file } = validFile();
    const dirty = toPlain(file) as WeightsFile;
    (dirty.params.wo as unknown as { data: number[] }).data[0] = 1 / 3;
    expect(() => writeWeightsJson(tmpName('f32-w'), dirty)).toThrow(/params\.wo\.data\[0]/);
    const onDisk = tmpName('f32-r');
    writeFileSync(onDisk, JSON.stringify(dirty), 'utf8');
    expect(() => readWeightsJson(onDisk)).toThrow(/params\.wo\.data\[0]/);
  });

  it('expect 指定 featureSet/head 不符 → throw；缺字段与坏文件 → throw 含路径', () => {
    const { path } = validFile();
    expect(() => readWeightsJson(path, { featureSet: 'struct' })).toThrow(/featureSet/);
    expect(() => readWeightsJson(path, { featureSet: 'lang', head: 'none' })).toThrow(/head/);
    const missing = tmpName('missing');
    const obj = toPlain(readWeightsJson(path)) as unknown as Record<string, unknown>;
    delete (obj.dims as Record<string, unknown>).h;
    writeFileSync(missing, JSON.stringify(obj), 'utf8');
    expect(() => readWeightsJson(missing)).toThrow(/dims\.h/);
    const gone = join(work, 'nope.json');
    expect(() => readWeightsJson(gone)).toThrow(/nope\.json/);
    const garbage = tmpName('garbage');
    writeFileSync(garbage, '{not json', 'utf8');
    expect(() => readWeightsJson(garbage)).toThrow(/JSON/);
  });
});
