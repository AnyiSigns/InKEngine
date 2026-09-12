# kernel/builder — 本机构建管线（契约文档）

> 就近导航：本目录 `README.md` · 层权威：`docs/subsystems/engine.md` +
> `engine/AGENTS.md`

## 定位

构建是机制、产物可回退：AI 生成/挂载的代码经白名单沙箱命令构建（超时/
隔离），产物按内容寻址哈希命名落盘（防篡改静默切换），必须过冒烟门禁
（启动/连通/回归）才可 promote；构建失败 = 保留现状 + 留痕。

## 文件与职责

| 文件 | 职责 |
| ---- | ---- |
| `builder.ts` | `Builder` 类：build（白名单校验→沙箱构建→产物哈希→内容寻址落盘）、smoke（探针沙箱执行，退出码/超时判定）、build_and_verify（build+smoke 不可拆分的上线入口）、verify_hash（部署/回退前强制门禁）、artifact_dir；`BuildError`；`_sha256_file` |
| `_types.ts` | `BuildKind` 三类声明式枚举、`BuildSpec`（frozen dataclass 语义：只读 + 构造校验 + 序列化往返，默认超时 120s）、`BuildArtifact`（files: 文件→sha256 映射）、`SmokeProbe`（默认 timeout 30s、expect_exit 0）/`SmokeResult`、`BuildFs` seam、`pyRepr` |
| `_sha256.ts` | 纯 TS SHA-256（`sha256_hex`：Uint8Array → 64 字符小写 hex，FIPS 180-4 编排；头部「跨域契约模块」标注） |
| `contract.ts` | `builder_contract`：effects=[PORT_EXEC_ENVELOPE]、depends=['sandbox'] |
| `index.ts` | 导出面（Builder/BuildError/_sha256_file + 数据面五类 + BuildFs/BuildKindValue 类型） |

## 对外契约面

- `Builder`（构造注入：sandbox + artifact_dir + {fs?, now?}）；`build_and_verify`
  是唯一推荐上线入口（build 与 smoke 分离时宿主漏 smoke 即 promote 的风险
  由该入口封死——冒烟失败抛 BuildError，产物目录保留供排查但不产自称成功
  的记录）。
- `BuildError` 继承 GraphDefinitionError（定义期错误族）。
- **公共面**：`src/index.ts` 无本目录导出（grep 核对零命中）——宿主经
  未来配方开关接线，当前为内部面。
- 机制注册：`builder_contract` 入 `kernel/registry/contracts.ts`
  ALL_MECHANISM_CONTRACTS（34 项之一）。

## 数据形态

- `BuildSpec`：kind/command/args/workdir(默认 '.')/env/timeout(默认 120s)/
  output_paths/meta；构造与 from_dict 双侧校验（command 必填、timeout 正数、
  output_paths 非空相对路径、kind 白名单）。
- `BuildArtifact`：artifact_id = `${kind}-${content_hash.slice(0,16)}`（多
  产物哈希排序拼接后 sha256）；files: 相对路径 → 单文件 sha256 hex；
  built_at 经注入 clock（未注入按 0）。
- `SmokeResult`：ok/output/timed_out/exit_code。

## Seam 与 IO 边界

- `BuildFs` 六原语（resolve/is_dir/is_file/read_bytes/mkdir_parents/
  copy_file）：core 零 IO，真实实现由宿主注入（node:fs 后端）；未注入时
  触碰文件面抛错（fail-closed，`unavailable_fs` 兜底）。
- 命令执行经 `ProcessSandbox`（effects=exec_envelope 端口面）；构建沙箱
  副本限定 cwd=workdir、超时按声明（`derived` 字段复制语义）；smoke 沙箱
  cwd=产物目录（探针可直接引用产物内文件）。
- 时间经注入 clock（确定性，非端口）。

## 装配与消费

自述状态：机制就绪 / 宿主接线点待定——由 build 类补丁/自进化产物路径在
配方开关开启时调用（默认关）。仓库内生产消费方为零（仅 llm/cache 与
entity_evolution 复用 `_sha256.js` 的哈希原语）。

## 不变式与门禁

- 白名单 fail-closed：构建与探针命令不在 allowlist 显式拒绝（smoke 路径
  返回不通过而非抛错——两路径口径不同，见疑点）。
- 产物路径越界防护：绝对路径与 `..` 片段拒绝（声明可来自补丁链/AI 生成）。
- artifact_id 内容寻址：同内容同 id；哈希算法引擎内置（纯 TS sha256），
  不交宿主定制，防跨宿主 artifact id 漂移。
- 机制三键：effects=[exec_envelope] 白名单内；depends=[sandbox] 单向；
  无自持 IO。

## 疑点与不一致

1. **孤儿机制**：src/hosts 内无 Builder 消费方（仅测试 4 文件）；机制已在
   registry 注册并入 DAG，但「宿主接线点待定」处于未接线状态（头注自述，
   文档如实记录，未见接线代码）。
2. **同目录无 impl.ts / 同目录无测试**：实际布局为 builder.ts（单文件即
   实现）+ 测试镜像在 `test/kernel/builder/`，与 engine/AGENTS.md
   「contract.ts + impl.ts + *.test.ts 同目录」口径不符（registry 组代理
   在 kernel/registry 亦发现同类口径落差）。
3. **错误面双口径**：build 命令不在白名单抛 BuildError；smoke 命令不在
   白名单返回 `SmokeResult{ok:false}`——同一 fail-closed 判定两种表达
   （抛错 vs 结果对象），代码未解释差异缘由。
4. **`_sha256_file` 导出面**：`index.ts` 导出 `_sha256_file`（下划线前缀
   私有命名却上导出面，自述「镜像 Python `__all__`」——Python 侧即含
   `_sha256_file`，TS 侧未见收敛为公共名）。
5. **`pyRepr`/`_pyTuple` 双实现**：`_types.ts` 的 `pyRepr` 与
   `contracts.ts`（core/contracts）的 `pyRepr` 语义近似但各自独立实现，
   未互引（同值第二套实现的漂移风险）。
6. **头注「状态标注」字样**：`builder.ts`/`index.ts` 头注含「机制就绪 /
   宿主接线点待定」状态语——属叙述性现状标注，与 CODING §3「注释不写
   计划推进字眼」的边界未见显式说明。

## 测试

`test/kernel/builder/`：builder_specs（BuildSpec/BuildArtifact 序列化往返
与校验）、builder_smoke（冒烟门禁/白名单外）、builder_pipeline（构建管线/
越界防护/内容寻址）、_fixtures（假 BuildFs + 沙箱桩）。
