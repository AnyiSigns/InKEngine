# GraphLab — 乱图 → 可用图：训练/微调/伪思考实验

独立实验，纯标准库，零依赖本仓库代码。验证一个命题：

> 组装图的随机性可以被"训练掉"：一张随机混乱的图（随机边 + 噪声/伪节点
> 算子），每次任务 = 一次 forward（思考）+ 一轮在线训练（微调），图本体从不重建，
> 收敛为确定、最优路径可用的图。

背景：旧"组装"图能跑，但只是 N 个 LLM 节点链式串联——每次问同一条随机
路由，组装等于随机，故被弃用。本实验验证随机如何被训练掉，验证图可进化逼近"AGI"。

（本目录 = `experiment/graph_lab/` 的**分层重组副本**：函数逐行搬家、行为与原树
bit 级一致；下述全部结论继承自原实验。）

## LLM ↔ 图 概念映射

| LLM | 图（本实验） |
|---|---|
| 注意力（动态边，上下文相关） | `policy/router.py` 条件路由：边权重按输入特征分裂 `e.cond[feat]` |
| 前向传播（推理） | `GraphEngine.forward`：entry 起步、状态逐节点变换、exit 验收门弹回（多层迭代协调） |
| 反向传播（梯度） | `learning/credit.py`：REINFORCE + 对比学习 + 成功回放（离散 credit assignment） |
| 微调 / 在线学习 | 每次任务后 `CREDIT.train` 更新权重（图本体不变） |
| thinking / test-time compute | `demos/think_demo.py`：图内 rollout 模拟多条路径，选最优、执行 |
| 权重剪枝 / 结构稀疏 | `Evolution.evolve`：剪冗余/有害边、废弃噪声节点、随机加新边（低频） |
| 模型 checkpoint / 版本 | `checkpoint_best.json` 最优快照 + `evolution_log.jsonl` 审计 |

## 实验环境

- 17 节点：entry、exit（验收门）、6 个有用算子（add/mul/double/upper/reverse/
  concat：类型硬门控，不接受返回 None 走死路）、2 个伪装节点（fake_add/fake_upper）、
  3 个噪声节点、4 个中性节点（pass：原样通过）、可选 LLM 节点
- 初始图：99 条随机边、路由熵 1.367、训练前 greedy 成功率 0.00
- 6 类任务：add / add_double / double_direct / upper / upper_reverse / concat；
  输入特征决定入口分流、复合任务靠 exit 验收门弹回
- 训练：REINFORCE（非对称：正负信号，负信号降速 4 倍）+ 同源边对比学习 +
  成功路径回放（按 batch 内归一 delta 缩放，最短路径拿满回放）+ epsilon
  退火（0.7 → 0.05，beam=12）+ 每 500 任务一次结构进化

## 关键机制

1. **条件路由（注意力等价物）**：路由观察输入特征（int_pair / int / str_pair /
   upper_str / lower_str），权重按特征分裂。特征粒度 = 路由能力上限；str 分裂为
   大小写形态，否则 upper_reverse 弹回时会选错边（次优吸引子）。
2. **exit 验收门（多层迭代协调）**：验收不通过则不终止、弹回图继续变换直至
   expected 满足或超步数。add_double 学出 entry→add→exit(不匹配)→double→exit；
   图训练后还会自发发现更短的直接串联 entry→add→double→exit。
3. **成功回放**：稀疏成功信号会被 5 倍多的负信号淹没（负信号把正确边 logit 压到
   下限导致不收敛）；成功路径回放直接强化解决之；按 delta 归一化缩放让最短路径
   赢得竞争。
4. **结构进化（带审计）**：剪冗余边（窗口内未被走过）、剪有害边（走过但从未
   成功且权重极负）、废弃零成功贡献的干扰节点、随机补新边。所有事件写入
   `evolution_log.jsonl`（审计）、最优快照写入 `checkpoint_best.json`（回滚）。
5. **分层存储**：权重快照仅在刷新历史最优时保存（轻量）；结构变化逐条审计落盘；
   训练中可随时 resume / 回滚到历史最优（`load_checkpoint` 已验证）。

## 结果

- 玩具域（main.py，3 个随机种子）：greedy 成功率 0.00 → 1.00（最优 checkpoint
  在 200-600 任务内达成）；噪声/伪装节点被废弃、干扰算子被剪枝；路由熵
  1.367 → ~0.5。奖励塑造（每步 -1.0、噪声/伪装 -3、中性 -2）与探索率退火
  "收敛"的一部分——判别力预先打包在特征与奖励里，勿高估为涌现。
- 拟思考（think_demo，2026-09-12 版）：两图各 beam=48 采样，
  唯一差异为选优训练 vs 选随机路径训练——思考组收敛快一个量级；对照干净后
  结论指向"选优使思考的算力质量化"。
- 真实 LLM 域（agent_demo，qwen/kimi 真实 API）：fallback 链错误率约 3%
  （60 调用 58 成功）；图结构真实进化（17→25 节点、工具自生长、角色克隆、
  提示词变异、bias 移动），但 6 轮任务成功率 6/0——真实 API 抖动 × beam 2
  的探索噪声远大于玩具域，训练信号不足（玩具域收敛需 3000 轮×beam12）。
  **真实域"训练有效"尚未证实**；本实验最有价值的产出是失败证据：状态 JSON 包裹污染、
  节点复用同类任务不通用、路由学到"模型愿意走"而非"任务需要的"路。

## 下一版（agent_demo2.py）：契约门控 + 基线三臂 + 技能宏

v1 失败证据 → 按新三机制重做（见 A/B/C）。当前进展：

- **契约门控 A**（已实现）：每个角色 LLM 节点声明 `Contract`
  （requires/provides，typed-state），引擎 `engine/graph_engine.py` forward 执行前查闸——不满足 =
  零代价死路（不执行函数、不调 LLM）；契约查闸逻辑在 `policy/contract_gate.py`：
  `{"task": ("code",)}` 这种值约束使 translate 任务上错配节点被路由前置过滤；
  验收通道收口（`exit_gate=accept_channel`）：只读本族 provides 字段，错误生产者喂不饱；
  prompt 输入契约化（`LLMAdapter.input_fields`），杜绝整包 state dump 进 prompt。
- **基线三臂 B**（已实现）：同一数据集、同一批 LLM 实例、同一验收下三臂对照：
  10 行硬编码启发式路由 / **契约导向确定性路由**（`contract_route`）/
  不训练随机图 / 训练图 / （`--skills`）训练图+技能宏。协议修正：held-out 全部钉死
  greedy pass@1（此前图臂 beam=4 多次重试 vs 启发式 1 次，不公平）。
- **契约臂**（审查 #3.7 补的关键对照臂）：`demos/agent_demo2.py` 声明即调度——
  全图存活+契约合法候选集内做 provides 满足度贪心，缺边当场补边（需求驱动生长、审计）；
  零学习零随机。结论方向同原实验、但验证命题从"训练有效"改为"仅凭声明能否复现启发式"。
- **族推断防泄漏**（审查 #3.1）：`family_of(task)` 走 `detect_task(desc)`，不再吃数据集 gold label。
- **验收强化**（审查 #2.9）：math 题数值代入验证（解一元一次方程再回代），
  translate 回译（TODO），修复"复述原题即可过"。
- **技能宏 B1**（`--skills`，已实现）：teacher heuristic → 带 typed 前置条件+
  检索锚点的宏（`SkillMacro`）→ top-1 执行 → 验收通过才计数；连续 2 次失败即
  删除（漂移护栏）；成功结晶回宏库（O(1) 学习）。
- 基线价值实证（18 轮中途数据）：启发式 13/18 vs 不训练 11/72 vs 训练图
  0/15——训练图几乎采不到成功轨迹，瓶颈在 exploration 而非表示。novel 失败
  定位为 timeout confound，非路由问题。
- B2（规划层模拟）与 C（进化回归门）未做。

## v3 难域重构（hard_demo.py，2026-09-12）：廉价机制完胜策略梯度（定稿）

针对 v2「域名太浅」审查重构（`demos/hard_demo.py`）：验收 = 内容通道 +
确定性检查器 verdict + 落盘产物（code=真实跑规格测试、translate=回译 CJK
重合率、math=数值代入）；**族由系统自产**（entry→classify LLM 节点输出族，
classify 前所有角色节点零代价死路）；契约升级为 requires（存在性）+ when
（值域）分离。六臂对照（同数据集同验收）：heuristic_naive / heuristic_full /
contract_only（声明反向链，零学习）/ untrained / trained（REINFORCE）/
trained_skills（teacher 宏）。

结果（20260912_095555，rounds=12 beam=2，gateway stepfun 钉模型）：

| 臂 | 训练 12 轮 | held-out 3 任务 |
|---|---|---|
| heuristic_naive（单角色+save） | 0/12 (0%) | 0/3 |
| heuristic_full（人工链） | 11/12 (92%) | 3/3 |
| contract_only（声明反向链） | 10/12 (83%) | 3/3 |
| untrained（随机图） | 0/12 (0%) | 0/3 |
| trained（REINFORCE） | 0-8%（三次 0/0/3 随机内） | 0/3 |
| trained_skills（宏） | 10/12 (83%) | 宏 3/3（独立跑 103733 为 3/3） |

结论：**契约先行 + 技能宏以零/廉价学习追平甚至超过人工链（held-out 100%），
REINFORCE 训练图三连证伪（0-25% 噪声级，探索瓶颈而非表示）**。

**translate 全灭根因（观测日志实锤）**：`llm_adapter.ROLE_PROMPTS` 缺
classify/backtranslate 角色 → 落 generic「直接回答任务」→ classify 把翻译任务
直接译成英文（无族 token，family=None，所有臂选链前死路，全实验 backtranslate
调用数 = 0）；即使修好族，backtranslate 也会英文回英文（CJK 重合率恒 0）。
修复 = 补两个角色提示词（裸输出类别词 / 只出中文译文），探针
（translate_probe.py）验证：修复后 overlap 1.0/1.0/0.875 全过，对照旧提示词
0.0/0.0/0.875。

**锚点对照（macro_probe.py，A）**：hash 16 维字符直方图 3/3 命中 held-out
（sim 0.91/0.83/0.96），embed 1024 维语义向量判别过强（sim 0.53/0.50/0.68
< 阈值 0.6，只中 1/3）——**锚点无需语义化，hash 够用**；宏 held-out 2/3→3/3
的波动实为 is_prime 单次代码生成质量抖动（fix 重试机制覆盖，contract 臂恒 3/3）。

**演化回归闸门（B，--gated）**：结构演化前在门集（每族 1 个训练任务）上
greedy pass@1 评分，成功非降才提交，否则回滚快照并写审计事件
（`evolve_commit`/`evolve_rollback`）。本轮 4 次闸门全部 before=after=0 →
commit（训练臂门分恒 0，回滚路径未触发——机制可用，防护价值需在训练臂有正分
的域才显现）。带闸门臂 held-out 图 0/3（同无闸门），宏 held-out 3/3。

## 自测

```
python experiment/GraphLab/demos/selftest.py   # 57 项核心冒烟（零网络零 LLM）
```

## 局限（实验中学到的教训，反推引擎设计启示）

1. **次优吸引子**：无害冗余节点（pass/fake 伪装）会寄生在成功路径上；进化随机
   补边也可能创造"绕路成功"。步数惩罚 + 归一化回放压制了大部分，但个别
   种子仍残留（成功但非最短）。真实引擎需要"路径代价"意识与探索最短优先。
2. **探索-利用权衡**：稀疏成功 + 高方差采样会导致某 seed 收敛慢；beam 越大、
   epsilon 退火越慢、成功回放越强，收敛越快但也越贵。
3. **特征粒度即能力**：路由观察（特征/embedding/LLM 语义判断）决定分流上限；
   类型级特征不能区分 add 与 mul（输入形态相同）——真实系统中这类区分要靠
   节点入口 LLM 语义理解，或让路由放弃贪心，接受多路并行 + 验收门。
4. **单样本微调**：REINFORCE 的 batch baseline 在单样本时退化（自归零，无学习）；
   `learning/credit.py` 已改为单样本固定基线 0（成功正强化/失败负强化）。
5. **真实 LLM 域"训练有效"未证实**：免费模型质量波动（fallback 链每次可能换
   模型 = 转移函数漂移，REINFORCE 平稳性假设不成立）、验收脆弱（"def " in 代码
   即过？）、训练量差 2-3 个数量级（玩具域 3000 轮 × 真实域 18 轮）——失败恰是本
   实验最有价值的产出（已据此在 agent_demo2 加契约/去泄漏/强验收）。
6. **验收/奖励不能与路由同源**：训练的是编排策略（连接组），不是内容质量；
   验收必须用独立且不可被策略污染的信号（可执行检查/确定性检查），LLM 自评只能
   当辅助投票。

## 文件

```
GraphLab/                        # graph_lab 的分层重组副本（非包：_paths.setup() 注入 sys.path）
├── topology/store.py      拓扑层：Node/Edge/Path/Contract + GraphStore：权重存储与构造、随机化、使用计数、序列化
├── policy/router.py       策略层：条件路由 logits/选边（greedy/eps/softmax）/余弦/熵
│   contract_gate.py       契约查闸：ok / statically_dead（独立于路由）
│   exit_gate.py           验收弹回判定（GraphEngine.forward 消费）
├── engine/graph_engine.py 执行层：组合 Store+Router+Gates，GraphEngine.forward 纯函数式 beam rollout
├── learning/credit.py     学习层：REINFORCE + 对比学习（train_step → CREDIT.train），LR/NEG_LR 等超参
│   replay.py              成功回放 + batch 归一化 + _move_proto（proto 学习）
│   evolution.py           结构进化（剪边/废弃/生长/变异）+ reset_usage（保守/非保守）
├── adapters/llm_adapter.py   LLMAdapter（原 LLMNode）+ 多提供商回退链 + 角色提示词
│   embedding.py           qwen embedding 语义路由特征（网络 I/O，hash 回退）
│   tool_adapter.py        文件系统工具节点（append/list/read）
│   serialization.py       jsonl 审计落账（log_jsonl）
├── domain/nodes.py        玩具算子库：算子/伪装/噪声/中性、feature 提取、build_node_pool、OPTIMAL
│   env.py                 TaskSpace、initial_state、reward
│   dataset.py             图训练集（code/novel/article/translate/math）
├── demos/main.py          玩具域训练实验（--episodes --seed --llm）
│   think_demo.py          拟思考公平对照（同 beam，只差选优训练）
│   agent_demo.py          真实 LLM 域 v1（已失败；保留证据，交互/预训练两阶段）
│   agent_demo2.py         真实 LLM 域 v2：契约门控 + 三臂基线 + 技能宏（--compare / --smoke / --skills）
│   hard_demo.py           v3 难域六臂对照（--compare / --gated / --smoke / --anchor）
│   translate_probe.py     translate 族根因探针（classify/backtranslate 提示词修复前后对照）
│   macro_probe.py         宏检索锚点对照（hash vs embed，held-out 余弦明细）
│   llm_demo.py            DEPRECATED：跨任务干扰对照（scene1/scene2）
│   quick_embed.py         快速冒烟：类型特征 vs embedding 特征（QUICK_EPISODES）
│   selftest.py            核心冒烟自测（57 项，含难域校验）
└── demos/out/             curves.json / checkpoint_best.json / evolution_log.jsonl
                           / final.json / think_curve.json / v2_*.jsonl（时间戳归档）
```

## 运行

```
python experiment/GraphLab/demos/main.py --episodes 3000 --seed 0
python experiment/GraphLab/demos/think_demo.py --tasks 1200 --sims 48 --seed 0
python experiment/GraphLab/demos/agent_demo2.py --compare --train_rounds 15 --beam 2 --seed 0
python experiment/GraphLab/demos/agent_demo2.py --compare --skills --train_rounds 15 --beam 2 --seed 0
python experiment/GraphLab/demos/agent_demo2.py --smoke   # 离线管线冒烟
python experiment/GraphLab/demos/hard_demo.py --compare --rounds 12 --beam 2   # v3 六臂
python experiment/GraphLab/demos/hard_demo.py --gated --rounds 12 --beam 2     # 回归闸门臂
python experiment/GraphLab/demos/hard_demo.py --anchor embed ...                # 宏锚点换语义向量
python experiment/GraphLab/demos/translate_probe.py                             # translate 修复验证
python experiment/GraphLab/demos/macro_probe.py                                 # 锚点对照探针
```

已知无害噪声：`repair_after_failure` 用 `set(failed_tasks)` 迭代，多任务窗口下
事件打印顺序随 PYTHONHASHSEED 波动——原树同样如此，两树各自多次运行亦复现。
