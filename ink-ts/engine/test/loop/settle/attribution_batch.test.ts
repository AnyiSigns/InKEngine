/**
 * Edge evidence write-amplification tests (R7-5): settle aggregates the
 * round's attribution deltas in memory and writes each edge once at round
 * end (single get + single put per edge per round), with shared reads for
 * failure rounds (preloaded rows skip the per-edge re-read). A counting
 * fake storage asserts the exact get/put counts.
 */

import { describe, expect, it } from 'vitest';

import type { EdgeEvidence, EdgeKey } from '../../../src/core/edge_evidence/_types.js';
import { EdgeEvidenceStore } from '../../../src/core/edge_evidence/store.js';
import type { EdgeEvidenceStorage, EdgeKeyTuple } from '../../../src/core/edge_evidence/storage_seam.js';
import { EdgeEvidenceSettleHook } from '../../../src/kernel/settle/hooks.js';
import { TRACE_SUCCESS } from '../../../src/kernel/settle/_constants.js';
import { Graph } from '../../../src/model/graph/graph.js';
import { edgeKey, makeCtx, stepsOf } from './helpers.js';

const NOW = 1_800_000_000;

/** Counting fake: counts get/put per key (seam-level IO evidence). */
class CountingStorage implements EdgeEvidenceStorage {
  rows = new Map<string, EdgeEvidence>();
  gets = 0;
  puts = 0;
  putsPerKey = new Map<string, number>();
  getsPerKey = new Map<string, number>();

  #k(key: readonly string[]): string {
    return key.join('::');
  }

  async get(key: EdgeKeyTuple): Promise<EdgeEvidence | null> {
    const k = this.#k(key);
    this.gets += 1;
    this.getsPerKey.set(k, (this.getsPerKey.get(k) ?? 0) + 1);
    const row = this.rows.get(k);
    return row === undefined ? null : { ...row, key: { ...row.key } };
  }

  async put(evidence: EdgeEvidence): Promise<EdgeEvidence> {
    const k = this.#k([
      evidence.key.src_type,
      evidence.key.dst_type,
      evidence.key.src_contract_version,
      evidence.key.dst_contract_version,
      evidence.key.context_domain,
      evidence.key.variant_hash,
    ]);
    this.puts += 1;
    this.putsPerKey.set(k, (this.putsPerKey.get(k) ?? 0) + 1);
    this.rows.set(k, { ...evidence, key: { ...evidence.key } });
    return { ...evidence, key: { ...evidence.key } };
  }

  async record_success(
    key: EdgeKeyTuple,
    opts: { cost?: number | null; now?: number | null; delta?: number } = {},
  ): Promise<EdgeEvidence> {
    const existing = await this.get(key);
    const row: EdgeEvidence = {
      key: {
        src_type: key[0],
        dst_type: key[1],
        src_contract_version: key[2],
        dst_contract_version: key[3],
        context_domain: key[4],
        variant_hash: key[5],
      },
      success_count: (existing?.success_count ?? 0) + (opts.delta ?? 1),
      fail_count: existing?.fail_count ?? 0,
      avg_cost: existing?.avg_cost ?? 0,
      policy: existing?.policy ?? false,
      origin: existing?.origin ?? 'runtime',
      last_used_at: opts.now ?? null,
      created_at: existing?.created_at ?? (opts.now ?? 0),
    };
    return this.put(row);
  }

  async record_failure(
    key: EdgeKeyTuple,
    opts: { cost?: number | null; now?: number | null; delta?: number } = {},
  ): Promise<EdgeEvidence> {
    const existing = await this.get(key);
    const row: EdgeEvidence = {
      key: {
        src_type: key[0],
        dst_type: key[1],
        src_contract_version: key[2],
        dst_contract_version: key[3],
        context_domain: key[4],
        variant_hash: key[5],
      },
      success_count: existing?.success_count ?? 0,
      fail_count: (existing?.fail_count ?? 0) + (opts.delta ?? 1),
      avg_cost: existing?.avg_cost ?? 0,
      policy: existing?.policy ?? false,
      origin: existing?.origin ?? 'runtime',
      last_used_at: opts.now ?? null,
      created_at: existing?.created_at ?? (opts.now ?? 0),
    };
    return this.put(row);
  }

  async list_edges(domain: string | null = null): Promise<EdgeEvidence[]> {
    return [...this.rows.values()].filter(
      (row) => domain === null || row.key.context_domain === domain,
    );
  }

  async evidence_count(domain: string | null = null): Promise<number> {
    return (await this.list_edges(domain)).length;
  }

  seed(key: EdgeKey, ev: Partial<EdgeEvidence>): void {
    const row: EdgeEvidence = {
      key: { ...key },
      success_count: 0,
      fail_count: 0,
      avg_cost: 0,
      policy: false,
      origin: 'seed',
      last_used_at: NOW,
      created_at: NOW,
      ...ev,
    };
    this.rows.set(
      this.#k([
        key.src_type,
        key.dst_type,
        key.src_contract_version,
        key.dst_contract_version,
        key.context_domain,
        key.variant_hash,
      ]),
      row,
    );
  }
}

/** Graph with a two-cycle so the b->c edge is traversed twice in one round. */
function loopGraph(): Graph {
  const g = new Graph({ name: 'cycle', entry: 'a' });
  g.add_node('a', async () => ({}));
  g.add_node('b', async () => ({}));
  g.add_node('c', async () => ({}));
  g.add_edge('a', 'b');
  g.add_edge('b', 'c');
  g.add_edge('c', 'b');
  g.add_exit('c');
  return g;
}

describe('EdgeEvidenceSettleHook round-level aggregated write (R7-5)', () => {
  it('successful round with same edge traversed K times = one put per edge', async () => {
    const storage = new CountingStorage();
    const store = new EdgeEvidenceStore(storage);
    const hook = new EdgeEvidenceSettleHook(store);
    // trace a->b->c->b->c: edge b->c is traversed twice in the same round
    const ctx = makeCtx(
      stepsOf(
        ['a', TRACE_SUCCESS],
        ['b', TRACE_SUCCESS],
        ['c', TRACE_SUCCESS],
        ['b', TRACE_SUCCESS],
        ['c', TRACE_SUCCESS],
      ),
      { graph: loopGraph(), domain: 'code' },
    );
    await hook.settle(ctx);
    // three unique edges, each written exactly once (deltas merged)
    expect(storage.puts).toBe(3);
    for (const count of storage.putsPerKey.values()) {
      expect(count).toBe(1);
    }
    const row = await store.get(edgeKey('b', 'c', { domain: 'code' }));
    expect(row!.success_count).toBe(2);
    await store.close();
  });

  it('failed round shares reads: one read (weights) + one write per edge', async () => {
    const storage = new CountingStorage();
    storage.seed(edgeKey('start', 'boom', { domain: 'code' }), {
      success_count: 2,
      origin: 'runtime',
    });
    const store = new EdgeEvidenceStore(storage);
    const hook = new EdgeEvidenceSettleHook(store);
    const g = new Graph({ name: 'fail', entry: 'start' });
    g.add_node('start', async () => ({}));
    g.add_node('boom', async () => ({}));
    g.add_edge('start', 'boom');
    g.add_exit('boom');
    const ctx = makeCtx(stepsOf(['start', TRACE_SUCCESS], ['boom', 'failed']), {
      graph: g,
      domain: 'code',
    });
    await hook.settle(ctx);
    // preload read once + single write (start->boom: one get, one put)
    expect(storage.puts).toBe(1);
    expect(storage.gets).toBe(1);
    const row = await store.get(edgeKey('start', 'boom', { domain: 'code' }));
    // failure delta = weight(success+1=3) + failed node incoming +1 = 4
    expect(row!.fail_count).toBe(4);
    expect(row!.success_count).toBe(2);
    await store.close();
  });
});
