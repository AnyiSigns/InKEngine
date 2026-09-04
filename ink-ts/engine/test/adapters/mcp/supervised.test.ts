/**
 * MCP stdio 进程监督单测：重启策略数据化 + 崩溃拉起 + 熔断（镜像 Python
 * test_mcp_supervision.py；打开器 seam 注入，零真实进程确定性验证）。
 */
import { describe, expect, it } from 'vitest';

import {
  McpConnectionLost,
  McpServerConfig,
  McpToolImportError,
  McpTransport,
  StdioRestartPolicy,
  SupervisedStdioSession,
  TaskCancelled,
  type McpSessionHandle,
  type McpToolRecord,
} from '../../../src/adapters/mcp/index.js';

class FakeHandle implements McpSessionHandle {
  name: string;
  fail_call_tools: number;
  ping_available: boolean;
  calls: string[] = [];
  closed = false;
  pings = 0;

  constructor(name: string, fail_call_tools = 0, ping_available = true) {
    this.name = name;
    this.fail_call_tools = fail_call_tools;
    this.ping_available = ping_available;
  }

  async list_tools(): Promise<McpToolRecord[]> {
    this.calls.push('list_tools');
    if (this.fail_list_tools > 0) {
      this.fail_list_tools -= 1;
      throw new Error(`${this.name} process died`);
    }
    return [];
  }

  fail_list_tools = 0;

  async call_tool(name: string): Promise<string> {
    this.calls.push(`call:${name}`);
    if (this.fail_call_tools > 0) {
      this.fail_call_tools -= 1;
      throw new Error(`${this.name} process died`);
    }
    return `ok-${name}`;
  }

  async ping(): Promise<void> {
    this.pings += 1;
    if (!this.ping_available) {
      throw new McpConnectionLost('ping failed');
    }
  }

  async aclose(): Promise<void> {
    this.closed = true;
  }
}

function config(policy: Partial<{ max_retries: number; backoff: number; circuit_break_threshold: number }> = {}): McpServerConfig {
  return new McpServerConfig({
    id: 's1',
    transport: McpTransport.STDIO,
    command: 'pyserver',
    restart_policy: new StdioRestartPolicy(policy),
  });
}

describe('StdioRestartPolicy 监督策略数据化', () => {
  it('缺省值保守（2/1.0/3）', () => {
    const policy = new StdioRestartPolicy();
    expect(policy.max_retries).toBe(2);
    expect(policy.backoff).toBe(1.0);
    expect(policy.circuit_break_threshold).toBe(3);
  });
});

describe('受监督会话（SupervisedStdioSession）', () => {
  it('健康会话委托：调用与列举直达底层句柄', async () => {
    const handle = new FakeHandle('fake');
    const supervised = new SupervisedStdioSession(config(), { initial: handle });
    expect(await supervised.call_tool('lookup', { q: 1 })).toBe('ok-lookup');
    expect(await supervised.list_tools()).toEqual([]);
    expect(handle.calls).toEqual(['call:lookup', 'list_tools']);
  });

  it('崩溃 → 拉起（新会话）→ 本次调用诚实失败、下次调用走新会话', async () => {
    const oldHandle = new FakeHandle('old', 1);
    const freshHandle = new FakeHandle('new');
    const opens = { n: 0 };
    const supervised = new SupervisedStdioSession(config({ backoff: 0 }), {
      initial: oldHandle,
      opener: async () => {
        opens.n += 1;
        return freshHandle;
      },
    });
    await expect(supervised.call_tool('lookup', {})).rejects.toThrow(/已按策略拉起/);
    expect(opens.n).toBe(1); // 崩溃后拉起一次
    expect(oldHandle.closed).toBe(true); // 旧会话清理
    // 拉起成功 → 计数清零；下次调用命中新会话
    await expect(supervised.call_tool('lookup', {})).resolves.toBe('ok-lookup');
    expect(freshHandle.calls).toEqual(['call:lookup']);
    expect(supervised.consecutive_failures).toBe(0);
  });

  it('拉起重试耗尽 → 连续失败计数 → 熔断打开 → fail-closed', async () => {
    const attempts = { n: 0 };
    const supervised = new SupervisedStdioSession(
      config({ max_retries: 2, backoff: 0, circuit_break_threshold: 2 }),
      {
        initial: new FakeHandle('dead', 1),
        opener: async () => {
          attempts.n += 1;
          throw new Error('spawn exploded');
        },
      },
    );
    // 首轮复用既有会话（0 次可用性尝试）+ 2 次重启；之后会话已清除 →
    // 每次 1 次可用性尝试 + 2 次重启
    const expectations = [2, 5];
    for (let i = 0; i < 2; i += 1) {
      await expect(supervised.call_tool('lookup', {})).rejects.toThrow(/崩溃且重启失败/);
      expect(attempts.n).toBe(expectations[i]);
    }
    expect(supervised.circuit_open).toBe(true);
    // 熔断打开：直接拒绝，不再尝试拉起
    await expect(supervised.call_tool('lookup', {})).rejects.toThrow(/熔断已打开/);
    expect(attempts.n).toBe(5); // 未再拉起
  });

  it('拉起成功清零连续失败分（熔断只凭健康度判定）', async () => {
    const state = { fail: true };
    const supervised = new SupervisedStdioSession(
      config({ max_retries: 0, backoff: 0, circuit_break_threshold: 3 }),
      {
        initial: new FakeHandle('dead', 99),
        opener: async () => {
          if (state.fail) throw new Error('spawn exploded');
          return new FakeHandle('fresh');
        },
      },
    );
    // max_retries=0：不做拉起（fail-fast），但累计失败分
    for (let i = 0; i < 2; i += 1) {
      await expect(supervised.call_tool('lookup', {})).rejects.toThrow(/崩溃且重启失败/);
    }
    expect(supervised.consecutive_failures).toBe(2);
    expect(supervised.circuit_open).toBe(false); // 未达阈值
    // 下一次：会话已在失败路径清除 → 重新建立成功 → 计分清零，调用直接成功
    state.fail = false;
    await expect(supervised.call_tool('lookup', {})).resolves.toBe('ok-lookup');
    expect(supervised.consecutive_failures).toBe(0);
    expect(supervised.circuit_open).toBe(false);
  });

  it('health_check 探测（协议级 ping）', async () => {
    const handle = new FakeHandle('fake');
    const supervised = new SupervisedStdioSession(config(), { initial: handle });
    expect(await supervised.health_check()).toBe(true);
    expect(handle.pings).toBe(1);
  });

  it('health_check 崩溃探测后拉起（恢复成功返回 True）', async () => {
    const handle = new FakeHandle('dead', 0, false); // ping 抛错 = 崩溃
    const opened = { n: 0 };
    const supervised = new SupervisedStdioSession(config({ backoff: 0 }), {
      initial: handle,
      opener: async () => {
        opened.n += 1;
        return new FakeHandle(`recovered-${opened.n}`);
      },
    });
    expect(await supervised.health_check()).toBe(true);
    expect(opened.n).toBe(1);
    expect(supervised.consecutive_failures).toBe(0);
  });

  it('health_check 熔断打开返回 False', async () => {
    const supervised = new SupervisedStdioSession(
      config({ max_retries: 1, backoff: 0, circuit_break_threshold: 1 }),
      {
        initial: new FakeHandle('dead', 0, false),
        opener: async () => {
          throw new Error('spawn exploded');
        },
      },
    );
    expect(await supervised.health_check()).toBe(false);
    expect(supervised.circuit_open).toBe(true);
  });

  it('取消异常原样穿透（不误判为进程崩溃）', async () => {
    class CancelledSession implements McpSessionHandle {
      async list_tools(): Promise<McpToolRecord[]> {
        return [];
      }
      async call_tool(): Promise<string> {
        throw new TaskCancelled();
      }
      async aclose(): Promise<void> {
        return undefined;
      }
    }
    const supervised = new SupervisedStdioSession(config(), {
      initial: new CancelledSession(),
    });
    await expect(supervised.call_tool('lookup', {})).rejects.toBeInstanceOf(TaskCancelled);
  });

  it('连接断流拉起后重试一次原操作成功（E-P15）', async () => {
    class LostSession implements McpSessionHandle {
      async list_tools(): Promise<McpToolRecord[]> {
        return [];
      }
      async call_tool(): Promise<string> {
        throw new McpConnectionLost('connection closed（首次调用断流）');
      }
      async aclose(): Promise<void> {
        return undefined;
      }
    }
    class HealthySession implements McpSessionHandle {
      hits = 0;
      async list_tools(): Promise<McpToolRecord[]> {
        return [];
      }
      async call_tool(name: string): Promise<string> {
        this.hits += 1;
        return `ok-${name}`;
      }
      async aclose(): Promise<void> {
        return undefined;
      }
    }
    const old = new LostSession();
    const fresh = new HealthySession();
    const supervised = new SupervisedStdioSession(config({ backoff: 0 }), {
      initial: old,
      opener: async () => fresh,
    });
    // 断流 → 拉起 → 重试一次 → 成功（不诚实失败）
    await expect(supervised.call_tool('lookup', {})).resolves.toBe('ok-lookup');
    expect(fresh.hits).toBe(1);
  });

  it('aclose 切断监督并释放句柄（后续访问重新建立）', async () => {
    const handle = new FakeHandle('old', 99);
    const supervised = new SupervisedStdioSession(config({ backoff: 0 }), {
      initial: handle,
      opener: async () => new FakeHandle('fresh'),
    });
    await supervised.aclose();
    expect(handle.closed).toBe(true);
    expect(supervised.circuit_open).toBe(false);
    expect(supervised.consecutive_failures).toBe(0);
    // 会话已清除：再次调用经 opener 重建
    await expect(supervised.call_tool('lookup', {})).resolves.toBe('ok-lookup');
  });
});
