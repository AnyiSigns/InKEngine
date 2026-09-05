/**
 * @ink-ts/contracts 公共出口（数据面契约唯一真源）。
 *
 * 形态：NodeNext noEmit 工作区形态下以 TS 源码为包导出（package.json
 * "exports" 指向本文件），仓库内 tsx/vitest 直跑。内容 = generated/
 * 全部导出原样透传；generated 文件头「勿手改」注释保留，改动一律经
 * scripts/generate.mjs 重新生成。
 */

export * from './generated/index.js';
