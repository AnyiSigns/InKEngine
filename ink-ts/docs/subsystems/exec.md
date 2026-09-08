# exec 层（docs/subsystems/exec.md）

**层权威**：改 exec/ 先读本文件 + `exec/CONFIG.md`（信封行帧协议——对端唯一
契约）。exec 不参与 TypeScript 单语言重建（Rust 原生层），机制语义/端口词表
见 engine.md 与 `engine/src/kernel` 词表。

## 定位

`exec/` = **Rust 原生执行后端**：exec_envelope 的物理实现 + 内嵌推理/文档解析/
内置 MCP。Engine 机制层零自持 IO：真正跑 OS 命令 / 本地嵌入推理 / 文档解析 /
内置 MCP server 的子进程二进制都在此层，作为 plugins/endpoints 声明的端点
被执行信封拉起。

## 目录语义

```
exec/
├─ CONFIG.md        # 信封行帧协议（对端唯一契约；本层一切对码以它为准）
└─ crates/          # 子进程二进制：
    ├─ os/          #   OS 执行器（exec）
    ├─ doc/         #   文档解析（doc_parse 依赖的原生件）
    ├─ dialog/      #   系统目录/文件选择（对话框宿主桥）
    ├─ infer/       #   本地嵌入推理
    └─ ink_ts_mcp/  #   内置 MCP server
```

## 与 plugins 声明的对应

原生执行件的二进制名与 env 覆盖键在 plugins 声明（单一事实源），不在 exec 侧
手写：

- `plugins/endpoints/<id>/spec.json` 的 `data.native` = { file: 二进制文件名,
  env: env 单文件覆盖键 }；
- 派生视图 `hosts/lib/src/exec/native.generated.ts`（NATIVE_BINARY_DECLS +
  NativeBinaryKind）由此生成，禁手改（verify:plugin-manifest 逐字比对）；
- `hosts/lib/src/exec/binary.ts` 按声明定位二进制——改端点声明只改 spec +
  重跑生成器，exec 侧只保证交付对应可执行文件；
- 失败语义：消费方各自定（dialog/doc 缺二进制降级 unavailable，mcp 装配
  fail-closed 报缺；不新增装配级全局必装强制）。

## 对端契约纪律

- 与 TS 侧的任何行帧/协议改动，先改 `exec/CONFIG.md` 并同步本文件与
  engine 侧对应端口 seam；对码测试在 engine/exec 信封测试与 e2e 链覆盖。
- Rust 子进程不感知产品/宿主/插件概念，只执行信封；安全边界（沙箱/审批/
  权限档）判定在 engine core，exec 只执行已被放行的信封。
