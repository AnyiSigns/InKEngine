# engine/src

L3 引擎纯函数库源码。`core/` 为零框架、零 IO 的机制解释器区（架构门禁扫描），
JSON 进 JSON 出。过程决策语义（spawn spec 校验/超时/重试/预算/结果归约）为
纯函数；真实 IO 由宿主（host/cli）经 seam 注入。
