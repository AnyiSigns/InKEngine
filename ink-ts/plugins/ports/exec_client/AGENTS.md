# exec_client 端口提供方（kind=ports）

端口实装位：exec_envelope（exec 原生机制件 client：二进制定位 + 信封裁决面门
+ 受监督 stdio 会话，评审 2026-09-14 裁决）。声明真源 = 本目录 `spec.json`
（kind=ports、faces.logic target=host、data.port.implemented=exec_envelope、
contract.effects=["exec_envelope"]）；实现随插件同住于 `faces/logic/`
（binary 二进制定位、envelope 信封签名/裁决面门、client 受监督 client、
session/transport 受监督 stdio 会话与看护重启、_types 共享数据形态），同住
测试 `faces/logic/*.test.ts` 经 `vitest run --root plugins` 执行。

## 数据从哪进 / 能碰什么端口

- 装载：hosts/lib 装配层按 manifest「ports」段动态 import 默认导出工厂，
  产出 { ExecClient, locateNativeBinary, hostAllowed, SupervisedNativeSession, ... }
  注入端口 seam（loadPortsSeam.execClient）与域/命令插件跨树取用。
- 依赖：exec_envelope 端口（子进程/沙箱执行机制位）；`node:child_process`/
  `node:fs`/`node:path`/`node:crypto` 实现（S0 §2.2 端口实装位豁免子句）；
  二进制定位声明真源 = plugins/endpoints/<id>/spec.json data.native → 派生
  hosts/lib/src/exec/native.generated.ts（禁手改，NATIVE_BINARY_DECLS 经
  @ink-ts/host 公共面取型）。
- 边界：只做 exec/infer/mcp 原生二进制 client（spawn/看护/信封调用），不做
  OS 工具裁决（host 面门在 hosts/lib 与 os 域插件）、不做 MCP 客户端（那是
  plugins/ports/mcp_client）、不做市场治理（plugins/mcp/*）；出网 http op 已
  从 exec 移除，网络走引擎声明式端点。
- 失败语义：RpcError/ExecRefusedError/SessionLostError 结构化错误族，越权/
  越根/未批准 = host 拒绝（进程不触达），崩溃看护重启 + 熔断 fail-closed。

## 与引擎的关系

引擎 dock/ports/exec.ts 声明 exec seam；沙箱判定实现在 engine gate/sandbox；
OS 执行真身是 Rust 原生机制件子进程（exec/infer/ink_ts_mcp）。S4 域组3 自
hosts/lib/src/exec/ 迁入，@ink-ts/host 停供 exec 值，域/命令插件改 import
本插件包（os/retrieval/search/doc_parse/dialog.open_directory 等）。
