# InkEngine 安全模型

引擎的安全设计原则：**默认拒绝（fail-closed）、纵深防御、机制与策略
分离**。本文档汇总全部安全环节与判定矩阵；机制在 core，策略（白名单/
直过名单/门控分级）由宿主配置注入。

## 威胁模型

| 威胁 | 防线 |
|---|---|
| 凭据泄漏（API key/token/secret） | 敏感键剥离（三出口统一）+ repr 遮蔽 |
| 指令注入污染知识集/检索结果 | L1 注入扫描 + 检索剔除 + 来源可信度分级 |
| 越权工具调用 | 权限门禁（默认拒绝）+ 门控分级 |
| 路径逃逸/符号链接逃逸 | FileSandbox resolve 校验 + symlink 检测 |
| 恶意/失控进程 | ProcessSandbox 白名单 + 超时 kill + 输出截断 + 禁 shell |
| 不可信工具代码 | vetting 闸门（清单/静态钩子/影子运行） |
| 旁路写穿演化资产 | GuardedStorage 拦截 + 补丁链 append-only |
| 审批绕过（超时后补批） | 权威时钟校验 + 过期 reject + 非法注入 reject |
| 外部生态渗透 | MCP 权限粒度 `mcp:call:<server_id>` + vetting 仅放行 verified |

## 敏感键剥离

`core/security.py`：

- `SENSITIVE_KEYS` 精确集合 ∪ 后缀启发式（`_key/_token/_secret/_password`
  等）判定敏感键；
- `strip_sensitive` 递归剥离：dict 键置空（保留键结构）、list/tuple
  逐项、PatchChain 对 base 与每条补丁 value 同样剥离；copy-on-write
  零拷贝纯函数；
- **三出口同规格**：落库（storage 序列化）、出网（快照/事件负载）、
  日志（`logging.redact` 正则遮蔽凭据形态）；LLM 配置（`api_key`）与
  MCP 会话（`headers/env`）repr=False，不出现在 repr/日志中。

## 权限门禁（PermissionGate）

权限声明语法 `domain:action:pattern`（`core/permissions.py`）：

| domain | action | pattern 示例 |
|---|---|---|
| filesystem | read/write/delete | `/book/**`（含 `..` 段的路径一律拒绝） |
| process | exec | `git\|python`（fnmatch） |
| network | connect | `*.example.com`（主域与任意子域） |

判定三路：

- **allow**：权限命中且无 review_tier；
- **review**：权限命中但门控分级要求审批（委托 `approve_before_execute`
  挂卡，门禁自身不挂起）；
- **deny**：未命中/未声明权限（`default_policy=DENY`，可放宽为
  review/allow——放宽是显式声明，不是默认）。

`NetworkPolicy` 默认禁网，白名单域名后缀匹配。白名单外域名的处置由
`NetworkPolicySandbox.unlisted_policy` 决定：**deny**（默认）= 硬拒
（fail-closed，审批也不放行）；**review** = 白名单外域名强制转审批
（`_NetworkReviewGate`），审批 accept 后放行——**审批即网关**，白名单
降级为免审批快速路径。`build_declarative_pipeline` / `harness.build_pipeline`
默认 review（`network_unlisted_policy="review"`）。判定仅信任**定义声明的
权限**（`_DefinitionGate`，调用方 spec 不参与），封「伪造宽松权限」窗口。

## 沙箱守卫

- **FileSandbox**（`core/sandbox.py`）：根目录前缀 + `Path.resolve`
  （跟随 symlink）后 `relative_to(root)` 校验——symlink 逃逸检测；
  解析结果回写执行参数（执行对象 = 校验对象，防二次拼接逃逸）；
  写前快照 `snapshot_before` + `restore()`（事务性文件写入底座，幂等）；
- **ProcessSandbox**：白名单命令（空 = 全拒）+ 超时 kill（标
  `timed_out`）+ 输出截断（`max_output` 默认 100k，溢出标记）+
  工作目录限定 + 环境变量清理（默认干净环境）+ 默认禁 `shell=True`
  （`create_subprocess_exec` 不经 shell 解释）；
- 沙箱是**机制、非安全边界承诺**：默认拒绝兜底 + 纵深防御，宿主按
  声明权限与参数语义接入。

## 工具执行流水线（fail-closed 矩阵）

`ToolPipeline.execute`（`core/tool_pipeline.py`）：

| 环节 | 失败行为 |
|---|---|
| 提取器缺失/返回 None | deny（除非显式 `allow_unchecked`） |
| 门禁判定 | deny/review（review 挂卡，reject/terminate 决议 → deny） |
| 沙箱校验违规 | deny（`SandboxViolation`） |
| 单调守卫异常 | deny |
| 执行体缺失 | deny |
| 结果超长 | 截断 + `overflow=True` 标记（不失败） |
| 审计/观察失败 | 不阻断（降频记录；trace_sink 失败容错） |

未知 decision 一律拒绝；目标无法判定（`endpoint_operation` 返回 None）
拒绝。

## 端点类型注册（信任模型边界）

端点类型集合不封闭（`EndpointTypeRegistry`，内置 7 种 + 宿主扩展位），
但扩展不改变信任模型：

- **注册 = 装配期代码动作**，与谓词注册同等级——不是 agent 可写数据；
  agent 只能引用已注册端点创建工具（`PatchKind` 不新增端点注册类型），
  未注册端点 = 工具定义期拒绝 + 分发处 fail-closed；
- **无「跳过流水线环节」开关**：自定义端点与内置端点同等走
  门禁 → 沙箱 → 守卫 → 审批 → 审计，全环节不可旁路；
- **守卫接线随注册声明**：声明 `sandbox_ops` 必须同时提供
  `sandbox_builder`（否则注册即拒绝），守卫构造失败/未注册端点 =
  定义期或分发处拒绝；不声明本地沙箱的端点（mcp/web_search 同语义）
  以「权限门禁 + 审批卡 + 执行体宿主注入」为边界；
- 壳侧 Rust 对自定义端点宽容载入（`Endpoint::Unknown` 透传不接线守卫）
  ——守卫语义由引擎侧注册表条目承担，不存在「壳侧绕行」通道。

## 挂卡审批

- 决议集：accept / edit / reject / terminate / auto；
- `InterruptPolicy.should_approve`（False = 直过 auto）/ `timeout_for`
  （None = 不限时）；默认 `DefaultInterruptPolicy` 全挂起 + 不限时
  （最保守）；
- 挂卡写 `expires_at`，重入读回**权威时钟**校验——超时后补批一律
  reject（`source=expired`）；非法注入回落 reject（`source=invalid`）；
- edit 决议须提供 edited_content 且重新过校验才落链；
- 挂起卡随 interrupt checkpoint 持久化，与执行中 cancel 语义互不干扰；
- 补丁应用分级：L0 策略直过 / L1 弹卡 / L2 沙箱验证（无 vetting 钩子
  fail-closed，7 天超时过期回滚）。

## 注入防线与可信度

- **指令注入扫描**（`knowledge_gate.scan_text_injection`）：中英文句式
  （"忽略上文"/"ignore all previous instructions"/jailbreak 等），
  归一化匹配（全角转半角 + 去空白 + 小写）；
- 知识条目过 L1 时必须扫描（schema + 注入 + 安全扫描 + 最小功能测试）；
- 检索结果逐条扫描，命中即剔除；
- **来源可信度分级**：web=0.3 < dialog=0.6 < model=0.7 < user=0.9——
  防 web 注入污染知识集；来源留痕随条目落库。

## 外部工具 vetting（ToolVetting）

`core/tool_vetting.py`：

1. **清单校验**：来源未知且无签名拒绝；权限逐项 parse；哈希 64 字符；
   未声明权限拒绝（fail-closed）；
2. **静态钩子**：命中 → strict 拒 / 非 strict 降级 REVIEW（需人工，
   不自动放行）；钩子异常即违规；
3. **影子运行**：观察模式——临时目录副本（符号链接按链接复制防逃逸）、
   执行、前后快照 diff 得写操作清单、副本销毁；结果**恒 untrusted**
   （只作行为证据，不作信任依据）。

## 补丁应用安全（Self-application）

- **GuardedStorage**：演化资产集合（ui/theme/tool_defs/event_types/
  environments/artifacts/harness/entities/set_patch_chain/set_audit +
  `knowledge:`/`harness:`/`event_types:`/`entities:` 前缀）直写拒绝；
  放行 = 守卫令牌或机制上下文（旁路写 fail-closed）；
- 补丁链 append-only + 并发 base 校验（冲突拒绝重提）+ 回退仅链尾
  单步（存储层强制）；
- 审计 append-only（`set_audit` 集合，状态 pending/applied/rejected/
  conflict/invalid/reverted）；
- 活跃态应用异常只告警（重启装配恢复），不破坏链路完整性。

## MCP 安全

- 权限粒度 `mcp:call:<server_id>`（按 server 管控，约定优于配置）；
- vetting 仅放行 VERIFIED，REVIEW/REJECTED 同样不导入工具表；
- headers/env repr 遮蔽；call_tool 超时/远端 isError 结构化失败；
- 未连接/缺 server_id 分发 fail-closed；跨 server 名称冲突防静默改路由；
- SDK 惰性导入（缺 mcp 包时提示安装，不静默降级）。

## 机制层纪律（架构门禁）

`tests/test_architecture_gate.py`（随 pytest 执行）：

1. core/ 零领域词（13 词，大小写敏感，含注释与字符串）——机制层不
   认识领域；
2. core/ 零宿主框架字样（6 词，大小写不敏感）——机制层不认识宿主；
3. AssemblyRecipe 注解类型 ∈ 29 项白名单（文本级检查）——宿主类型
   不得进入装配数据；
4. 装配字段清单与 runtime.py 声明逐一对应——防「文档-源码漂移」。

门禁为本地命令（仓库未接入 CI 编排），是安全基线的自动防线。

## 边界声明

- 沙箱/门禁是机制原语，**非安全边界承诺**——默认拒绝兜底 + 纵深防御，
  白名单/策略配置属宿主业务层；
- 引擎不承诺多进程/多用户隔离（单进程 asyncio）；部署层负责进程与
  账户级隔离；
- 影子运行/静态钩子只能提高攻击成本，不能替代人工审批（REVIEW 兜底）。
