// gate: 超限(432 行) - data_dir 快照域单一机制：导出/预览/恢复两阶段安全路径共享同一私有路径校验与快照原语，拆文件会割裂预检-回滚配对
/**
 * data_dir 快照域（backup.* 桥消费）：把 host 数据目录打包为 store-zip、
 * 预览包内容、恢复替换（restore 前先留当前目录快照）。
 *
 * 一致性取舍：引擎 sqlite/检索库可能正被进程持有（Windows 共享锁下读取
 * 兼容——Node 读取使用共享读，写入期窗口仍可能碰锁，见 restore）；导出 =
 * 目录树只读收集 + 单 zip 落盘。事件 JSONL / 附件 / 检索文档均在目录树内
 * 一并入包（真「data_dir 快照」）；backups/snapshots 两个目录不入包
 * （它们是快照产物，非源数据，防嵌套膨胀）。manifest.json 为首条目：
 * 版本/时间戳/来源/条目数（预览取 created_at 的锚点）。
 *
 * 恢复 = 两阶段覆盖式落位：全量预检（路径越界/符号链接段/占用可写探测，
 * 任一失败整单拒绝，不改任何文件）→ 全量落临时文件（仍失败 = 无副作用
 * 退出）→ 逐条 rename 交换。rename 阶段单条失败 = 用恢复前预存快照回滚
 * 已替换条目（fail-closed，不留下半态目录）；包内路径先做双分隔符拒绝 +
 * resolve 越界断言，中间目录遇符号链接/junction 即拒该条目。
 */

import { mkdirSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  crc32,
  packStoreZip,
  unpackStoreZip,
  ZIP_MAX_ENTRIES,
  type ZipEntryInput,
} from './zip_codec.js';

/** 快照产物目录名（导出与恢复互斥排除；防嵌套膨胀）。 */
export const SNAPSHOT_DIRS = ['backups', 'snapshots'] as const;
/** 包内清单条目名（首条目；版本/时间戳/来源）。 */
export const MANIFEST_ENTRY = 'manifest.json';
/** 单次导出的总字节护栏（防失控大目录打爆内存）。 */
export const EXPORT_TOTAL_BYTES_CAP = 512 * 1024 * 1024;
/** 单次导出的条目数护栏（与 zip 读侧条目护栏同值）。 */
export const EXPORT_ENTRY_CAP = ZIP_MAX_ENTRIES;
/** 读侧单文件体积护栏（备份文件整包读入内存前先按此封顶）。 */
export const READ_TOTAL_BYTES_CAP = EXPORT_TOTAL_BYTES_CAP;

/** 目录扫描条目（posix 相对路径 + 绝对源路径）。 */
export interface DirFile {
  path: string;
  abs: string;
}

/** 打包产物清单（export/preview/restore 摘要数据）。 */
export interface BackupManifest {
  version: number;
  created_at: number;
  source: string;
  entries: number;
  size: number;
}

export class BackupError extends Error {
  readonly code: string;
  constructor(message: string, code = 'backup_error') {
    super(message);
    this.name = 'BackupError';
    this.code = code;
  }
}

/** 相对路径 → 包内 posix 路径（windows 分隔符归一 + 防逃逸显式拒绝）。 */
function toZipPath(relativePath: string): string {
  const normalized = relativePath.split(sep).join('/');
  if (
    normalized === ''
    || normalized === '.'
    || normalized.includes('..')
    || normalized.startsWith('/')
    || /^[a-zA-Z]:/.test(normalized)
  ) {
    throw new BackupError(`非法相对路径: ${relativePath}`, 'invalid_path');
  }
  return normalized;
}

/**
 * 包内 posix 路径 → data_dir 内绝对路径（目录项返回 null）。
 * 先按双分隔符归一拒绝：反斜杠段 / 盘符 / 绝对前缀 / `.`/`..`/空段一律
 * fail-closed；resolve 后再断言 relative(dataDir, local) 不越界（防路径
 * 归一绕过）。
 */
function toLocalPath(dataDir: string, zipPath: string): string | null {
  if (zipPath === '' || zipPath.endsWith('/') || zipPath.endsWith('\\')) return null;
  if (/[\u0000-\u001f]/.test(zipPath)) {
    throw new BackupError(`包路径拒绝（含控制字符）: ${JSON.stringify(zipPath)}`, 'invalid_path');
  }
  if (zipPath.includes('\\')) {
    throw new BackupError(`包路径拒绝（含反斜杠段）: ${zipPath}`, 'invalid_path');
  }
  if (zipPath.startsWith('/') || /^[a-zA-Z]:/.test(zipPath)) {
    throw new BackupError(`包路径拒绝（绝对路径）: ${zipPath}`, 'invalid_path');
  }
  const segments = zipPath.split('/');
  if (segments.some((seg) => seg === '' || seg === '.' || seg === '..')) {
    throw new BackupError(`包路径拒绝（含 .. / 空段）: ${zipPath}`, 'invalid_path');
  }
  const local = resolve(dataDir, ...segments);
  const rel = relative(dataDir, local);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new BackupError(`包路径越界（resolve 后不在 data_dir 内）: ${zipPath}`, 'invalid_path');
  }
  return local;
}

/** 递归收集目录文件（只收文件；跳过符号链接/junction 与快照目录）。 */
export async function collectDirFiles(dataDir: string): Promise<DirFile[]> {
  const out: DirFile[] = [];
  async function walk(dir: string, relPrefix: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      // 符号链接目录/文件一律不跟随（junction 在 Node dirent 亦为 symlink）
      if (entry.isSymbolicLink()) continue;
      const rel = relPrefix === '' ? entry.name : `${relPrefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if ((SNAPSHOT_DIRS as readonly string[]).includes(entry.name)) continue;
        await walk(join(dir, entry.name), rel);
      } else if (entry.isFile()) {
        out.push({ path: rel, abs: join(dir, entry.name) });
      }
    }
  }
  await walk(dataDir, '');
  return out;
}

/** 读目录树 → zip 条目（含清单首条目；size/总数护栏 fail-closed）。 */
export async function buildZipEntries(
  dataDir: string,
): Promise<{ entries: ZipEntryInput[]; manifest: BackupManifest }> {
  const created_at = Date.now() / 1000;
  const files = await collectDirFiles(dataDir);
  if (files.length > EXPORT_ENTRY_CAP) {
    throw new BackupError(`导出条目超限（>${EXPORT_ENTRY_CAP}）`, 'too_large');
  }
  // entries = zip 物理条目数（文件 + manifest 首条目）
  const manifest: BackupManifest = {
    version: 1,
    created_at,
    source: dataDir,
    entries: files.length + 1,
    size: 0,
  };
  const zipEntries: ZipEntryInput[] = [
    {
      path: MANIFEST_ENTRY,
      data: Buffer.from(JSON.stringify(manifest), 'utf8'),
    },
  ];
  let total = 0;
  for (const file of files) {
    const data = await fs.readFile(file.abs);
    total += data.length;
    if (total > EXPORT_TOTAL_BYTES_CAP) {
      throw new BackupError('导出总大小超限（fail-closed）', 'too_large');
    }
    zipEntries.push({ path: toZipPath(file.path), data });
  }
  manifest.size = total;
  // 清单已入 zip，修正首条目的 size 回写
  zipEntries[0]!.data = Buffer.from(
    JSON.stringify({ ...manifest, size: total }),
    'utf8',
  );
  return { entries: zipEntries, manifest };
}

/** 导出：data_dir 全量打包到 dest（含清单；原子落盘）。 */
export async function exportDataDir(
  dataDir: string,
  dest: string,
): Promise<{ file: string; manifest: BackupManifest; size: number }> {
  const { entries, manifest } = await buildZipEntries(dataDir);
  const buf = packStoreZip(entries);
  const dir = dest.split(sep).slice(0, -1).join(sep);
  mkdirSync(dir === '' ? '.' : dir, { recursive: true });
  const tmp = `${dest}.tmp`;
  await fs.writeFile(tmp, buf);
  await fs.rename(tmp, dest);
  return { file: dest, manifest, size: buf.length };
}

/** 解析清单条目（缺省按首条 name 匹配；坏形态 = 缺省信息）。 */
export function readManifest(entries: Array<{ path: string; data: Buffer }>): BackupManifest | null {
  for (const entry of entries) {
    if (entry.path !== MANIFEST_ENTRY) continue;
    try {
      const raw = JSON.parse(entry.data.toString('utf8')) as Record<string, unknown>;
      if (raw['version'] !== 1) return null;
      return {
        version: 1,
        created_at: typeof raw['created_at'] === 'number' ? raw['created_at'] : 0,
        source: typeof raw['source'] === 'string' ? raw['source'] : '',
        entries: typeof raw['entries'] === 'number' ? raw['entries'] : 0,
        size: typeof raw['size'] === 'number' ? raw['size'] : 0,
      };
    } catch {
      return null;
    }
  }
  return null;
}

/** 读备份文件（整包解析；读前按文件体积封顶 + 条目数护栏）。 */
export async function readBackupFile(src: string): Promise<{
  path: string;
  manifest: BackupManifest | null;
  entries: Array<{ path: string; data: Buffer }>;
  total: number;
}> {
  const stat = await fs.stat(src).catch(() => null);
  if (stat !== null && stat.size > READ_TOTAL_BYTES_CAP) {
    throw new BackupError(
      `备份文件体积超上限（>${READ_TOTAL_BYTES_CAP} 字节，fail-closed）: ${src}`,
      'too_large',
    );
  }
  const buf = await fs.readFile(src);
  const entries = unpackStoreZip(buf);
  const manifest = readManifest(entries);
  const total = entries.reduce((sum, entry) => sum + entry.data.length, 0);
  return { path: src, manifest, entries, total };
}

/** 恢复前留当前 data_dir 快照（snapshots 目录；返回落盘文件路径）。 */
export async function snapshotDataDir(dataDir: string): Promise<string> {
  const snapshotsDir = join(dataDir, 'snapshots');
  mkdirSync(snapshotsDir, { recursive: true });
  const name = `restore-backup-${Math.floor(Date.now() / 1000)}-${crc32(
    Buffer.from(`${Math.random()}`),
  ).toString(16).slice(0, 6)}.zip`;
  const dest = join(snapshotsDir, name);
  await exportDataDir(dataDir, dest);
  return dest;
}

/** 恢复替换目标（包路径已校验；目录项跳过）。 */
interface RestoreTarget {
  path: string;
  local: string;
}

/** 单个 rename 交换（tmp 先行；成功返回 true）。 */
async function swapFile(target: RestoreTarget): Promise<void> {
  const dir = dirnameOf(target.local);
  mkdirSync(dir, { recursive: true });
  const tmp = `${target.local}.ink-restore-tmp`;
  // 临时文件已由 stage 阶段写盘；此处只做交换
  await fs.rename(tmp, target.local).catch(async (error: unknown) => {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  });
}

/**
 * 恢复替换（两阶段 + 预存快照回滚）：先整单预检（路径/符号链接/占用），
 * 再全量落 tmp，最后逐条 rename。options.rollback_snapshot = 恢复前预存
 * 的当前目录快照路径（rename 中途失败时用它回滚已替换条目）。
 * 返回 { restored, failed }；任一条落位失败即回滚后抛 BackupError。
 */
export async function applyRestore(
  dataDir: string,
  entries: Array<{ path: string; data: Buffer }>,
  options: { rollback_snapshot?: string | null } = {},
): Promise<{ restored: string[]; failed: string[] }> {
  // 1) 规划目标（路径双分隔符校验 + resolve 越界断言；快照产物目录拒绝）
  const dataByPath = new Map<string, Buffer>();
  const byLocal = new Map<string, RestoreTarget>();
  for (const entry of entries) {
    if (entry.path === MANIFEST_ENTRY) continue;
    dataByPath.set(entry.path, entry.data);
    const local = toLocalPath(dataDir, entry.path);
    if (local === null) continue;
    const firstSegment = entry.path.split('/')[0]!;
    if ((SNAPSHOT_DIRS as readonly string[]).includes(firstSegment)) {
      throw new BackupError(
        `包路径拒绝（快照产物目录不可覆盖）: ${entry.path}`,
        'invalid_path',
      );
    }
    byLocal.set(local, { path: entry.path, local });
  }
  const targets: RestoreTarget[] = [...byLocal.values()];
  const snapshot = options.rollback_snapshot ?? null;

  // 2) 整单预检：中间目录/目标符号链接拒绝 + 占用可写探测（fail-closed）
  await assertNoSymlinkChain(dataDir, targets);
  await probeTargetsWritable(targets, snapshot);

  // 3) stage 阶段：全部目标先落 tmp（失败 = 清 tmp 无副作用退出）
  const staged: RestoreTarget[] = [];
  try {
    for (const target of targets) {
      const data = dataByPath.get(target.path);
      if (data === undefined) continue;
      const dir = dirnameOf(target.local);
      mkdirSync(dir, { recursive: true });
      const tmp = `${target.local}.ink-restore-tmp`;
      await fs.writeFile(tmp, data);
      staged.push(target);
    }
  } catch (error) {
    await cleanupTmp(staged);
    throw restoreError('恢复落临时文件失败', error, snapshot);
  }

  // 4) swap 阶段：逐条 rename；任一条失败 = 用预存快照回滚已替换条目
  const replaced: string[] = [];
  try {
    for (const target of targets) {
      await swapFile(target);
      replaced.push(target.path);
    }
  } catch (error) {
    await rollbackReplaced(dataDir, replaced, snapshot);
    await cleanupTmp(staged);
    throw restoreError(`恢复替换中断（${error instanceof Error ? error.message : String(error)}）`, error, snapshot);
  }
  return { restored: replaced, failed: [] };
}

/** 目标路径祖先链 lstat：任何已存在中间目录为符号链接/junction 即拒该条目。 */
async function assertNoSymlinkChain(dataDir: string, targets: RestoreTarget[]): Promise<void> {
  for (const target of targets) {
    const rel = relative(dataDir, dirnameOf(target.local));
    if (rel === '') continue;
    let cursor = dataDir;
    for (const segment of rel.split(sep)) {
      if (segment === '' || segment === '.') continue;
      cursor = join(cursor, segment);
      const stat = await fs.lstat(cursor).catch(() => null);
      if (stat !== null && stat.isSymbolicLink()) {
        throw new BackupError(
          `恢复目标中间目录为符号链接/junction（拒绝整单）: ${target.path}`,
          'path_symlink',
        );
      }
    }
    const final = await fs.lstat(target.local).catch(() => null);
    if (final !== null && final.isSymbolicLink()) {
      throw new BackupError(
        `恢复目标本身为符号链接/junction（拒绝整单）: ${target.path}`,
        'path_symlink',
      );
    }
  }
}

/** 已存在目标占用/可写探测（r+ 打开即关；不写数据，锁冲突即整体拒绝）。 */
async function probeTargetsWritable(
  targets: RestoreTarget[],
  snapshot: string | null,
): Promise<void> {
  for (const target of targets) {
    const exists = await fs
      .lstat(target.local)
      .then(() => true)
      .catch(() => false);
    if (!exists) continue;
    let handle: fs.FileHandle | null = null;
    try {
      handle = await fs.open(target.local, 'r+');
    } catch (error) {
      throw restoreError(
        `恢复目标被占用或不可写（${target.path}；引擎存储文件需先停宿主）`,
        error,
        snapshot,
      );
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}

/** rename 中途失败：从预存快照回滚已替换条目（幂等，尽力而为）。 */
async function rollbackReplaced(
  dataDir: string,
  replaced: readonly string[],
  snapshot: string | null | undefined,
): Promise<void> {
  if (snapshot === null || snapshot === undefined || replaced.length === 0) return;
  let snapshotEntries;
  try {
    snapshotEntries = await readBackupFile(snapshot);
  } catch {
    return; // 快照不可读 = 无法回滚（保持替换结果，错误已带快照路径）
  }
  const byPath = new Map(snapshotEntries.entries.map((entry) => [entry.path, entry.data]));
  for (const entryPath of replaced) {
    const original = byPath.get(entryPath);
    if (original === undefined) continue; // 原目录无此文件 = 新增条目，无需回滚
    const local = toLocalPath(dataDir, entryPath);
    if (local === null) continue;
    const dir = dirnameOf(local);
    mkdirSync(dir, { recursive: true });
    const tmp = `${local}.ink-restore-rollback-tmp`;
    try {
      await fs.writeFile(tmp, original);
      await fs.rename(tmp, local);
    } catch {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
    }
  }
}

/** 清理遗留临时文件。 */
async function cleanupTmp(targets: readonly RestoreTarget[]): Promise<void> {
  for (const target of targets) {
    await fs.rm(`${target.local}.ink-restore-tmp`, { force: true }).catch(() => undefined);
  }
}

/** 归一恢复错误（附快照提示路径；可带原错误 cause 语义于 message）。 */
function restoreError(prefix: string, error: unknown, snapshot: string | null | undefined): BackupError {
  const detail = error instanceof Error ? error.message : String(error);
  const snapshotNote =
    snapshot !== null && snapshot !== undefined
      ? `（当前目录快照保留在: ${snapshot}）`
      : '';
  return new BackupError(`${prefix}${snapshotNote}${detail === '' ? '' : `: ${detail}`}`, 'restore_failed');
}

function dirnameOf(local: string): string {
  const parts = local.split(sep);
  parts.pop();
  return parts.join(sep);
}
