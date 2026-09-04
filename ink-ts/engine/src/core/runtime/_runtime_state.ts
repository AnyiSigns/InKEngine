/**
 * Runtime 生命周期状态机（runtime.py boot/pause/resume/stop 移植）。
 *
 * 生命周期状态机：uninitialized → running → paused → stopped。pause 只
 * 拒新 run、不强制打断在途 run（回合是短任务，自然完成）；stop 拒新 →
 * 等在途完成 → 关 MCP 会话（seam）→ 关存储 → 宿主关停钩子（顺序保证，
 * 幂等）。
 *
 * boot = 装配入口（幂等）；装配实现（_assemble 各步骤）在分层链末端的
 * RuntimeAssemble 提供——本层只钉签名与失败清理语义。
 */

import type { AssemblyRecipe, Host } from './_types.js';
import { RuntimeState } from './_types.js';
import { RuntimeBase } from './_runtime_base.js';

/** 生命周期/回合登记/装配基座。 */
export abstract class RuntimeStateMachine extends RuntimeBase {
  async boot(host: Host, recipe: AssemblyRecipe): Promise<this> {
    // 装配幂等：已装配再次调用直接返回自身
    if (this._state === RuntimeState.RUNNING) return this;
    if (this._state !== RuntimeState.UNINITIALIZED) {
      throw new Error(`运行时不处于未装配态，无法装配: ${this._state}`);
    }
    if (recipe.tool_wiring === null) {
      throw new Error('装配配方缺工具三路声明（tool_wiring）');
    }
    if (recipe.graph_recipe === null) {
      throw new Error('装配配方缺图配方（graph_recipe）');
    }
    this._host = host;
    this._recipe = recipe;
    try {
      await this._assemble(host, recipe);
    } catch (exc) {
      // 装配失败：资源回收后原样上抛（静默失败会让宿主拿到半装配运行时）
      await this._boot_cleanup();
      throw exc;
    }
    this._signal_drained();
    this._state = RuntimeState.RUNNING;
    return this;
  }

  /** 装配实现（分层链末端 RuntimeAssemble 提供）。 */
  protected abstract _assemble(host: Host, recipe: AssemblyRecipe): Promise<void>;

  /** 装配失败的资源回收（各步独立容错；失败只吞不掩盖原异常）。 */
  async _boot_cleanup(): Promise<void> {
    await this._drain_persist_tasks();
    if (this.mcp_manager !== null) {
      try {
        await this.mcp_manager.close_all();
      } catch {
        // 装配失败清理：MCP 会话关闭失败
      }
    }
    if (this.engine_llm !== null) {
      try {
        await this.engine_llm.aclose();
      } catch {
        // 装配失败清理：LLM 链关闭失败
      }
    }
    if (this.storage !== null) {
      try {
        await this.storage.close();
      } catch {
        // 装配失败清理：存储关闭失败
      }
    }
    // 半装配产物置空：失败后的运行时不得被当作可用装配态使用
    this.storage = null;
    this.engine = null;
    this.engine_llm = null;
    this._engine_storage = null;
    this._engine_spec_key = null;
  }

  /** 等待排空（stop 等在途 run 注销；drained 已置位 = 立即返回）。 */
  async _wait_drained(): Promise<void> {
    if (this._drained.done) return;
    await new Promise<void>((resolve) => {
      this._drained.waiters.push(resolve);
    });
  }

  /** 暂停接受新 run（在途 run 自然完成，不强制打断）。 */
  pause(): void {
    if (this._state !== RuntimeState.RUNNING) {
      throw new Error(
        `非法状态转换: ${this._state} -> paused（仅 running 可暂停）`,
      );
    }
    this._state = RuntimeState.PAUSED;
  }

  /** 恢复接受新 run（仅 paused 可恢复）。 */
  resume(): void {
    if (this._state !== RuntimeState.PAUSED) {
      throw new Error(
        `非法状态转换: ${this._state} -> running（仅 paused 可恢复）`,
      );
    }
    this._state = RuntimeState.RUNNING;
  }

  /** 关停（幂等）：拒新 → 等在途完成 → 关 MCP 会话 → 关 LLM 链 → 关存储
   *  → 宿主关停钩子（顺序保证优雅退出；各步独立容错）。 */
  async stop(): Promise<void> {
    if (
      this._state === RuntimeState.UNINITIALIZED
      || this._state === RuntimeState.STOPPED
    ) {
      return;
    }
    this._state = RuntimeState.STOPPED;
    if (Object.keys(this._active_runs).length > 0) {
      await this._wait_drained();
    }
    // 在途知识落库任务收口：fire-and-forget 的 save 不跨过存储关闭
    await this._drain_persist_tasks();
    if (this.mcp_manager !== null) {
      try {
        await this.mcp_manager.close_all();
      } catch {
        // MCP 会话关闭失败（继续后续清理）
      }
    }
    if (this.engine_llm !== null) {
      try {
        await this.engine_llm.aclose();
      } catch {
        // LLM 链关闭失败（继续后续清理）
      }
    }
    if (this.storage !== null) {
      try {
        await this.storage.close();
      } catch {
        // 存储关闭失败（继续后续清理）
      }
    }
    if (this._host !== null) {
      try {
        await this._host.close();
      } catch {
        // 宿主关停钩子失败
      }
    }
  }
}
