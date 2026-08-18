"""InkEngine 墨引擎内核（engine-core）。

通用 agent 执行机制内核：替代 langchain/langgraph 依赖，提供原生执行
语义（图执行/checkpoint 版本链/事件流/interrupt 挂起/补丁链/上下文调配/
评审收敛/审批卡），机制层语义中立——领域语义由外挂领域包承载
（novel_harness 为随引擎发布的领域包，其它领域可另行声明）。
零业务依赖、零反向依赖。
"""
