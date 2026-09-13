/**
 * 引擎主循环后半段（executor.py Engine._execute 的 checkpoint/下一步定位
 * 段移植）。
 *
 * 后半段职责（front 返回 'proceed' 后执行）：
 * - checkpoint 快照（每节点完成，版本链）；
 * - 下一步定位：条件边/出口。
 *
 * 返回 'break' = 迭代在定位处终止；'continue' = 下一迭代。
 */
import { _locate_next, _warn } from './_internals.js';
import { EngineLoopFront } from './_engine_loop_front.js';
import type { LoopState } from './_loop_types.js';

/** 主循环后半段分层段（Engine 方法群）。 */
export abstract class EngineLoopBack extends EngineLoopFront {
  /**
   * 单迭代后半段（checkpoint/下一步定位；见文件头注）。
   */
  async _loop_back(ls: LoopState): Promise<'continue' | 'break'> {
    const { ctx } = ls;
    const graph = this.graph;
    const schema = this.options.schema;
    const storage = this.options.storage;

    // ── checkpoint 快照（每节点完成，版本链）──
    if (storage !== null) {
      const written = await this._write_checkpoint({
        storage,
        thread_id: ls.thread_id,
        chain_thread: ls.chain_thread,
        ctx,
        node: ls.current,
        state: ls.current_state,
        parent_id: ls.parent_id,
        fork_write: ls.fork_write,
      });
      ls.last_checkpoint = written[0];
      ls.fork_write = written[1];
      ls.parent_id = ls.last_checkpoint.checkpoint_id;
    }

    // ── 下一步定位：条件边/出口 ──
    const [locatedReason, nextNode] = await _locate_next(graph, ctx, ls.current);
    if (nextNode !== null) {
      ls.current = nextNode;
      return 'continue';
    }
    if (locatedReason !== null) {
      ls.reason = locatedReason;
    }
    return 'break';
  }
}
