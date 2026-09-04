/**
 * 真实进程监督用例（镜像 Python test_mcp_threaded_stdio.py 的监督类）：
 * 真实 echo server 崩溃 → 拉起 + 重试一次成功（E-P15）；真实进程反复
 * 启动即崩 → 拉起耗尽 → 熔断打开 → fail-closed。
 *
 * 逻辑级监督（假句柄 + opener seam，零进程）见 supervised.test.ts；本
 * 文件钉住真实子进程路径的端到端确定性行为。
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';

import {
  McpClientManager,
  StdioRestartPolicy,
  SupervisedStdioSession,
} from '../../../src/adapters/mcp/index.js';
import { cleanup_tmp_dirs, echo_config, tmp_dir } from './_helpers.js';

afterEach(() => {
  cleanup_tmp_dirs();
});

describe('真实进程监督（SupervisedStdioSession）', () => {
  it('真实进程崩溃（首次 tools/call 后 exit）→ 拉起 + 重试一次成功（E-P15）', async () => {
    const crashFile = path.join(tmp_dir(), 'crash.marker');
    const config = echo_config({
      crash_file: crashFile,
      restart_policy: new StdioRestartPolicy({ max_retries: 1, backoff: 0 }),
    });
    const manager = new McpClientManager();
    const supervised = (await manager.connect(config)) as SupervisedStdioSession;
    try {
      // 首次调用触发真实进程崩溃 → 拉起新进程 → 重试一次成功
      await expect(supervised.call_tool('echo_text', { text: 'x' })).resolves.toBe('x');
      expect(supervised.consecutive_failures).toBe(0);
      // 第二次调用命中新会话，正常
      await expect(supervised.call_tool('echo_text', { text: 'ok' })).resolves.toBe('ok');
    } finally {
      await supervised.aclose();
    }
  });

  it('真实进程反复启动即崩 → 拉起耗尽 → 熔断打开 → fail-closed', async () => {
    const config = echo_config({
      die_on_start: true,
      restart_policy: new StdioRestartPolicy({
        max_retries: 1,
        backoff: 0,
        circuit_break_threshold: 2,
      }),
    });
    const supervised = new SupervisedStdioSession(config);
    try {
      for (let i = 0; i < 2; i += 1) {
        await expect(supervised.call_tool('echo_text', { text: 'x' })).rejects.toThrow(/崩溃/);
      }
      expect(supervised.circuit_open).toBe(true);
      await expect(supervised.call_tool('echo_text', { text: 'x' })).rejects.toThrow(/熔断已打开/);
    } finally {
      await supervised.aclose();
    }
  });
});
