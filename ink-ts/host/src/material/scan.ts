/**
 * 既有资料批量导入（参照旧壳 import_material.rs 语义，TS 自实现）。
 *
 * 目录扫描（可递归）+ 格式归一：doc/pdf/xlsx/pptx 走 doc 执行体文本提取，
 * 纯文本直读 UTF-8。安全收口（fail-closed）：扫描根须在允许导入根内
 * （缺省用户主目录域，可配置）；递归深度/文件数/单文件体积三道上限，
 * 文件数越限 = 结构化拒绝（不部分放行），单文件越体积 = 记 skipped。
 * 符号链接不跟随（防越出扫描根），显式记 skipped。产物交调用方入会话。
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { DocParser } from '../doc/_types.js';

/** 默认：允许导入的根（用户主目录域；env INK_MATERIAL_ROOTS 可覆写）。 */
export function defaultMaterialRoots(): string[] {
  return [os.homedir()];
}

/** 递归扫描最大深度（相对扫描根）。 */
export const DEFAULT_MATERIAL_MAX_DEPTH = 6;
/** 单次扫描文件数硬上限。 */
export const DEFAULT_MATERIAL_MAX_FILES = 2000;
/** 单文件体积上限（字节）。 */
export const DEFAULT_MATERIAL_MAX_BYTES = 20 * 1024 * 1024;

/** 文档格式（走 doc 执行体归一）。 */
export const MATERIAL_DOC_EXTS = ['pdf', 'docx', 'xlsx', 'pptx'] as const;
/** 纯文本格式（直读 UTF-8 归一）。 */
export const MATERIAL_TEXT_EXTS = ['txt', 'md', 'markdown', 'json', 'csv', 'log'] as const;

/** 越限/非法错误（fail-closed；code 供归类）。 */
export class MaterialError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'MaterialError';
    this.code = code;
  }
}

/** 归一后单条文件。 */
export interface MaterialFile {
  path: string;
  format: string;
  size: number;
  /** 提取文本（文本文件直读 / 文档经 doc 执行体；截断带标记）。 */
  text: string;
  truncated: boolean;
}

export interface MaterialSkipped {
  path: string;
  reason: string;
}

export interface MaterialScanOutcome {
  root: string;
  recursive: boolean;
  scanned: number;
  files: MaterialFile[];
  skipped: MaterialSkipped[];
}

export interface MaterialScanOptions {
  root: string;
  recursive?: boolean;
  maxDepth?: number;
  maxFiles?: number;
  maxFileBytes?: number;
  /** 单文件文本截断上限（缺省 20000；文档解析器另有 exec 上界）。 */
  textCap?: number;
}

export interface MaterialScanDeps {
  /** 文档解析执行体（doc ext 必需；缺省 = doc 一律 skipped）。 */
  parse?: DocParser;
  /** 允许导入根（缺省 = 用户主目录；覆写替换默认）。 */
  allowedRoots?: string[];
}

/** `~` 展开 + 绝对路径校验。 */
export async function expandPath(raw: string): Promise<string> {
  const trimmed = raw.trim();
  let expanded = trimmed;
  if (trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    expanded = path.join(os.homedir(), trimmed.slice(1).replace(/^[/\\]/, ''));
  }
  if (!path.isAbsolute(expanded)) {
    throw new MaterialError('not_absolute', `路径须为绝对路径: ${raw}`);
  }
  return path.normalize(expanded);
}

async function withinAny(target: string, roots: readonly string[]): Promise<boolean> {
  for (const rootRaw of roots) {
    const root = await expandPath(rootRaw).catch(() => null);
    if (root === null) continue;
    const rel = path.relative(root, target);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return true;
  }
  return false;
}

function formatOf(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase().replace('.', '');
  return ext;
}

/** 扫描根目录并归一（越限结构化拒绝）。 */
export async function scanMaterial(
  options: MaterialScanOptions,
  deps: MaterialScanDeps = {},
): Promise<MaterialScanOutcome> {
  const root = await expandPath(options.root);
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(root);
  } catch {
    throw new MaterialError('not_found', `导入路径不存在: ${root}`);
  }
  if (!stat.isDirectory()) {
    throw new MaterialError('not_dir', `导入路径不是目录: ${root}`);
  }
  const allowedRoots = deps.allowedRoots ?? defaultMaterialRoots();
  if (!(await withinAny(root, allowedRoots))) {
    throw new MaterialError('denied', `路径不在允许导入根内: ${root}`);
  }
  const maxFiles = options.maxFiles ?? DEFAULT_MATERIAL_MAX_FILES;
  const maxBytes = options.maxFileBytes ?? DEFAULT_MATERIAL_MAX_BYTES;
  const maxDepth = options.maxDepth ?? DEFAULT_MATERIAL_MAX_DEPTH;
  const textCap = options.textCap ?? 20000;
  const recursive = options.recursive ?? true;
  if (!Number.isInteger(maxFiles) || maxFiles <= 0 || maxFiles > DEFAULT_MATERIAL_MAX_FILES) {
    throw new MaterialError('invalid_params', `maxFiles 越界（1–${DEFAULT_MATERIAL_MAX_FILES}）`);
  }
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new MaterialError('invalid_params', 'maxFileBytes 须为正整数');
  }
  const outcome: MaterialScanOutcome = {
    root,
    recursive,
    scanned: 0,
    files: [],
    skipped: [],
  };
  await walk(root, 0, maxDepth, recursive, maxFiles, maxBytes, textCap, deps.parse ?? null, outcome);
  return outcome;
}

async function walk(
  dir: string,
  depth: number,
  maxDepth: number,
  recursive: boolean,
  maxFiles: number,
  maxBytes: number,
  textCap: number,
  parser: DocParser | null,
  outcome: MaterialScanOutcome,
): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      outcome.skipped.push({
        path: full,
        reason: '符号链接不跟随（防越出扫描根）',
      });
      continue;
    }
    if (entry.isDirectory()) {
      if (recursive && depth + 1 <= maxDepth) {
        await walk(full, depth + 1, maxDepth, recursive, maxFiles, maxBytes, textCap, parser, outcome);
      }
      continue;
    }
    if (!entry.isFile()) continue;
    if (outcome.files.length >= maxFiles) {
      throw new MaterialError('over_file_limit', `超过单次扫描文件数上限 ${maxFiles}（fail-closed，不部分放行）`);
    }
    outcome.scanned += 1;
    const size = await safeSize(full);
    if (size === null) continue;
    if (size > maxBytes) {
      outcome.skipped.push({ path: full, reason: `单文件超体积上限 ${maxBytes} 字节` });
      continue;
    }
    const format = formatOf(entry.name);
    if ((MATERIAL_DOC_EXTS as readonly string[]).includes(format)) {
      if (parser === null) {
        outcome.skipped.push({ path: full, reason: '文档解析执行体未装配（doc ext 无法归一）' });
        continue;
      }
      const parsed = await parser.parseDocument(full, dir, textCap);
      if (!parsed.ok) {
        outcome.skipped.push({ path: full, reason: `格式解析失败（${parsed.code}）：${parsed.message}` });
        continue;
      }
      outcome.files.push({
        path: full,
        format,
        size,
        text: truncate(parsed.text, textCap),
        truncated: parsed.truncated || parsed.text.length > textCap,
      });
      continue;
    }
    if ((MATERIAL_TEXT_EXTS as readonly string[]).includes(format)) {
      try {
        const text = await fs.readFile(full, 'utf8');
        outcome.files.push({
          path: full,
          format,
          size,
          text: truncate(text, textCap),
          truncated: text.length > textCap,
        });
      } catch (error) {
        outcome.skipped.push({
          path: full,
          reason: `文本读取失败: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      continue;
    }
    outcome.skipped.push({ path: full, reason: `不支持的格式: ${format}` });
  }
}

async function safeSize(full: string): Promise<number | null> {
  try {
    const stat = await fs.stat(full);
    return stat.size;
  } catch {
    return null;
  }
}

function truncate(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}…（已截断）`;
}
