# storage 端口提供方（kind=ports）

端口实装位：storage_seam。声明真源 = 本目录 `spec.json`（kind=ports、faces.logic
target=host、data.port.implemented=storage_seam）；实现随插件同住于
`faces/logic/`（create_storage 工厂：memory:// / sqlite:///path 路由、SqliteStorage
node:sqlite 驱动、MemoryStorage 内存后端），同住测试 `faces/logic/*.test.ts`
经 `vitest run --root plugins` 执行。

## 数据从哪进 / 能碰什么端口

- 装载：hosts/lib 装配层按 manifest「ports」段动态 import 工厂，产出
  { storage } 注入引擎 seam（与旧 `@ink-ts/engine` 的 create_storage 同一语义 slot）。
- 依赖：storage_seam 端口（引擎唯一端口词表真源 `dock/ports.ts`）。
- 边界：只实现存储后端协议，不改引擎机制语义；postgres 未移植时工厂显式报错，
  不静默回落。
- 失败语义：sqlite 能力探测（node:sqlite 缺失/路径穿越）结构化报错；消费方兜底。

## 与引擎的关系

适配器下沉前 engine/src/adapters/storage（S2 整目录迁出）；引擎公共面停供
create_storage/MemoryStorage/SqliteStorage 等符号，仓储从公共面经
storage_seam 取型（Storage/CheckpointRecord/EngineEvent 等契约）。