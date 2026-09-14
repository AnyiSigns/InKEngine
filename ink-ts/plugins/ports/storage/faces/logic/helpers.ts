/**
 * sqlite 适配器测试公共设施：临时目录管理（真实文件 IO 用 temp 文件，
 * 每测试用后清理）。Python 侧 tmp_path fixture 的 TS 对应。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** 本套件创建的临时目录（afterEach 统一清理）。 */
const created: string[] = [];

/** 创建唯一临时目录（镜像 pytest tmp_path）。 */
export function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inktsql-'));
  created.push(dir);
  return dir;
}

/** 递归删除本套件全部临时目录（防残留；目录被占用时忽略）。 */
export function cleanupTempDirs(): void {
  for (const dir of created.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 文件锁占用等清理失败可忽略 */
    }
  }
}
