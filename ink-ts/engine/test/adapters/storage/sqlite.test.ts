// gate: 超限(365 行) - sqlite 全后端行为契约单文件成组（版本链/事件/records/序列化 marker），便于对照 pytest 参数化
/**
 * SqliteStorage 后端行为测试（:memory: 库）：checkpoint 版本链 + 乐观锁、链一致性不变量、
 * 事件日志 append-only + 截断、structured records、安全剥离与 marker 内联还原。对标 pytest
 * test_storage.py 中 sqlite 参数化的行为用例；真实文件/temp 用例在 sqlite_file.test.ts。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CheckpointConflictError, StorageError } from '../../../src/core/errors.js';
import { EngineEvent } from '../../../src/core/events/events.js';
import { Message, ToolCall } from '../../../src/core/llm/messages.js';
import { PatchChain } from '../../../src/core/patch/patchChain.js';
import type { JsonRecord } from '../../../src/core/json.js';
import { validate_chain } from '../../../src/core/storage/storage.js';
import { CheckpointRecord } from '../../../src/core/storage/storage_records.js';
import { SqliteStorage } from '../../../src/adapters/storage/sqlite.js';

type CpInit = ConstructorParameters<typeof CheckpointRecord>[0];

/** 便捷构造：默认 t1/n1 链上 checkpoint（镜像 Python _cp）。 */
function cp(init: Partial<CpInit> = {}): CheckpointRecord {
  return new CheckpointRecord({ ...{ checkpoint_id: 0, thread_id: 't1', node: 'n1' }, ...init } as CpInit);
}

function nextCp(parentId: number, state: JsonRecord, extra: Partial<CpInit> = {}): CheckpointRecord {
  return new CheckpointRecord({
    ...{ checkpoint_id: 0, thread_id: 't1', node: 'n2', state, parent_id: parentId },
    ...extra,
  } as CpInit);
}

describe('sqlite checkpoint 版本链', () => {
  let s: SqliteStorage;
  beforeEach(() => {
    s = new SqliteStorage(':memory:');
  });
  afterEach(async () => {
    await s.close();
  });

  it('create and get 往返', async () => {
    const rec = await s.put_checkpoint(cp({ state: { a: 1 } }));
    expect(rec.checkpoint_id).toBeGreaterThan(0);
    const got = await s.get_checkpoint(rec.checkpoint_id);
    expect(got).not.toBeNull();
    expect(got!.state).toEqual({ a: 1 });
    expect(got!.node).toBe('n1');
  });

  it('latest 与 list（按 id 降序）', async () => {
    const c1 = await s.put_checkpoint(cp({ state: { v: 1 } }));
    const c2 = await s.put_checkpoint(nextCp(c1.checkpoint_id, { v: 2 }));
    const latest = await s.get_latest_checkpoint('t1');
    expect(latest!.checkpoint_id).toBe(c2.checkpoint_id);
    const cps = await s.list_checkpoints('t1');
    expect(cps.map((c) => c.checkpoint_id)).toEqual([c2.checkpoint_id, c1.checkpoint_id]);
  });

  it('乐观锁：期望版本匹配 → version+1；冲突 → CheckpointConflictError', async () => {
    const rec = await s.put_checkpoint(cp({ state: { v: 1 } }));
    const updated = await s.put_checkpoint(
      cp({ checkpoint_id: rec.checkpoint_id, state: { v: 2 }, version: rec.version }),
      { expected_version: rec.version },
    );
    expect(updated.version).toBe(rec.version + 1);
    await expect(
      s.put_checkpoint(
        cp({ checkpoint_id: rec.checkpoint_id, state: { v: 3 }, version: rec.version }),
        { expected_version: rec.version },
      ),
    ).rejects.toBeInstanceOf(CheckpointConflictError);
    // 更新路径父指针不可变（注入非法 parent_id 被忽略）
    const child = await s.put_checkpoint(cp({ state: { v: 9 }, parent_id: rec.checkpoint_id }));
    const updatedChild = await s.put_checkpoint(
      cp({ checkpoint_id: child.checkpoint_id, state: { v: 10 }, parent_id: 999, version: child.version }),
      { expected_version: child.version },
    );
    expect(updatedChild.parent_id).toBe(rec.checkpoint_id);
    const got = await s.get_checkpoint(child.checkpoint_id);
    expect(got!.parent_id).toBe(rec.checkpoint_id);
    expect(await validate_chain(s, 't1')).toEqual([]);
  });

  it('expected_version=None 时自动读当前版本', async () => {
    const rec = await s.put_checkpoint(cp({ state: { v: 1 } }));
    const updated = await s.put_checkpoint(
      cp({ checkpoint_id: rec.checkpoint_id, state: { v: 2 }, version: rec.version }),
    );
    expect(updated.version).toBe(rec.version + 1);
  });

  it('异线程 checkpoint_id 更新被拒：不迁移线程（WHERE thread_id 归属校验）', async () => {
    const c1 = await s.put_checkpoint(cp({ state: { v: 1 } }));
    await expect(
      s.put_checkpoint(
        cp({ checkpoint_id: c1.checkpoint_id, thread_id: 't2', state: { v: 2 }, version: c1.version }),
      ),
    ).rejects.toBeInstanceOf(CheckpointConflictError);
    await expect(
      s.put_checkpoint(
        cp({ checkpoint_id: c1.checkpoint_id, thread_id: 't2', state: { v: 2 }, version: c1.version }),
      ),
    ).rejects.toThrow(/归属他线程/);
    const got = await s.get_checkpoint(c1.checkpoint_id);
    expect(got!.thread_id).toBe('t1');
    expect(await s.get_latest_checkpoint('t2')).toBeNull();
  });

  it('链尾已前进时续链冲突；fork=True 允许指向历史链节点', async () => {
    const c1 = await s.put_checkpoint(cp({ state: { v: 1 } }));
    const c2 = await s.put_checkpoint(nextCp(c1.checkpoint_id, { v: 2 }));
    // 期望链尾 = c1 但实际已是 c2 → 冲突
    await expect(s.put_checkpoint(nextCp(c1.checkpoint_id, { v: 3 }))).rejects.toBeInstanceOf(
      CheckpointConflictError,
    );
    const forkRec = await s.put_checkpoint(nextCp(c1.checkpoint_id, { v: 3 }), { fork: true });
    expect(forkRec.checkpoint_id).toBeGreaterThan(c2.checkpoint_id);
  });

  it('error 字段 roundtrip（reason=error 携带脱敏错误消息）', async () => {
    const rec = await s.put_checkpoint(
      cp({ state: { v: 1 }, reason: 'error', error: '节点执行失败: a' }),
    );
    const got = await s.get_checkpoint(rec.checkpoint_id);
    expect(got!.reason).toBe('error');
    expect(got!.error).toBe('节点执行失败: a');
  });

  it('graph_version + plan 三字段持久化（插入/守卫续链/更新路径）', async () => {
    const plan = { steps: [{ nodes: ['a'] }, { nodes: ['b'] }], index: 1 };
    const rec = await s.put_checkpoint(cp({ state: { v: 1 }, graph_version: 'a'.repeat(64), plan }));
    const got = await s.get_checkpoint(rec.checkpoint_id);
    expect(got!.graph_version).toBe('a'.repeat(64));
    expect(got!.plan).toEqual(plan);
    // 守卫式续链（not fork 且 parent_id 非 None）
    const c2 = await s.put_checkpoint(
      cp({ state: { v: 2 }, parent_id: rec.checkpoint_id, graph_version: 'b'.repeat(64), plan: null }),
    );
    const got2 = await s.get_checkpoint(c2.checkpoint_id);
    expect(got2!.graph_version).toBe('b'.repeat(64));
    expect(got2!.plan).toBeNull();
    // 更新路径字段保持
    const plan2 = { steps: [{ nodes: ['b'] }], index: 0 };
    const updated = await s.put_checkpoint(
      cp({
        checkpoint_id: c2.checkpoint_id,
        state: { v: 3 },
        graph_version: 'b'.repeat(64),
        plan: plan2,
        version: c2.version,
      }),
      { expected_version: c2.version },
    );
    const got3 = await s.get_checkpoint(updated.checkpoint_id);
    expect(got3!.graph_version).toBe('b'.repeat(64));
    expect(got3!.plan).toEqual(plan2);
    expect(await validate_chain(s, 't1')).toEqual([]);
  });

  it('安全：checkpoint 永不落 api_key（敏感键置空保留）', async () => {
    const rec = await s.put_checkpoint(
      cp({ state: { model_config: { api_key: 'sk-secret', model: 'x' }, ok: 1 } }),
    );
    const got = await s.get_checkpoint(rec.checkpoint_id);
    expect((got!.state['model_config'] as Record<string, unknown>)['api_key']).toBe('');
    expect((got!.state['model_config'] as Record<string, unknown>)['model']).toBe('x');
    expect(got!.state['ok']).toBe(1);
  });

  it('安全：后缀凭据键（openai_api_key/client_secret/auth_token）同样剥离，指标键不误伤', async () => {
    const rec = await s.put_checkpoint(
      cp({
        state: {
          openai_api_key: 'sk-secret',
          client_secret: 's',
          auth_token: 't',
          token_count: 3,
          key_insight: '剧情关键',
          ok: 1,
        },
      }),
    );
    const got = await s.get_checkpoint(rec.checkpoint_id);
    expect(got!.state['openai_api_key']).toBe('');
    expect(got!.state['client_secret']).toBe('');
    expect(got!.state['auth_token']).toBe('');
    expect(got!.state['token_count']).toBe(3);
    expect(got!.state['key_insight']).toBe('剧情关键');
    expect(got!.state['ok']).toBe(1);
  });

  it('写入后修改调用方状态不影响库内快照（SQL 真快照语义）', async () => {
    const rec = await s.put_checkpoint(cp({ state: { items: [1] } }));
    (rec.state['items'] as number[]).push(2);
    const got = await s.get_checkpoint(rec.checkpoint_id);
    expect(got!.state['items']).toEqual([1]);
  });

  it('更新路径保持 graph_path 形态（readonly 数组）与 version 递增', async () => {
    const rec = await s.put_checkpoint(cp({ state: { v: 1 } }));
    const updated = await s.put_checkpoint(
      cp({ checkpoint_id: rec.checkpoint_id, state: { v: 2 }, version: rec.version }),
    );
    expect(updated.graph_path).toEqual([]);
    expect(updated.version).toBe(rec.version + 1);
  });

  it('更新不存在的 checkpoint 抛 StorageError', async () => {
    await expect(
      s.put_checkpoint(cp({ checkpoint_id: 12345, state: { v: 1 } })),
    ).rejects.toBeInstanceOf(StorageError);
  });

  it('状态含不可 JSON 序列化对象 → StorageError（与切 sqlite 报错口径一致）', async () => {
    class Obj {
      // 空类实例：TS 侧 JSON.stringify 会静默序列化，strictDumps 显式拒绝
    }
    await expect(
      s.put_checkpoint(cp({ state: { obj: new Obj() } as unknown as JsonRecord })),
    ).rejects.toBeInstanceOf(StorageError);
  });

  it('链一致性不变量：悬挂父指针 → 写入拒绝', async () => {
    await expect(
      s.put_checkpoint(new CheckpointRecord({ checkpoint_id: 0, thread_id: 't1', node: 'n2', parent_id: 999 })),
    ).rejects.toBeInstanceOf(CheckpointConflictError);
  });

  it('链一致性不变量：父指针跨线程 → 写入拒绝', async () => {
    const c1 = await s.put_checkpoint(cp({ state: { v: 1 } }));
    await expect(
      s.put_checkpoint(cp({ thread_id: 't2', state: { v: 2 }, parent_id: c1.checkpoint_id })),
    ).rejects.toBeInstanceOf(CheckpointConflictError);
  });

  it('链一致性不变量：event_seq 回退（低于父锚点）→ 写入拒绝', async () => {
    const c1 = await s.put_checkpoint(cp({ state: { v: 1 }, event_seq: 5 }));
    await expect(
      s.put_checkpoint(nextCp(c1.checkpoint_id, { v: 2 }, { event_seq: 2 })),
    ).rejects.toBeInstanceOf(CheckpointConflictError);
  });

  it('fork 豁免链一致性校验（锚点历史节点 + event_seq 低于父锚点）', async () => {
    const c1 = await s.put_checkpoint(cp({ state: { v: 1 }, event_seq: 100 }));
    const forkRec = await s.put_checkpoint(nextCp(c1.checkpoint_id, { v: 2 }, { event_seq: 10 }), { fork: true });
    expect(forkRec.checkpoint_id).toBeGreaterThan(c1.checkpoint_id);
  });

  it('validate_chain：正常线性链返回无违规', async () => {
    const c1 = await s.put_checkpoint(cp({ state: { v: 1 }, event_seq: 0 }));
    const c2 = await s.put_checkpoint(nextCp(c1.checkpoint_id, { v: 2 }, { event_seq: 5 }));
    await s.put_checkpoint(nextCp(c2.checkpoint_id, { v: 3 }, { event_seq: 5 }));
    expect(await validate_chain(s, 't1')).toEqual([]);
    expect(await validate_chain(s, 'missing_thread')).toEqual([]);
  });
});

describe('sqlite 事件日志与 records', () => {
  let s: SqliteStorage;
  beforeEach(() => {
    s = new SqliteStorage(':memory:');
  });
  afterEach(async () => {
    await s.close();
  });

  it('事件日志落库前剥离敏感键（与 checkpoint 同口径）', async () => {
    await s.append_event('t1', new EngineEvent({ type: 'review_card', payload: { review: 'ok', api_key: 'sk-secret' } }));
    const after = await s.events_after('t1', 0);
    expect(after.length).toBe(1);
    expect(after[0]!.payload['api_key']).toBe('');
    expect(after[0]!.payload['review']).toBe('ok');
  });

  it('records 落库前剥离敏感键', async () => {
    await s.put_record('memory', 'k1', { token: 'sk-secret', keep: 1 });
    const got = await s.get_record('memory', 'k1');
    expect(got!['token']).toBe('');
    expect(got!['keep']).toBe(1);
  });

  it('append 与回放（seq 递增，payload/type 保真）', async () => {
    const s1 = await s.append_event('t1', new EngineEvent({ type: 'reply_token', payload: { text: 'a' }, seq: 1 }));
    const s2 = await s.append_event('t1', new EngineEvent({ type: 'reply_token', payload: { text: 'b' }, seq: 2 }));
    expect(s1).toBeLessThan(s2);
    const after = await s.events_after('t1', 0);
    expect(after.map((e) => e.type)).toEqual(['reply_token', 'reply_token']);
    expect(after.map((e) => e.seq)).toEqual([s1, s2]);
  });

  it('truncate：删除 seq > after_seq 的事件，锚点回退', async () => {
    const s1 = await s.append_event('t1', new EngineEvent({ type: 'a' }));
    const s2 = await s.append_event('t1', new EngineEvent({ type: 'b' }));
    expect(await s.latest_event_seq('t1')).toBe(s2);
    await s.truncate_events('t1', s1);
    const after = await s.events_after('t1', 0);
    expect(after.map((e) => e.seq)).toEqual([s1]);
    expect(await s.latest_event_seq('t1')).toBe(s1);
  });

  it('事件日志按 thread 分区；latest_event_seq 空线程 = 0', async () => {
    await s.append_event('t1', new EngineEvent({ type: 'a' }));
    const t2 = await s.append_event('t2', new EngineEvent({ type: 'b' }));
    expect((await s.events_after('t1', 0)).length).toBe(1);
    expect(await s.latest_event_seq('t1')).toBe(1);
    expect(await s.latest_event_seq('t2')).toBe(t2);
    expect(await s.latest_event_seq('t3')).toBe(0);
  });

  it('records CRUD（upsert + 缺键 + 列表 + 集合隔离）', async () => {
    await s.put_record('memory', 'k1', { a: 1 });
    expect(await s.get_record('memory', 'k1')).toEqual({ a: 1 });
    await s.put_record('memory', 'k1', { a: 2 }); // upsert
    expect(await s.get_record('memory', 'k1')).toEqual({ a: 2 });
    expect(await s.get_record('memory', 'missing')).toBeNull();
    await s.put_record('other', 'k1', { b: 3 });
    expect((await s.list_records('memory')).length).toBe(1);
    expect(await s.delete_collection('other')).toBe(1);
    expect(await s.delete_collection('nope')).toBe(0);
  });

  it('内容型补丁链随 checkpoint 序列化往返（marker 内联还原）', async () => {
    const chain = new PatchChain({ content: '' });
    chain.apply({ op: 'append', path: ['content'], value: '草稿一' });
    chain.apply({ op: 'append', path: ['content'], value: '草稿二' });
    const rec = await s.put_checkpoint(cp({ state: { draft: chain } as unknown as JsonRecord }));
    const got = await s.get_checkpoint(rec.checkpoint_id);
    const restored = got!.state['draft'];
    expect(restored).toBeInstanceOf(PatchChain);
    expect((restored as unknown as PatchChain).assemble()['content']).toBe('草稿一草稿二');
  });

  it('引擎 Message/ToolCall 随 checkpoint 序列化往返（marker 精确还原）', async () => {
    const msgs: Message[] = [
      new Message('user', '你好', null, null, null, 'm1'),
      new Message('assistant', '', null, [new ToolCall({ id: 'c1', name: 'lookup', arguments: '{"q": 1}' })], '先查库', 'm2'),
      new Message('tool', '结果', 'c1', null, null, 'm3'),
    ];
    const rec = await s.put_checkpoint(cp({ state: { messages: msgs } as unknown as JsonRecord }));
    const got = await s.get_checkpoint(rec.checkpoint_id);
    const restored = got!.state['messages'] as unknown as Message[];
    expect(restored.length).toBe(3);
    expect(restored[0]).toBeInstanceOf(Message);
    expect(restored[0]!.id).toBe('m1');
    expect(restored[1]!.tool_calls![0]!.name).toBe('lookup');
    expect(restored[1]!.tool_calls![0]!.arguments).toBe('{"q": 1}');
    expect(restored[1]!.reasoning).toBe('先查库');
    expect(restored[2]!.role).toBe('tool');
    expect(restored[2]!.tool_call_id).toBe('c1');
  });

  it('补丁链通道内敏感键同样剥离，不绕过', async () => {
    const chain = new PatchChain({ content: '' });
    chain.apply({ op: 'append', path: ['content'], value: '正文' });
    chain.apply({ op: 'replace', path: ['model_config'], value: { api_key: 'sk', model: 'x' } });
    const rec = await s.put_checkpoint(cp({ state: { draft: chain } as unknown as JsonRecord }));
    const got = await s.get_checkpoint(rec.checkpoint_id);
    const restored = got!.state['draft'] as unknown as PatchChain;
    const assembled = restored.assemble();
    expect((assembled['model_config'] as Record<string, unknown>)['api_key']).toBe('');
    expect((assembled['model_config'] as Record<string, unknown>)['model']).toBe('x');
    expect(assembled['content']).toBe('正文');
  });
});
