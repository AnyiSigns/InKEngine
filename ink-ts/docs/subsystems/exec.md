# exec 层（docs/subsystems/exec.md）

**层权威**：改 exec/ 先读本文件 + `exec/CONFIG.md`（信封行帧协议 / 二进制
输出与定位——对端唯一契约）。exec 是 Rust 原生层，不参与 TypeScript 单语言
重建；机制语义/端口词表见 engine.md 与 `engine/src/kernel` 词表。

## 定位

`exec/` = **Rust workspace（原生机制件）**：受控执行信封（exec_envelope）的
物理实现 + 内嵌推理 + 内置 MCP server + 共享行帧底座。engine 机制层零自持
IO：真正跑 OS 命令 / 本地嵌入推理 / 内置 MCP server 的子进程二进制都在此层，
作为 plugins/endpoints 声明的端点被拉起。

## 目录语义（现状物理结构）

```
exec/
├─ CONFIG.md        # 信封行帧协议 / env 与二进制输出约定（对端唯一契约）
├─ Cargo.toml       # workspace 头注（四个 crate 归属；禁旁路添加成员）
└─ crates/
    ├─ exec/        # ink_ts_exec：OS 执行器子进程（输出二进制 exec）
    ├─ infer/       # ink_ts_infer：本地嵌入推理子进程（granite-97m ONNX；输出二进制 infer）
    ├─ mcp-server/  # ink_ts_mcp：内置 MCP server 二进制（stdio 承载；输出 ink_ts_mcp）
    └─ rpc/         # ink_ts_rpc：共享 stdio JSON-RPC 行帧底座（库，不产二进制）
```

二进制输出约定（cargo build → `exec/target/{debug,release}/`）：
`exec(.exe)` / `infer(.exe)` / `ink_ts_mcp(.exe)`。

## 与 plugins 声明的对应

原生执行件的二进制名与 env 覆盖键在 plugins 声明（单一事实源），不在 exec 侧
手写：

- `plugins/endpoints/<id>/spec.json` 的 `data.native` = { file: 二进制文件名,
  env: env 单文件覆盖键 }（现 exec/infer/mcp 三件，binary 名 exec/infer/ink_ts_mcp）；
- 派生视图 `hosts/lib/src/exec/native.generated.ts`（NATIVE_BINARY_DECLS +
  NativeBinaryKind）由此生成，禁手改（verify:plugin-manifest 逐字比对）；
- 定位优先序（TS 侧 `locateNativeBinary`）：单文件显式覆盖 env
  （`INK_EXEC_BINARY`/`INK_INFER_BINARY`/`INK_MCP_BINARY`）→ `INK_NATIVE_DIR`
  目录 → `CARGO_TARGET_DIR/{debug,release}/` → 工作树向上探测
  `ink-ts/exec/target/{debug,release}/`；
- 失败语义：消费方各自定（doc/dialog 等降级 unavailable，mcp 装配 fail-closed
  报缺；不新增装配级全局必装强制）。

## 对端契约纪律

- TS 传输侧对应实现 = `hosts/lib/src/exec/*`、`hosts/lib/src/mcp/*`；任何行帧/
  协议改动先改 `exec/CONFIG.md` 再同步本文件与 engine 侧对应端口 seam。
- Rust 子进程不感知产品/宿主/插件概念，只执行信封；安全边界（沙箱/审批/
  权限档）判定在 engine core，exec 只执行已被放行的信封。
