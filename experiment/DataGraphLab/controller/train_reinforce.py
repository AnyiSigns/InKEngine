# -*- coding: utf-8 -*-
"""REINFORCE 批量策略梯度训练入口（G2.3 对照臂的 Python 侧）。

与 BC 训练器同一分工边界：本进程只做「读 bin → 批量梯度 → 写 weights.json」，不自己
做 rollout（采样与环境交互全在 TS `eval/reinforce.ts`）。数据契约是 `reinforce.bin`
v1（magic `DGLR`，字节布局见 `data/reinforce_bin.ts` 头注）：header 按 ROUTING 序存
22 节点动作特征表，行内是稀疏 obs + 候选全局掩码 + **采样动作本地下标** + 优势 + 奖励。
优势已由 TS 按「滑动窗口 200」baseline 算好，本侧不再估计——白手起家随机初始化
（`--init` 只用于同一次 REINFORCE 训练的续训，绝不从 BC checkpoint 热启）。

超参按 A.2 钉死：`lr=1e-3`、`batch=512`、`beta_ent=0.01`、无 cosine 衰减、无 val 早停、
总预算由 TS 的环境交互步数封顶。梯度数学在 `controller/reinforce_nn.py`（数值梯度自检）。
"""

import argparse
import hashlib
import json
import random
import struct
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import train  # noqa: E402
import reinforce_nn  # noqa: E402
import train_nn  # noqa: E402

MAGIC = b"DGLR"
BIN_VERSION = 1
HEADER = struct.Struct("<4sIIIII")
REINFORCE_LR = 1e-3
REINFORCE_BATCH = 512
BETA_ENT = 0.01


def _read_act_table(raw, off, label, n_act, act_dim):
    """header 动作特征表 → 稠密 nAct×actDim；越界/NaN fail-fast（与 BC 读侧同规）。"""
    if not 1 <= n_act <= 32:
        raise ValueError(f"{label}: header nAct={n_act} 须在 [1, 32]")
    if act_dim != train.EXPECTED_ACT_DIM:
        raise ValueError(f"{label}: header actDim={act_dim} 与 arch 钉死的 {train.EXPECTED_ACT_DIM} 不符")
    table = np.zeros((n_act, act_dim), dtype=np.float64)
    for j in range(n_act):
        (n_idx,) = struct.unpack_from("<I", raw, off)
        off += 4
        idx = np.frombuffer(raw, dtype="<u2", count=n_idx, offset=off)
        off += 2 * n_idx
        val = np.frombuffer(raw, dtype="<f4", count=n_idx, offset=off)
        off += 4 * n_idx
        if n_idx and (idx[0] >= act_dim or np.any(np.diff(idx) <= 0)):
            raise ValueError(f"{label}: 动作表[{j}] 稀疏下标越界或非严格升序")
        if n_idx and not np.isfinite(val).all():
            raise ValueError(f"{label}: 动作表[{j}] 含 NaN/Inf")
        table[j, idx.astype(np.int64)] = val.astype(np.float64)
    return table, off


def load_reinforce_rows(path, label):
    """解析 reinforce.bin v1 → (行列表, header 动作表)；外部字节边界全量 fail-fast。"""
    raw = Path(path).read_bytes()
    if len(raw) < HEADER.size:
        raise ValueError(f"{label}: 文件短于 header")
    magic, version, nrows, obs_dim, act_dim, n_act = HEADER.unpack_from(raw, 0)
    if magic != MAGIC:
        raise ValueError(f"{label}: magic={magic!r} 非 {MAGIC!r}")
    if version != BIN_VERSION:
        raise ValueError(f"{label}: version={version} 与本实现 pin {BIN_VERSION} 不符，请重跑采集")
    if obs_dim != train.EXPECTED_OBS_DIM:
        raise ValueError(f"{label}: header obsDim={obs_dim} 与 arch 钉死的 {train.EXPECTED_OBS_DIM} 不符")
    act_table, off = _read_act_table(raw, HEADER.size, label, n_act, act_dim)
    rows = []
    for i in range(nrows):
        try:
            style, family = raw[off], raw[off + 1]
            off += 2
            (hlen,) = struct.unpack_from("<I", raw, off)
            off += 4
            task_hash = raw[off:off + hlen].decode("utf-8")
            off += hlen
            (step_index,) = struct.unpack_from("<I", raw, off)
            off += 4
            (n_idx,) = struct.unpack_from("<I", raw, off)
            off += 4
            idx = np.frombuffer(raw, dtype="<u2", count=n_idx, offset=off)
            off += 2 * n_idx
            val = np.frombuffer(raw, dtype="<f4", count=n_idx, offset=off)
            off += 4 * n_idx
            (cand_mask,) = struct.unpack_from("<I", raw, off)
            off += 4
            (action_idx,) = struct.unpack_from("<I", raw, off)
            off += 4
            (advantage,) = struct.unpack_from("<f", raw, off)
            off += 4
            (reward,) = struct.unpack_from("<f", raw, off)
            off += 4
        except (IndexError, struct.error, UnicodeDecodeError) as e:
            raise ValueError(f"{label}: 第 {i} 行解析越界/坏数据: {e}") from e
        if cand_mask >> n_act:
            raise ValueError(f"{label}: 第 {i} 行 candMask 越过动作表宽 {n_act}")
        cands = [j for j in range(n_act) if (cand_mask >> j) & 1]
        if not cands:
            raise ValueError(f"{label}: 第 {i} 行候选掩码为空")
        if not 0 <= action_idx < len(cands):
            raise ValueError(f"{label}: 第 {i} 行 actionIdx={action_idx} 不在 [0, {len(cands)})")
        if n_idx and (idx[0] >= train.EXPECTED_OBS_DIM or np.any(np.diff(idx) <= 0)):
            raise ValueError(f"{label}: 第 {i} 行稀疏下标越界或非严格升序")
        if (n_idx and not np.isfinite(val).all()) or not np.isfinite([advantage, reward]).all():
            raise ValueError(f"{label}: 第 {i} 行含 NaN/Inf")
        if style not in (0, 1) or family not in (0, 1, 2, 3):
            raise ValueError(f"{label}: 第 {i} 行 style/family 值域越界")
        rows.append({"idx": idx.astype(np.int64), "val": val.astype(np.float64),
                     "cands": np.array(cands, dtype=np.int64),
                     "action": int(action_idx), "advantage": float(advantage),
                     "reward": float(reward), "task_hash": task_hash})
    if off != len(raw):
        raise ValueError(f"{label}: 行尾多余 {len(raw) - off} 字节")
    if not rows:
        raise ValueError(f"{label}: nrows=0，空数据集上策略梯度无定义")
    return rows, act_table


def _assemble(rows, act_table):
    """行列表 → 稠密批：稀疏 obs 回填；候选取 header 表；pad 位掩码挡住、梯度零贡献。"""
    b_n = len(rows)
    m_max = max(len(r["cands"]) for r in rows)
    o = np.zeros((b_n, train.EXPECTED_OBS_DIM))
    mask = np.zeros((b_n, m_max), dtype=bool)
    a = np.zeros((b_n, m_max, train.EXPECTED_ACT_DIM))
    act = np.zeros(b_n, dtype=np.int64)
    adv = np.zeros(b_n)
    for b, r in enumerate(rows):
        o[b, r["idx"]] = r["val"]
        m = len(r["cands"])
        mask[b, :m] = True
        a[b, :m] = act_table[r["cands"]]
        act[b] = r["action"]
        adv[b] = r["advantage"]
    return {"o": o, "a": a, "mask": mask, "action": act, "adv": adv}


def reinforce_train(rows, act_table, init_params=None, epochs=1, seed=0,
                    batch=REINFORCE_BATCH, lr=REINFORCE_LR, beta_ent=BETA_ENT):
    """固定 lr 的批量策略梯度：逐 epoch shuffle（显式 rng）→ 每批一次 Adam step。

    无 cosine 衰减、无 val 早停——总预算在 TS 侧按环境交互步数封顶；`init_params` 只
    用于同一次 REINFORCE 训练的续训，不从 BC checkpoint 热启（A.2 预注册）。
    """
    if epochs < 1 or batch < 1:
        raise ValueError("reinforce_train: epochs/batch 必须为正整数")
    rng = random.Random(seed)
    dims = {"obsDim": train.EXPECTED_OBS_DIM, "actDim": train.ACT_DIM, "h": train.H, "head": "none"}
    params = train_nn.params_from_json({"dims": dims, "params": init_params} if init_params else dims, seed)
    opt = train_nn.Adam(params)
    steps = 0
    for _ in range(epochs):
        order = list(range(len(rows)))
        rng.shuffle(order)
        for start in range(0, len(order), batch):
            chunk = [rows[i] for i in order[start:start + batch]]
            bm = _assemble(chunk, act_table)
            grads = reinforce_nn.backward_reinforce(
                params, bm["o"], bm["a"], bm["mask"], bm["action"], bm["adv"], beta_ent)
            opt.step(params, grads, lr)
            steps += 1
    return {"params": params, "steps": steps, "epochs": epochs}


def main(argv=None):
    ap = argparse.ArgumentParser(prog="controller/train.py --loss reinforce",
                                 description="DataGraphLab REINFORCE 批量策略梯度：reinforce.bin → weights.json")
    ap.add_argument("--loss", default="reinforce", choices=("reinforce",), help="分流标记（由 train.py 透传）")
    ap.add_argument("--train", required=True, help="reinforce.bin 路径")
    ap.add_argument("--out", required=True, help="weights.json 输出路径")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--epochs", type=int, default=1)
    ap.add_argument("--batch", type=int, default=REINFORCE_BATCH)
    ap.add_argument("--lr", type=float, default=REINFORCE_LR)
    ap.add_argument("--beta-ent", type=float, default=BETA_ENT, dest="beta_ent")
    ap.add_argument("--init", help="续训起点 weights.json（可选；禁从 BC 热启由调用方保证）")
    args = ap.parse_args(argv)
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    code = hashlib.sha256()
    me = Path(__file__).resolve()
    code.update(me.read_bytes())
    code.update((me.parent / "train_nn.py").read_bytes())
    code.update((me.parent / "reinforce_nn.py").read_bytes())
    rows, act_table = load_reinforce_rows(args.train, "reinforce.bin")
    init_params = None
    if args.init:
        doc = json.loads(Path(args.init).read_text(encoding="utf-8"))
        if doc.get("dims", {}).get("head") != "none":
            raise ValueError("--init 只接受 head=none 的 REINFORCE 权重（禁 BC checkpoint 热启）")
        init_params = doc["params"]
    fit = reinforce_train(rows, act_table, init_params, epochs=args.epochs, seed=args.seed,
                          batch=args.batch, lr=args.lr, beta_ent=args.beta_ent)
    arch = train.build_arch(train.EXPECTED_OBS_DIM, "none")
    for key, arr in fit["params"].items():
        if not np.isfinite(arr).all():
            raise ValueError(f"落盘自检失败：参数 {key} 含 NaN/Inf")
    doc = {
        "arch": arch,
        "dims": {"featureSet": "lang", "obsDim": train.EXPECTED_OBS_DIM, "actDim": train.ACT_DIM,
                 "h": train.H, "head": "none"},
        "params": train_nn.params_to_json(fit["params"]),
        "train_meta": {
            "reinforce_bin_sha256": hashlib.sha256(Path(args.train).read_bytes()).hexdigest(),
            "code_hash": code.hexdigest(),
            "arch": arch,
            "mode": "reinforce",
            "seed": args.seed,
            "batch": args.batch,
            "lr": args.lr,
            "beta_ent": args.beta_ent,
            "epochs": fit["epochs"],
            "batches": fit["steps"],
            "rows": len(rows),
            "head": "none",
            "action_features": "bin_header_table_v2",
        },
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({"mode": "reinforce", "rows": len(rows), "batches": fit["steps"],
                      "out": args.out}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
