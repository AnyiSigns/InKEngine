/**
 * Runtime ????/??/?????/thread ???runtime.py ????
 *
 * ?? + ???tool_registry ????????????????——
 * immutable = ??/????????????baseline = ???????? +
 * ???????thread:<id> = agent ???????????????
 * thread ????collect_specs ?????????????merged_specs
 * ???????/??/???????
 *
 * thread ?????? records ???runtime_config/tool_thread_tags??
 * ??? _restore_thread_tags ???TTL ???????
 */

import { DefaultEvolutionWriter, runtime_config_writer } from '../evolution_writer/evolution_writer.js';
import { ToolSelector } from '../tool_orchestrator/tool_orchestrator.js';
import type { ToolSpec } from '../llm/tools.js';
import {
  BASELINE_IMMUTABLE_TOOLS,
  BASELINE_RECORD_COLLECTION,
  BASELINE_RECORD_KEY,
  THREAD_TAG_RECORD_COLLECTION,
  THREAD_TAG_RECORD_KEY,
  THREAD_TAG_TTL_SECONDS,
  TAG_BASELINE,
  TAG_IMMUTABLE,
} from './_constants.js';
import { _time_now } from './_runtime_base.js';
import { RuntimeRunControl } from './_runtime_runs.js';

/** composite ?????(name, thread_id) ? ??????? */
const _KEY_SEP = '\u001f';

/** ???? sources ????IntrospectionService._sources ???——??
 *  ??? tools/registered_tools ????????????????? */
type IntrospectionSourcesLoose = {
  tools: readonly ToolSpec[];
  registered_tools: readonly ToolSpec[];
};

/** ?? + ????????? / ????? / thread ??? */
export abstract class RuntimeSpecs extends RuntimeRunControl {
  /** ????????? + ?? + ????????????????? */
  merged_specs(): ToolSpec[] {
    return [
      ...this.introspection_specs,
      ...this.self_specs,
      ...Object.values(this.tool_registry),
    ];
  }

  /** ??????????immutable/baseline/thread:*?? */
  tool_tags(name: string): ReadonlySet<string> {
    return new Set(this._tool_tags[name] ?? []);
  }

  /** ?????????????????????????? */
  tag_tool(name: string, tag: string): void {
    if (!(name in this.tool_registry) && tag !== TAG_IMMUTABLE) return;
    const tags = this._tool_tags[name] ?? new Set<string>();
    tags.add(tag);
    this._tool_tags[name] = tags;
    if (tag.startsWith('thread:')) {
      const thread_id = tag.slice('thread:'.length);
      this._thread_tag_created[`${name}${_KEY_SEP}${thread_id}`] = _time_now();
    }
  }

  /** ???????immutable ?????? */
  untag_tool(name: string, tag: string): void {
    if (tag === TAG_IMMUTABLE) return;
    const tags = this._tool_tags[name];
    if (tags === undefined) return;
    tags.delete(tag);
    if (tag.startsWith('thread:')) {
      const thread_id = tag.slice('thread:'.length);
      delete this._thread_tag_created[`${name}${_KEY_SEP}${thread_id}`];
    }
    if (tags.size === 0) delete this._tool_tags[name];
  }

  /** ?????? thread ???TTL ???????????? */
  _expire_thread_tags(now?: number): void {
    if (Object.keys(this._thread_tag_created).length === 0) return;
    const nowValue = now ?? _time_now();
    const expired: string[] = [];
    for (const [key, ts] of Object.entries(this._thread_tag_created)) {
      if (nowValue - ts > THREAD_TAG_TTL_SECONDS) expired.push(key);
    }
    for (const key of expired) {
      delete this._thread_tag_created[key];
      const sep = key.indexOf(_KEY_SEP);
      const tool = key.slice(0, sep);
      const thread_id = key.slice(sep + 1);
      this._tool_tags[tool]?.delete(`thread:${thread_id}`);
    }
  }

  /** ?????????????immutable ? baseline ? thread:<????>?
   *  ????? search_tools ???request_tool ???? thread ????? */
  collect_specs(thread_id?: string | null): ToolSpec[] {
    this._expire_thread_tags();
    const baseline = this._baseline_names;
    const thread_tag = thread_id ? `thread:${thread_id}` : null;
    const keep: ToolSpec[] = [];
    for (const spec of this.merged_specs()) {
      const name = spec.name;
      const tags = this._tool_tags[name] ?? new Set<string>();
      if (baseline.has(name) || tags.has(TAG_IMMUTABLE)) {
        keep.push(spec);
        continue;
      }
      if (thread_tag !== null && tags.has(thread_tag)) keep.push(spec);
    }
    // ?????????????????????????
    const budget = this.tool_selector !== null ? this.tool_selector.max_tools : 18;
    return budget > 0 ? keep.slice(0, budget) : keep;
  }

  /** ????????????????????????? */
  get baseline_names(): string[] {
    return [...this._baseline_names].sort();
  }

  /** ??????????????? set_baseline_names ????? */
  _apply_baseline(names: Iterable<string>): void {
    const nextSet = new Set<string>([...names, ...BASELINE_IMMUTABLE_TOOLS]);
    const changed =
      nextSet.size !== this._baseline_names.size
      || [...nextSet].some((name) => !this._baseline_names.has(name));
    if (changed) {
      for (const name of nextSet) {
        if (!this._baseline_names.has(name) && name in this.tool_registry) {
          this.tag_tool(name, TAG_BASELINE);
        }
      }
      for (const name of this._baseline_names) {
        if (!nextSet.has(name)) this.untag_tool(name, TAG_BASELINE);
      }
    }
    this._baseline_names = nextSet;
    if (changed) {
      if (this.tool_selector !== null) {
        this.tool_selector = new ToolSelector({
          max_tools: this.tool_selector.max_tools,
          baseline_names: [...this._baseline_names],
        });
      }
      if (this.introspection_service !== null) {
        const sources = (
          this.introspection_service as unknown as { _sources: IntrospectionSourcesLoose }
        )._sources;
        sources.tools = this.collect_specs();
        sources.registered_tools = this.merged_specs();
      }
    }
  }

  /** ????????????????????????????? */
  async set_baseline_names(names: readonly string[]): Promise<string[]> {
    const mergedNames = new Set(this.merged_specs().map((s) => s.name));
    const requested = new Set(names);
    const unknown = [...requested].filter((name) => !mergedNames.has(name)).sort();
    if (unknown.length > 0) {
      throw new Error(`??????????????: ${unknown.join(', ')}`);
    }
    this._apply_baseline(requested);
    if (this.storage !== null) {
      await runtime_config_writer(
        new DefaultEvolutionWriter(this.storage),
        BASELINE_RECORD_COLLECTION,
        BASELINE_RECORD_KEY,
        { tools: [...this._baseline_names].sort() },
        { asset_id: 'tool_baseline', note: 'set_baseline_names' },
      );
    }
    return this.baseline_names;
  }

  /** ????????????records ?????????????? */
  async _restore_baseline(): Promise<void> {
    if (this.storage === null) return;
    let record: Record<string, unknown> | null = null;
    try {
      record = await this.storage.get_record(
        BASELINE_RECORD_COLLECTION,
        BASELINE_RECORD_KEY,
      );
    } catch {
      // ?????????????????
      return;
    }
    const tools = (record ?? {})['tools'];
    if (Array.isArray(tools)) {
      this._apply_baseline(tools as string[]);
    }
  }

  /** thread ?????records ???request_tool ??????????? */
  async _persist_thread_tags(): Promise<void> {
    if (this.storage === null) return;
    const payload: Record<string, Record<string, number>> = {};
    for (const [key, ts] of Object.entries(this._thread_tag_created)) {
      const sep = key.indexOf(_KEY_SEP);
      const name = key.slice(0, sep);
      const thread_id = key.slice(sep + 1);
      (payload[name] ??= {})[thread_id] = ts;
    }
    try {
      await runtime_config_writer(
        new DefaultEvolutionWriter(this.storage),
        THREAD_TAG_RECORD_COLLECTION,
        THREAD_TAG_RECORD_KEY,
        { tags: payload },
        { asset_id: 'tool_thread_tags', note: 'persist_thread_tags' },
      );
    } catch {
      // thread ???????????
    }
  }

  /** ???? thread ???records ???TTL ?????????? */
  async _restore_thread_tags(): Promise<void> {
    if (this.storage === null) return;
    let record: Record<string, unknown> | null = null;
    try {
      record = await this.storage.get_record(
        THREAD_TAG_RECORD_COLLECTION,
        THREAD_TAG_RECORD_KEY,
      );
    } catch {
      // thread ????????????
      return;
    }
    const raw = (record ?? {})['tags'];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const now = _time_now();
    for (const [name, threads] of Object.entries(raw as Record<string, unknown>)) {
      if (!threads || typeof threads !== 'object' || Array.isArray(threads)) continue;
      for (const [thread_id, ts] of Object.entries(threads as Record<string, unknown>)) {
        const stamp = Number(ts);
        if (!Number.isFinite(stamp)) continue;
        if (now - stamp > THREAD_TAG_TTL_SECONDS) continue;
        const tags = this._tool_tags[name] ?? new Set<string>();
        tags.add(`thread:${thread_id}`);
        this._tool_tags[name] = tags;
        this._thread_tag_created[`${name}${_KEY_SEP}${thread_id}`] = stamp;
      }
    }
  }
}
