/**
 * 硬编码色值门禁（grep 断言）：src 下组件/渲染器代码零硬编码颜色。
 *
 * 例外（设计 token 定义文件，色值只允许出现在这些文件）：
 * - renderer/themeTokens.ts：白名单 token 出厂默认值；
 * - index.css：主题 token 基底/派生定义块 + 黑阴影（色深依赖颜色值）。
 * 其余 .ts/.tsx 出现 hex/rgb/hsl 直书 = 断言失败（防止组件偷写色值）。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC_DIR = join(__dirname, '..', '..', '..', 'src');

const COLOR_PATTERN = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/;

/** 允许持有色值的文件（白名单 = 设计 token 文件 + 测试夹具数据） */
const ALLOWED = new Set([
  'renderer/themeTokens.ts',
  'index.css',
]);

function collectFiles(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      // __tests__ 内的色值是测试输入（token 路径断言），豁免
      if (name === '__tests__') continue;
      collectFiles(full, out);
    } else if (/\.(ts|tsx|css)$/.test(name)) {
      out.push(relative(SRC_DIR, full).replace(/\\/g, '/'));
    }
  }
}

describe('硬编码色值门禁（grep=0 语义）', () => {
  it('全部源码文件（除设计 token 文件）无 hex/rgb/hsl 直书', () => {
    const files: string[] = [];
    collectFiles(SRC_DIR, files);
    const violations: Array<{ file: string; line: number; text: string }> = [];
    for (const file of files) {
      if (ALLOWED.has(file)) continue;
      if (file.endsWith('.css')) continue; // 当前仅 index.css（白名单内），未来新 css 文件须显式列出
      const content = readFileSync(join(SRC_DIR, file), 'utf8');
      content.split(/\r?\n/).forEach((line, index) => {
        if (COLOR_PATTERN.test(line)) violations.push({ file, line: index + 1, text: line.trim() });
      });
    }
    expect(violations).toEqual([]);
  });

  it('所有 --ink-* 视觉变量声明收敛于 index.css（不得在组件内注入变量值）', () => {
    const files: string[] = [];
    collectFiles(SRC_DIR, files);
    const offenders: string[] = [];
    for (const file of files) {
      if (file.endsWith('.css')) continue;
      const content = readFileSync(join(SRC_DIR, file), 'utf8');
      if (/--ink-[a-z0-9-]+\s*:\s*[^;]+;/.test(content) && file !== 'renderer/themeTokens.ts') {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
