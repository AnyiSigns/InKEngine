/**
 * cli tui 模式运行时：TTY = 全屏交互（raw + 整帧重画）；非 TTY = 逐行输入
 * 退化解（每行后打印当前帧，供脚本/管道/开发自测驱动，非产品自动化套件）。
 *
 * 装配复用 assembleCliHost（createHost composition root）+ EventHub +
 * attachEngineTransport（round_transports 观察链路），TuiActions 直接绑 host
 * bridge 方法表——不新造第二套命令面/装配。
 */

import { createInterface } from 'node:readline';

import { assembleCliHost } from '../host.js';
import { attachEngineTransport } from '../engine_attach.js';
import { EventHub } from '../events_hub.js';
import { formatEvent } from './fmt.js';
import { createTuiActions } from './actions.js';
import { TuiController } from './controller.js';
import { createKeyDecoder } from './keys.js';
import { renderFrame } from './views.js';
import type { TuiModel } from './model.js';

export interface TuiRunOptions {
  data_dir?: string;
  events_dir?: string;
  /** 显式放行（缺省 false：审批走交互裁决；--approve 仅限可信自动化直通）。 */
  approve?: boolean;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function drawFullscreen(stdout: NodeJS.WriteStream, model: TuiModel): void {
  stdout.write(`\x1b[2J\x1b[H${renderFrame(model).join('\n')}\n`);
}

async function runLineCommand(controller: TuiController, text: string): Promise<void> {
  const [command, ...rest] = text.slice(1).split(/\s+/);
  const arg = rest.join(' ').trim();
  switch (command) {
    case 'chat':
    case 'sessions':
    case 'todos':
    case 'approvals':
      await controller.switchMode(command);
      return;
    case 'new':
      await controller.createAndOpen();
      return;
    case 'open': {
      const index = Number(arg);
      const target = controller.model.sessions[Number.isInteger(index) ? index : 0];
      if (target !== undefined) await controller.openSession(target.thread_id);
      return;
    }
    case 'send':
      await controller.submitChat(arg);
      return;
    case 'accept':
      await controller.resolveSelectedApproval('accept');
      return;
    case 'reject':
      await controller.resolveSelectedApproval('reject', arg);
      return;
    case 'edit':
      await controller.resolveSelectedApproval('edit', arg);
      return;
    case 'term':
      await controller.resolveSelectedApproval('terminate');
      return;
    case 'refresh':
      await controller.refreshApprovals();
      return;
    default:
      controller.model.status = `未知命令: :${command}`;
  }
}

/** tui 模式入口（argv 分发后调用；stdin/stdout 非 TTY 自动退化逐行模式）。 */
export async function runTui(options: TuiRunOptions): Promise<number> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const tty = stdin.isTTY === true && stdout.isTTY === true;

  const handle = await assembleCliHost({
    approve: options.approve ?? false,
    data_dir: options.data_dir,
    events_dir: options.events_dir,
  });
  const hub = new EventHub();
  const detachEngine = attachEngineTransport(handle.runtime, hub);
  const actions = createTuiActions(handle.bridge);

  const exit = deferred<void>();
  let cleanupRun = false;
  const cleanup = async (): Promise<void> => {
    if (cleanupRun) return;
    cleanupRun = true;
    detachEngine();
    await handle.dispose();
    exit.resolve();
  };

  const events = {
    on(cb: (line: { topic: string; text: string }) => void): () => void {
      const sub = hub.subscribe(['*'], (message) => {
        cb({ topic: message.topic, text: formatEvent(message.topic, message.data) });
      });
      return () => sub.close();
    },
  };

  const controller = new TuiController({
    actions,
    events,
    onFrame: tty
      ? (model): void => drawFullscreen(stdout, model)
      : (model): void => {
          stdout.write(`${renderFrame(model).join('\n')}\n`);
        },
    onExit: async (): Promise<void> => {
      if (tty) {
        try {
          stdin.setRawMode(false);
        } catch {
          // stdin 已关闭/非 raw 时忽略
        }
      }
      await cleanup();
    },
  });

  if (tty) {
    stdin.setRawMode(true);
    stdin.resume();
    const decoder = createKeyDecoder();
    const onData = (chunk: Buffer): void => {
      for (const intent of decoder.decode(chunk)) {
        void controller.onIntent(intent);
      }
    };
    stdin.on('data', onData);
  } else {
    const rl = createInterface({ input: stdin, terminal: false });
    const settled = (): Promise<void> => new Promise((r) => setTimeout(r, 60));
    rl.on('line', (line) => {
      const text = line.replace(/\r$/, '').trim();
      if (text === '') return;
      void (async () => {
        if (text.startsWith(':')) {
          await runLineCommand(controller, text);
        } else {
          if (controller.model.activeThread === null) {
            await controller.createAndOpen();
          }
          await controller.submitChat(text);
        }
        await settled();
      })();
    });
    rl.on('close', () => {
      void controller.exit();
    });
  }

  await controller.start();
  await exit.promise;
  return 0;
}
