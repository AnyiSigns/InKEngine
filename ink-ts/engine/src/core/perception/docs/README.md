# perception/（core/perception — 视觉感知结点）

视觉感知能力的引擎侧形态（纯逻辑 + 结点登记，零 IO、不触碰种子数据）：
感知结点 vision_perceive（截图引用 → 结构化界面描述，安全档 1 屏幕敏感域）、
双通道交叉验证（元素树 + 像素理解，重合度 ≥ 阈值直进、否则复核信号 + 降级）、
截图外发分级（本地多模态直喂；云端默认禁外发，显式授权才放开且仍走审批链）。

## 文件
- `perception.ts` — 常量（VISION_PERCEIVE_TYPE/MODEL_LOCAL/CLOUD/EXPORT_*/
  VALIDATE_*）、`register_perception_nodes`（契约随类型登记，重复登记显式
  拒绝）、`cross_validate_channels`（标签集合重合度，默认阈值 0.5）、
  `classify_vision_export`（fail-closed：未知模型类别一律 deny）。

## 依赖
- 上游：`core/contracts`（NodeContract）、`core/json`（isRecord）、
  `core/registry`（NodeTypeRegistry）、`core/schema`（SchemaSpec/Field）。
- 下游：`kernel/runtime/_runtime_assemble`（装配处登记）；公共面零导出；
  `test/core/perception/perception.test.ts`。

## 备注
- 结点执行体当前为占位实现（取截图引用产出固定形态描述：元素清单
  'window,button,text,input' + 置信度 0.9），真实多模态理解属宿主注入面——
  头注自述「真实形态下经本地多模态模型理解截图」。
- 视觉任务成败由执行器经通用边证据机制留痕（不维护专用记录函数）。
