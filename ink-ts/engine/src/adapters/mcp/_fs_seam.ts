/**
 * 观察模式的文件系统 seam（node:fs 后端）——镜像 Python 默认注入的
 * stdlib 实现（os/shutil/tempfile 动作）。TS core 零 IO：tool_vetting 的
 * shadow_run（写虚拟化：工作目录副本 + 快照 diff）需要宿主注入 FsSeam，
 * MCP 适配器属 IO 允许层，天然承载该 seam 的真实实现（含观察探针的
 * 空模板工作区创建/清理）。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FsSeam } from '../../core/tool_vetting/_types.js';

function _safeStatSize(p: string): number | null {
  try {
    return fs.statSync(p).size;
  } catch {
    return null;
  }
}

function _safeReadlink(p: string): string {
  return fs.readlinkSync(p);
}

/** 递归后代清单（含自身；路径形态与 Python pathlib.rglob 对齐）。 */
function _rglob(root: string): string[] {
  const out: string[] = [root];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    out.push(child);
    if (entry.isDirectory()) out.push(..._rglob(child));
  }
  return out;
}

/** 观察模式文件系统 seam（node:fs 同步后端，供 ToolVetting.shadow_run）。 */
export function create_node_fs_seam(): FsSeam {
  return {
    mkdtemp(prefix: string): string {
      return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    },
    rmtree(target: string, ignore_errors: boolean): void {
      try {
        fs.rmSync(target, { recursive: true, force: true });
      } catch (exc) {
        if (!ignore_errors) throw exc;
      }
    },
    is_dir(p: string): boolean {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
    is_file(p: string): boolean {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    },
    is_symlink(p: string): boolean {
      try {
        return fs.lstatSync(p).isSymbolicLink();
      } catch {
        return false;
      }
    },
    readlink(p: string): string {
      return _safeReadlink(p);
    },
    copy2(source: string, target: string): void {
      fs.copyFileSync(source, target);
    },
    symlink_to(link_target: string, link_path: string): void {
      fs.symlinkSync(link_target, link_path);
    },
    mkdir(p: string): void {
      fs.mkdirSync(p, { recursive: true });
    },
    iterdir(p: string): string[] {
      try {
        return fs.readdirSync(p).map((name) => path.join(p, name));
      } catch {
        return [];
      }
    },
    rglob(p: string): string[] {
      return _rglob(p).slice().sort();
    },
    stat_size(p: string): number | null {
      return _safeStatSize(p);
    },
  };
}
