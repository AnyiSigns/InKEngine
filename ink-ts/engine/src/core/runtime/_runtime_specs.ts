/**
 * Runtime 工具规格/标签分层（runtime.py specs 段移植）。
 *
 * 单源 + 标签：tool_registry 是全量存储，标签区分注册状态与注入面。注入集 =
 * immutable（动态注册机制工具恒注入）∪ baseline（常驻必带集，设置页可增删）
 * ∪ thread:<id>（agent 会话窗口绑定，TTL 到期惰性清理）；merged_specs = 全量
 * 工具清单（检索/内省/执行解析用，注册即存在，不依赖注入）。
 *
 * 常驻必带集/thread 标签持久化走 records 通道（runtime_config/tool_baseline、
 * runtime_config/tool_thread_tags），重启经 _restore_baseline/_restore_thread_tags
 * 装载（同名常量，两端须同步）。
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

/** composite 键（name, thread_id）的分隔符（ASCII 单元分隔符）。 */
const _KEY_SEP = '\u001f';

/** 内省源快照松散形态（IntrospectionService._sources 字段写回用）：
 *  常驻集变更后同步 tools 注入集与 registered_tools 全量清单。 */
type IntrospectionSourcesLoose = {
  tools: readonly ToolSpec[];
  registered_tools: readonly ToolSpec[];
};

/** 装配产物访问器/常驻必带集/thread 标签分层段（Engine 方法群）。 */
export abstract class RuntimeSpecs extends RuntimeRunControl {
  /** 全量工具清单（内省 + 自指 + 动态注册），供工具索引构建与内省快照。 */
  merged_specs(): ToolSpec[] {
    return [
      ...this.introspection_specs,
      ...this.self_specs,
      ...Object.values(this.tool_registry),
    ];
  }

  /** 某工具的当前标签集（immutable/baseline/thread:*）。 */
  tool_tags(name: string): ReadonlySet<string> {
    return new Set(this._tool_tags[name] ?? []);
  }

  /** 给工具打标签（单源总表维护；工具不存在时静默忽略）。thread 标签额外
   *  记录打标时间戳（TTL 惰性清理依据）；持久化由调用方在事务边界异步落盘
   *  （_persist_thread_tags），本方法只管活跃态内存。 */
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

  /** 摘除工具标签（immutable 不可摘除）。 */
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

  /** 惰性清理过期 thread 标签（TTL 到期自动回收，防泄漏）。 */
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

  /** 工具注入集（按标签过滤），供回合装配 tools 参数。
   *  注入集 = immutable（恒注入）∪ baseline（必带恒注入）∪ thread:<当前会话>
   *  （agent 回合内绑定，会话窗口恒注入）。thread_id 缺省 = 无会话上下文（仅
   *  immutable + baseline）；其余工具不在注入面——模型经 search_tools 检索、
   *  request_tool 绑定后以 thread 标签注入当前会话窗口。 */
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
    // 预算护栏：常驻注入集默认上限（设置页可调，非硬锁）
    const budget = this.tool_selector !== null ? this.tool_selector.max_tools : 18;
    return budget > 0 ? keep.slice(0, budget) : keep;
  }

  /** 当前常驻必带工具名（排序；含强制常驻的检索工具）。 */
  get baseline_names(): string[] {
    return [...this._baseline_names].sort();
  }

  /** 应用常驻必带集（不校验；校验归 set_baseline_names 调用面）。
   *  单源 + 标签：设置后同步标签表——新增名打 baseline 标签、摘除名摘除；
   *  immutable 恒在，不受此影响。 */
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

  /** 设置常驻必带工具集（设置页勾选落地面）：强制并入动态注册机制工具；
   *  非法名（不在 merged_specs 全量工具表内）结构化拒绝；持久化走 records
   *  通道，重启经 _restore_baseline 装载。 */
  async set_baseline_names(names: readonly string[]): Promise<string[]> {
    const mergedNames = new Set(this.merged_specs().map((s) => s.name));
    const requested = new Set(names);
    const unknown = [...requested].filter((name) => !mergedNames.has(name)).sort();
    if (unknown.length > 0) {
      throw new Error(`未注册工具不能加入常驻必带集: ${unknown.join(', ')}`);
    }
    this._apply_baseline(requested);
    if (this.storage !== null) {
      const writer =
        this._mechanism_writer ?? new DefaultEvolutionWriter(this.storage);
      await runtime_config_writer(
        writer,
        BASELINE_RECORD_COLLECTION,
        BASELINE_RECORD_KEY,
        { tools: [...this._baseline_names].sort() },
        { asset_id: 'tool_baseline', note: 'set_baseline_names' },
      );
    }
    return this.baseline_names;
  }

  /** 重启装载用户常驻必带集（records 通道；缺记录/坏形态沿用出厂基线）。
   *  宽松应用（不走 set_baseline_names 的实时校验）：持久化名可能含尚未登记
   *  的挂载工具，表内缺失时注入面自然无效应，登记后即自动生效。 */
  async _restore_baseline(): Promise<void> {
    if (this.storage === null) return;
    let record: Record<string, unknown> | null = null;
    try {
      record = await this.storage.get_record(
        BASELINE_RECORD_COLLECTION,
        BASELINE_RECORD_KEY,
      );
    } catch {
      // 常驻必带集读取失败（沿用出厂基线）
      return;
    }
    const tools = (record ?? {})['tools'];
    if (Array.isArray(tools)) {
      this._apply_baseline(tools as string[]);
    }
  }

  /** thread 标签落盘（records 通道；request_tool 绑定后事务边界调用）。
   *  只持久化 thread 标签（immutable/baseline 有各自通道）；坏形态吞掉不阻断
   *  （持久化是增强，活跃态内存才是权威运行态）。 */
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
      const writer =
        this._mechanism_writer ?? new DefaultEvolutionWriter(this.storage);
      await runtime_config_writer(
        writer,
        THREAD_TAG_RECORD_COLLECTION,
        THREAD_TAG_RECORD_KEY,
        { tags: payload },
        { asset_id: 'tool_thread_tags', note: 'persist_thread_tags' },
      );
    } catch {
      // thread 标签持久化失败（忽略，不阻断）
    }
  }

  /** 重启装载 thread 标签（records 通道；TTL 过期条目直接丢弃）。
   *  宽松应用：持久化名可能引用已卸载/未登记工具，标签在表内无对应定义时
   *  注入面自然无效应，登记后即自动生效（与 baseline 同口径）。 */
  async _restore_thread_tags(): Promise<void> {
    if (this.storage === null) return;
    let record: Record<string, unknown> | null = null;
    try {
      record = await this.storage.get_record(
        THREAD_TAG_RECORD_COLLECTION,
        THREAD_TAG_RECORD_KEY,
      );
    } catch {
      // thread 标签读取失败（沿用空表）
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
