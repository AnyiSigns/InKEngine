/**
 * raw 输入解码 → TuiIntent（字符 + 控制键）。逐字符扫描，UTF-8 经
 * StringDecoder 跨 chunk 解码；ESC 视为 escape 语义（方向键未用，j/k 代替）。
 */

import { StringDecoder } from 'node:string_decoder';

import type { KeyName, TuiIntent } from './types.js';

const CHAR_KEY: Record<string, KeyName> = {
  '\r': 'enter',
  '\n': 'enter',
  '\u0003': 'ctrl-c',
  '\u0004': 'ctrl-c',
  '\u007f': 'backspace',
  '\b': 'backspace',
  '\t': 'tab',
  '\u001b': 'escape',
};

/** 解码缓冲解码器（每次 decode(chunk) 返回本次可识别的 intent 列表）。 */
export function createKeyDecoder(): { decode(chunk: Buffer): TuiIntent[] } {
  const decoder = new StringDecoder('utf8');
  return {
    decode(chunk: Buffer): TuiIntent[] {
      const text = decoder.write(chunk);
      const intents: TuiIntent[] = [];
      for (const char of text) {
        const mapped = CHAR_KEY[char];
        if (mapped !== undefined) {
          intents.push({ kind: 'key', name: mapped });
        } else {
          intents.push({ kind: 'char', char });
        }
      }
      return intents;
    },
  };
}
