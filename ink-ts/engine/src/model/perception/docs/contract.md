# core/perception — 视觉感知结点（契约文档）

> 就近导航：本目录 `README.md` · 层权威：`docs/subsystems/engine.md` +
> `engine/AGENTS.md`

## 定位

视觉感知三件套的引擎侧形态：感知结点（可被路径组装器组装进执行路径）、
双通道交叉验证（复核信号 + 降级决策）、截图外发分级（屏幕内容不出网为
默认安全态）。纯逻辑 + 结点登记；不新增事件类型、不改 llm 核心。

## 文件与职责

| 文件 | 职责 |
| ---- | ---- |
| `perception.ts` | 常量 + `_vision_contract`（输入 image_url/image_path 可选、输出 description/elements/confidence；safety_tier=1、version=1）+ `_vision_perceive_node` 执行体 + `register_perception_nodes` + `CrossValidationResult`/`cross_validate_channels`（并集重合度，空对空按一致、单通道缺失按不一致）+ `VisionExportDecision`/`classify_vision_export` |

## 对外契约面

- `register_perception_nodes(registry: NodeTypeRegistry)`：装配处调用
  （kernel/runtime/_runtime_boot 唯一 src 消费点）；登记后类型进结点
  池，路径组装器 contract_pool 可见。
- 纯函数：`cross_validate_channels(element_result, pixel_result, {threshold?})`
  → CrossValidationResult（consistent/recheck_signal/decision/note）、
  `classify_vision_export(model_kind, {authorized})` → allow/deny + reason。
- **公共面零导出**（src/index.ts grep 核对）——引擎内部面。

## 数据形态

- 常量值面：VISION_PERCEIVE_TYPE='vision_perceive'、VISION_CONTRACT_VERSION='1'、
  VISION_CONTEXT_DOMAIN='vision'、MODEL_LOCAL/MODEL_CLOUD、EXPORT_ALLOW/
  EXPORT_DENY、VALIDATE_PROCEED/VALIDATE_RECHECK。
- 元素标签归一：字符串逗号切分 / 数组逐项字符串化，去空白去空项；其余
  形态 = 空集（对齐 Python frozenset 口径）。

## Seam 与 IO 边界

纯函数零 IO（无时间/随机/日志，无需 seam 注入）；截图引用取舍沿用 Python
真值口径（image_url or image_path，全缺 = 空产出）。真实多模态理解不在
引擎内——执行体为占位实现（固定元素清单 + 置信度 0.9）。

## 装配与消费

runtime 装配（图注册表构建后调用 register_perception_nodes）；截图外发
决策「只记录不裁决」（与壳侧同义常量），放开仍走审批链。

## 不变式与门禁

- 云端模型未授权一律 deny（fail-closed 默认禁外发）；未知模型类别 deny。
- 重复登记显式拒绝；契约随类型登记（组装请求按任务审批档映射放行，
  safety_tier 1）。

## 疑点与不一致

1. **执行体占位实现**：`_vision_perceive_node` 产出固定 elements
   （'window,button,text,input'）与 confidence 0.9——头注自述「真实形态下
   经本地多模态模型理解截图」，真实实现不在引擎内也无宿主注入 seam
   （结点执行体为硬编码闭包，非注入面）；占位与真实边界未见显式说明。
2. **VISION_CONTRACT_VERSION='1' 与契约 version: 1 双处声明**：常量
   VISION_CONTRACT_VERSION 定义后未见 _vision_contract 引用（契约构造
   直写 version: 1），常量为孤儿（grep 核验仅定义处）。
3. **VISION_CONTEXT_DOMAIN 未见 src 消费方**（仅定义导出；grep 核验）。

## 测试

`test/core/perception/perception.test.ts`（契约登记/交叉验证两态/外发
分级/占位执行体形态）。
