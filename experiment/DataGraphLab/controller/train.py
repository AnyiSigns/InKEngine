# -*- coding: utf-8 -*-
"""BC 批量拟合训练器（行为克隆唯一 Python 入口）：records.bin → weights.json。

职责边界：本文件只做 CLI、`.bin` 字节解析（契约见 data/records_bin.ts 头注，全
little-endian、手写 struct 解析、零第三方依赖）、按 val CE 的早停编排与
weights.json 落盘；全部张量数学在 train_nn.py（反向只此一份实现）。

records.bin v2 契约补齐了跨语言缺口：候选动作特征不逐行重复存（「由 node id 确定」，
F.2），而是按 ROUTING 序在 header 存一张 nAct×actDim 稀疏表；行内 candMask 是 22 位
全局位掩码，置位下标升序就是该步候选在动作表中的行号，据此重建批量动作张量 a（批内
变长候选 pad 到本批 max m、pad 位由掩码挡住，train_nn 的数值梯度检查本就覆盖该路径）。
   本侧只查表、不复刻任何特征函数——动作表内容与 TS 推理端特征函数产物天然同源。
v1 的「占位动作表」随之下线：version≠2 一律 fail-fast 拒读。

哈希纪律：只对外部文件字节与两份源码字节取 sha256，不做任何 canonical-JSON。
"""

import argparse
import hashlib
import json
import math
import random
import struct
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import train_nn  # noqa: E402

MAGIC = b"DGLB"
BIN_VERSION = 2
HEADER = struct.Struct("<4sIIIII")
EXPECTED_OBS_DIM = 732  # 主臂特征集 lang 的 obs 宽度，与 arch 串互相钉死
EXPECTED_ACT_DIM = 83  # 动作特征宽度（契约派生+哈希桶），与 arch 串互相钉死
ARCH_VERSION = 1
H = 128
ACT_DIM = 83


def _read_act_table(raw, off, label, n_act, act_dim):
    """header 动作特征表（ROUTING 序、稀疏块）→ 稠密 nAct×actDim 表；越界/NaN fail-fast。"""
    if not 1 <= n_act <= 32:
        raise ValueError(f"{label}: header nAct={n_act} 须在 [1, 32]（candMask 是 u32）")
    if act_dim != EXPECTED_ACT_DIM:
        raise ValueError(f"{label}: header actDim={act_dim} 与 arch 钉死的 {EXPECTED_ACT_DIM} 不符")
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
            raise ValueError(f"{label}: 动作表[{j}] 含 NaN/Inf 浮点，拒用")
        table[j, idx.astype(np.int64)] = val.astype(np.float64)
    return table, off


def load_rows(path, label):
    """解析 records.bin v2 → (行列表, header 动作表)；外部字节边界全量 fail-fast。"""
    raw = Path(path).read_bytes()
    if len(raw) < HEADER.size:
        raise ValueError(f"{label}: 文件短于 24 字节 header，无法解析")
    magic, version, nrows, obs_dim, act_dim, n_act = HEADER.unpack_from(raw, 0)
    if magic != MAGIC:
        raise ValueError(f"{label}: magic={magic!r} 非 {MAGIC!r}，非 records.bin 格式")
    if version != BIN_VERSION:
        raise ValueError(
            f"{label}: bin 版本已升级（version={version}，本实现 pin {BIN_VERSION}），请重跑 featurize")
    if obs_dim != EXPECTED_OBS_DIM:
        raise ValueError(f"{label}: header obsDim={obs_dim} 与 arch 钉死的 {EXPECTED_OBS_DIM} 不符")
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
            (target_idx,) = struct.unpack_from("<i", raw, off)
            off += 4
            (prog_label,) = struct.unpack_from("<f", raw, off)
            off += 4
            (prog_weight,) = struct.unpack_from("<I", raw, off)
            off += 4
        except (IndexError, struct.error, UnicodeDecodeError) as e:
            raise ValueError(f"{label}: 第 {i} 行解析越界/坏数据（文件截断？）: {e}") from e
        if cand_mask >> n_act:
            raise ValueError(f"{label}: 第 {i} 行 candMask 置位越过动作表宽 {n_act}")
        cands = [j for j in range(n_act) if (cand_mask >> j) & 1]  # 升序 ↔ 候选本地下标
        m = len(cands)
        if m == 0:
            raise ValueError(f"{label}: 第 {i} 行候选掩码为空，softmax 无定义")
        if not 0 <= target_idx < m:
            raise ValueError(f"{label}: 第 {i} 行 targetIdx={target_idx} 不在 [0, {m})")
        if n_idx and (idx[0] >= EXPECTED_OBS_DIM or np.any(np.diff(idx) <= 0)):
            raise ValueError(f"{label}: 第 {i} 行稀疏下标越界或非严格升序")
        if (n_idx and not np.isfinite(val).all()) or not math.isfinite(float(prog_label)):
            raise ValueError(f"{label}: 第 {i} 行含 NaN/Inf 浮点，拒用")
        if prog_weight not in (0, 1) or style not in (0, 1) or family not in (0, 1, 2, 3):
            raise ValueError(f"{label}: 第 {i} 行 style/family/progressWeight 值域越界")
        rows.append({"idx": idx.astype(np.int64), "val": val.astype(np.float64),
                     "cands": np.array(cands, dtype=np.int64), "m": m,
                     "target": int(target_idx), "prog_label": float(prog_label),
                     "prog_weight": float(prog_weight), "task_hash": task_hash,
                     "step_index": int(step_index)})
    if off != len(raw):
        raise ValueError(f"{label}: 行尾多余 {len(raw) - off} 字节，文件异常")
    if not rows:
        raise ValueError(f"{label}: nrows=0，空数据集上训练/早停无定义")
    return rows, act_table


def _assemble(rows, act_table):
    """行列表 → 稠密批：稀疏 obs 散列回填；动作张量按 candMask 位序查 header 表，
    批内变长候选 pad 到本批 max m，pad 位由掩码挡住、梯度零贡献。"""
    b_n = len(rows)
    m_max = max(r["m"] for r in rows)
    o = np.zeros((b_n, EXPECTED_OBS_DIM))
    mask = np.zeros((b_n, m_max), dtype=bool)
    a = np.zeros((b_n, m_max, EXPECTED_ACT_DIM))
    for b, r in enumerate(rows):
        o[b, r["idx"]] = r["val"]
        mask[b, : r["m"]] = True
        a[b, : r["m"]] = act_table[r["cands"]]  # 第 i 个置位 ↔ 候选 i（F.2 原口径）
    return {"o": o, "a": a, "mask": mask,
            "target": np.array([r["target"] for r in rows]),
            "pl": np.array([r["prog_label"] for r in rows]),
            "pw": np.array([r["prog_weight"] for r in rows])}


def val_ce(params, rows, act_table):
    """早停指标：目标位负对数似然的均值（无平滑）——连续可比的分布拟合度量。"""
    tot, n = 0.0, 0
    for start in range(0, len(rows), 4096):
        bm = _assemble(rows[start:start + 4096], act_table)
        p = train_nn.policy_forward(params, bm["o"], bm["a"], bm["mask"])
        pick = np.take_along_axis(p, bm["target"][:, None], axis=1)[:, 0]
        tot += float(-np.log(np.clip(pick, 1e-300, None)).sum())
        n += len(bm["target"])
    return tot / max(1, n)


def bc_train(D, val_D, act_table, epochs=30, patience=4, min_epochs=5, min_delta=1e-4,
             seed=0, batch=512, lr_schedule="cosine", head="progress", save_last_k=5):
    """行为克隆主循环：cosine lr（3e-3×0.5(1+cos(πe/E))）、每轮 shuffle（显式 rng）、
    val CE 早停并恢复 best、落最近 K 个 epoch 快照（epoch 序，钉死不降）供推理侧选点。
    """
    rng = random.Random(seed)
    dims = {"obsDim": EXPECTED_OBS_DIM, "actDim": ACT_DIM, "h": H, "head": head}
    params = train_nn.params_from_json(dims, seed)
    opt = train_nn.Adam(params)
    best, best_ce, best_epoch, bad = None, float("inf"), None, 0
    last_k, ran, ce = [], 0, float("nan")
    for epoch in range(epochs):
        if lr_schedule == "cosine":
            lr = 3e-3 * 0.5 * (1.0 + math.cos(math.pi * epoch / epochs))
        else:
            lr = 3e-3
        order = list(D)
        rng.shuffle(order)
        for start in range(0, len(order), batch):
            bm = _assemble(order[start:start + batch], act_table)
            opt.step(params, train_nn.backward(
                params, bm["o"], bm["a"], bm["mask"], bm["target"],
                progress_label=bm["pl"] if head == "progress" else None,
                progress_weight=bm["pw"] if head == "progress" else None), lr)
        ce = val_ce(params, val_D, act_table)
        ran = epoch + 1
        last_k.append({"epoch": epoch, "val_ce": ce,
                       "params": train_nn.params_to_json(params)})
        if len(last_k) > save_last_k:
            last_k.pop(0)
        if ce < best_ce - min_delta:
            best, best_ce, best_epoch, bad = train_nn.params_to_json(params), ce, epoch, 0
        else:
            bad += 1
            if bad >= patience and ran >= min_epochs:
                break
    if best is not None:  # 恢复 best 轮权重（终点可能已过拟合）；从未改进时保留终点
        params = train_nn.params_from_json({"dims": dims, "params": best}, seed)
    return {"params": params, "epoch_snapshots": last_k, "best_epoch": best_epoch,
            "final_val_ce": ce, "epochs_run": ran, "best_ce": best_ce}


def build_arch(obs_dim, head):
    """arch 串与 checkpoint.ts 的 currentArch 逐字符同构：版本+特征集+dims+头。"""
    return f"v{ARCH_VERSION}:lang:{obs_dim}:{ACT_DIM}:{H}:{head}"


def _loss_of(argv):
    """原始 argv 里 `--loss` 的取值：reinforce 有独立超参与独立入口，须在 argparse 前分流。"""
    for i, a in enumerate(argv):
        if a == "--loss" and i + 1 < len(argv):
            return argv[i + 1]
        if a.startswith("--loss="):
            return a.split("=", 1)[1]
    return "ce"


def main(argv=None):
    raw = sys.argv[1:] if argv is None else list(argv)
    if _loss_of(raw) == "reinforce":
        import train_reinforce
        return train_reinforce.main(raw)
    ap = argparse.ArgumentParser(prog="controller/train.py",
                                 description="DataGraphLab BC 批量拟合：records.bin → weights.json")
    ap.add_argument("--train", help="训练 records.bin 路径")
    ap.add_argument("--val", help="验证 records.bin 路径（早停指标源）")
    ap.add_argument("--out", help="weights.json 输出路径")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--batch", type=int, default=512)
    ap.add_argument("--save-last-k", type=int, default=5, dest="save_last_k")
    ap.add_argument("--head", choices=("progress", "none"), default="progress")
    ap.add_argument("--loss", default="ce")
    ap.add_argument("--check-grad", action="store_true", dest="check_grad")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(raw)
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    if args.check_grad:
        return 0 if train_nn.check_numeric_gradient() else 1
    if args.selftest:
        return 0 if train_nn.memory_selftest(seed=args.seed)["train_acc"] >= 0.99 else 1
    if args.loss != "ce":
        ap.error("--loss 仅支持 ce|reinforce（reinforce 已在上游分流）")
    missing = [k for k in ("train", "val", "out") if getattr(args, k) is None]
    if missing:
        ap.error("训练模式缺少参数: " + " ".join("--" + m for m in missing))
    if args.epochs < 1 or args.batch < 1:
        ap.error("--epochs/--batch 必须为正整数")
    code = hashlib.sha256()
    me = Path(__file__).resolve()
    code.update(me.read_bytes())
    code.update((me.parent / "train_nn.py").read_bytes())
    D, act_train = load_rows(args.train, "train.bin")
    V, act_val = load_rows(args.val, "val.bin")
    if not np.array_equal(act_train, act_val):
        raise ValueError("train.bin 与 val.bin 的 header 动作表不一致（不同 featurize 产物混跑，拒练）")
    k = max(5, args.save_last_k)  # 快照数钉死不降：推理侧选点的最短窗口
    fit = bc_train(D, V, act_train, epochs=args.epochs, seed=args.seed, batch=args.batch,
                   head=args.head, save_last_k=k)
    arch = build_arch(EXPECTED_OBS_DIM, args.head)
    init = train_nn.params_from_json({"obsDim": EXPECTED_OBS_DIM, "actDim": ACT_DIM,
                                      "h": H, "head": args.head}, 0)
    for key, arr in fit["params"].items():
        if not np.isfinite(arr).all():
            raise ValueError(f"落盘自检失败：参数 {key} 含 NaN/Inf")
        if arr.shape != init[key].shape:
            raise ValueError(f"落盘自检失败：参数 {key} 形状 {arr.shape} ≠ {init[key].shape}")
    doc = {
        "arch": arch,
        "dims": {"featureSet": "lang", "obsDim": EXPECTED_OBS_DIM, "actDim": ACT_DIM,
                 "h": H, "head": args.head},
        "params": train_nn.params_to_json(fit["params"]),
        "train_meta": {
            "records_bin_sha256": hashlib.sha256(Path(args.train).read_bytes()).hexdigest(),
            "val_bin_sha256": hashlib.sha256(Path(args.val).read_bytes()).hexdigest(),
            "code_hash": code.hexdigest(),
            "arch": arch,
            "seed": args.seed,
            "batch": args.batch,
            "epochs_run": fit["epochs_run"],
            "final_val_ce": fit["final_val_ce"],
            "best_epoch": fit["best_epoch"],
            "epoch_snapshots": fit["epoch_snapshots"],
            "label_smoothing": train_nn.LABEL_SMOOTHING,
            "weight_decay": train_nn.WEIGHT_DECAY,
            "head": args.head,
            "action_features": "bin_header_table_v2",
        },
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({"final_val_ce": fit["final_val_ce"], "epochs_run": fit["epochs_run"],
                      "best_epoch": fit["best_epoch"], "out": args.out}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
