# builder/（kernel/builder — 本机构建管线）

白名单沙箱命令构建 + 产物内容寻址哈希 + 冒烟门禁：AI 生成/挂载的代码
（前端 bundle/任意语言工具/服务）经沙箱构建，产物按内容哈希落盘、可回退
可审计，`build_and_verify` 把冒烟变成不可跳过的上线门禁。

## 文件
- `builder.ts` — `Builder`（build/smoke/build_and_verify/verify_hash/
  artifact_dir）+ `BuildError`；命令白名单 fail-closed、产物路径越界防护
  （拒绝绝对路径与 `..`）、sha256 内容寻址（artifact_id = 类别 + 哈希前 16 字符）。
- `_types.ts` — 数据面：`BuildKind`（js_bundle/python_package/service）、
  `BuildSpec`（构造校验 + to_dict/from_dict 往返）、`BuildArtifact`、
  `SmokeProbe`/`SmokeResult`、`BuildFs` 文件执行体 seam、`pyRepr`。
- `_sha256.ts` — 纯 TS SHA-256（FIPS 180-4；core 禁 node:crypto 的选型）；
  文件头标注「跨域契约模块」（kernel/llm/cache.ts 与
  kernel/entity_evolution/_util.ts 跨目录复用 `sha256_hex`）。
- `contract.ts` — 机制契约 `builder_contract`（effects=[exec_envelope]、
  depends=[sandbox]），入 `ALL_MECHANISM_CONTRACTS`。
- `index.ts` — 导出面（镜像 Python `__all__`）。

## 依赖
- 上游（实际 import）：`core/errors`、`kernel/sandbox`（ProcessSandbox +
  _path.is_absolute）、`kernel/registry`（contract_types/ports）。
- 下游（实际 import 本目录）：`kernel/llm/cache.ts`、
  `kernel/entity_evolution/_util.ts`（仅 `_sha256.js` 跨域共享）；
  `test/kernel/builder/`（4 文件）。src/hosts 内无其他消费方——机制自述
  「宿主接线点待定，配方开关默认关」。
