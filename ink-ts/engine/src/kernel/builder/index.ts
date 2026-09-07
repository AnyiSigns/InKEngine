/**
 * 构建管线（builder.py 移植）——白名单命令沙箱构建 + 产物内容寻址 +
 * 冒烟门禁。
 *
 * 导出面镜像 Python __all__：BuildArtifact / BuildError / BuildKind /
 * BuildSpec / Builder / SmokeProbe / SmokeResult / _sha256_file；BuildFs
 * 为宿主注入面（core 零 IO，fs 动作由宿主实现提供）。
 *
 * 状态标注（机制就绪 / 宿主接线点待定）：构建 + 冒烟门禁，由 build 类
 * 补丁/自进化产物路径在配方开关开启时调用（默认开关：关——未启用前机制
 * 可用但不经引擎自动触发）。
 */

export { BuildArtifact, BuildKind, BuildSpec, SmokeProbe, SmokeResult } from './_types.js';
export type { BuildFs, BuildKindValue } from './_types.js';
export { Builder, BuildError, _sha256_file } from './builder.js';
