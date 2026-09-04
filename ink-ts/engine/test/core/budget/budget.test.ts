import { describe, expect, it } from 'vitest';

import {
  BudgetExceededError,
  BudgetManager,
  BudgetRemaining,
  can_afford,
} from '../../../src/core/budget/budget.js';
import type { BudgetPolicy, BudgetQuery } from '../../../src/core/budget/budget.js';

class DemoPolicy implements BudgetPolicy {
  max_nodes: number;
  visited = 0;

  constructor(max_nodes = 3) {
    this.max_nodes = max_nodes;
  }

  async check(_ctx: unknown): Promise<void> {
    this.visited += 1;
    if (this.visited > this.max_nodes) {
      throw new BudgetExceededError('nodes', this.max_nodes, this.visited);
    }
  }
}

describe('执行预算机制：策略注册/节点边界检查/异常包装 fail-closed', () => {
  it('无策略注册 = 空检查恒通过', async () => {
    const manager = new BudgetManager();
    await manager.check(null);
  });

  it('策略注册即生效：超限抛 BudgetExceededError', async () => {
    const manager = new BudgetManager();
    manager.register(new DemoPolicy(2));
    await manager.check(null);
    await manager.check(null);
    await expect(manager.check(null)).rejects.toThrow(BudgetExceededError);
  });

  it('多策略叠加：任一维度超限即终止', async () => {
    const manager = new BudgetManager();
    manager.register(new DemoPolicy(1));
    manager.register(new DemoPolicy(5));
    await manager.check(null);
    await expect(manager.check(null)).rejects.toThrow(/nodes/);
  });

  it('策略自身异常 → 包装为 BudgetExceededError（不静默放行）', async () => {
    class BrokenPolicy implements BudgetPolicy {
      async check(_ctx: unknown): Promise<void> {
        throw new Error('预算策略自身故障');
      }
    }

    const manager = new BudgetManager();
    manager.register(new BrokenPolicy());
    await expect(manager.check(null)).rejects.toThrow(/policy_error/);
  });

  it('策略故障包装保留原始类型与消息（宿主可直接定位）', async () => {
    class AttributeBrokenPolicy implements BudgetPolicy {
      async check(ctx: unknown): Promise<void> {
        // 幽灵属性：对 null ctx 读属性在 JS 侧抛 TypeError（Python 侧为 AttributeError）
        void (ctx as { step_count?: unknown }).step_count;
      }
    }

    const manager = new BudgetManager();
    manager.register(new AttributeBrokenPolicy());

    let caught: BudgetExceededError | null = null;
    try {
      await manager.check(null);
    } catch (err) {
      caught = err as BudgetExceededError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.kind).toBe('policy_error:TypeError');
    expect(caught!.message).toContain('TypeError');
    expect(caught!.cause).toBeInstanceOf(TypeError);
    expect(caught!.detail).toContain('step_count');
  });

  it('detail 缺省 null 时信息形态与早期一致', () => {
    const err = new BudgetExceededError('tokens', 1000, 1200);
    expect(err.detail).toBeNull();
    expect(err.message).toBe('执行预算超限[tokens]: 1200 >= 1000');
    const withDetail = new BudgetExceededError('tokens', 1000, 1200, '原消息');
    expect(withDetail.detail).toBe('原消息');
    expect(withDetail.message).toContain('原消息');
  });

  it('超限异常携带维度/上限/实际值（审计留痕可读）', () => {
    const err = new BudgetExceededError('tokens', 1000, 1200);
    expect(err.message).toContain('tokens');
    expect(err.message).toContain('1000');
    expect(err.message).toContain('1200');
  });
});

describe('预算余量只读查询（预检 fail-closed）', () => {
  class QueryPolicy implements BudgetPolicy, BudgetQuery {
    limit: number;
    used: number;
    name: string;

    constructor(limit: number, used = 0.0, name = 'tokens') {
      this.limit = limit;
      this.used = used;
      this.name = name;
    }

    async check(_ctx: unknown): Promise<void> {
      if (this.used >= this.limit) {
        throw new BudgetExceededError(this.name, this.limit, this.used);
      }
    }

    async remaining(_ctx: unknown): Promise<BudgetRemaining> {
      return new BudgetRemaining(
        this.name,
        this.limit,
        this.used,
        Math.max(0.0, this.limit - this.used),
      );
    }
  }

  it('余量只读查询：不抛异常、不影响 check 语义', async () => {
    const manager = new BudgetManager();
    manager.register(new QueryPolicy(100.0, 30.0));
    const results = await manager.query_remaining(null);
    expect(results.length).toBe(1);
    expect(results[0]!.remaining).toBe(70.0);
    expect(results[0]!.unavailable).toBe(false);
    await manager.check(null);
  });

  it('多维度余量 = 最紧维度约束（预检取各维最小值）', async () => {
    const manager = new BudgetManager();
    manager.register(new QueryPolicy(100.0, 10.0, 'tokens'));
    manager.register(new QueryPolicy(50.0, 40.0, 'steps'));
    const results = await manager.query_remaining(null);
    expect(can_afford(results, 5.0)).toBe(true);
    expect(can_afford(results, 11.0)).toBe(false);
  });

  it('查询故障维度 = 标记不可用（fail-closed：不得放行）', async () => {
    class BrokenQuery implements BudgetPolicy, BudgetQuery {
      async check(_ctx: unknown): Promise<void> {
        return undefined;
      }

      async remaining(_ctx: unknown): Promise<BudgetRemaining> {
        throw new Error('查询故障');
      }
    }

    const manager = new BudgetManager();
    manager.register(new BrokenQuery());
    const results = await manager.query_remaining(null);
    expect(results.length).toBe(1);
    expect(results[0]!.unavailable).toBe(true);
    expect(results[0]!.remaining).toBe(0.0);
    expect(can_afford(results, 0.0)).toBe(false);
  });

  it('无预算维度 = 不限（未启用预算语义时预检放行）', async () => {
    const manager = new BudgetManager();
    const results = await manager.query_remaining(null);
    expect(results).toEqual([]);
    expect(can_afford(results, 1e9)).toBe(true);
  });

  it('余量结果纯数据形态（可落库可断言）', () => {
    const r = new BudgetRemaining('tokens', 100, 30, 70);
    expect(r.remaining).toBe(70);
    expect(r.unavailable).toBe(false);
  });
});
