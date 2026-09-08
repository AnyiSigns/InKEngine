# doc_parse（per-plugin AGENTS）

真面 host logic 工具样板（首个 faces.logic 真面内置，`REAL_FACE_BUILTINS`
白名单唯一项）。声明真源 = 本目录 `spec.json`（kind=tool、capability=host_tool、
faces.logic target=host、depends=['exec']、data.tool 行为行）——本文件只写
意图/边界，不重复 spec 字段。

## 是什么能力

把文档解析成结构化 JSON 的入料环节（PDF/Word/Excel/PPT 识别并抽取）：
「调研文/表格/演示进分析链」的前置。执行体 = `faces/logic/index.ts`（DocService/
DocParser）+ 同目录 `index.test.ts`（node 环境，`vitest run --root plugins`）。

## 数据从哪进 / 能碰什么端口

- 装载：host 装配期 `hosts/lib/src/face/loader.ts` 按 faces.logic 声明动态
  import entry（插件源缺 = docParse 缺省降级、契约不符 = 装配期 fail-closed）。
- 依赖：`exec` 机制端口（原生 doc 端点二进制，plugins/endpoints/doc 声明）。
- 边界：只解析不改写原文件；路径须在授权工作区/附件域内；不支持解压；
  坏文件/截断输入结构化报错不崩溃；产物可继续走研究链（收集→解析→校验→
  评分→蒸馏）。
- 失败语义：消费方各自兜底（docParse 缺省 = rounds/material 仅文件名引用）。
