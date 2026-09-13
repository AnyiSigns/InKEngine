# -*- coding: utf-8 -*-
"""F1/F2 跨语言前向 conformance 入口：读 fixture → 调 train_nn 前向数学 → 写结果。

前向数学唯一实现地是 controller/train_nn.py（本文件只做输入装配与输出落盘，
零公式复刻）；obs 与候选特征一律直读 fixture 内冻结向量，本侧没有任何按节点
id 重建特征的代码——特征语义只有 TS 一份源头（F.3 静态审计零容忍）。
数值口径：params 与输入全部转 float64 后交给 train_nn 的 f64 链（F1 判「数学
等价」用高精度路径，规避 BLAS 与 JS 循环在 float32 求和顺序上的伪差异）。

用法：py_forward.py --mode f1|f2 --in <fixture.json> [--weights <weights.json>]
      --out <out.json>
      --weights 给出时覆盖 fixture 内权重（供真实训练产物 weights.json 复跑 F2）。
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "controller"))
import train_nn  # noqa: E402

POLICY_KEYS = ("wo", "bo", "wa", "ba", "ws")
TIE_WINDOW = 1e-4  # F2 并列窗口：|top1−top2| 小于阈按索引小者


def _load_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _dense(vec, dim, label):
    """稀疏 {idx,val} 或稠密列表 → float64 向量（越界 fail-fast，不静默截断）。"""
    out = np.zeros(int(dim), dtype=np.float64)
    if isinstance(vec, dict):
        idx, val = vec.get("idx", []), vec.get("val", [])
        if len(idx) != len(val):
            raise ValueError(f"{label}: 稀疏 idx/val 长度不一致")
        for i, v in zip(idx, val):
            out[int(i)] = float(v)
    else:
        if len(vec) != int(dim):
            raise ValueError(f"{label}: 稠密向量长度 {len(vec)} != {dim}")
        out = np.asarray(vec, dtype=np.float64)
    return out


def _params(weights, label):
    """子集/完整 weights.json 的 params 段 → train_nn 前向所需五张量 dict（f64）。"""
    src = weights.get("params", weights) if isinstance(weights, dict) else None
    if not isinstance(src, dict):
        raise ValueError(f"{label}: weights 段缺失或不是对象")
    out = {}
    for key in POLICY_KEYS:
        t = src.get(key)
        if not isinstance(t, dict) or "shape" not in t or "data" not in t:
            raise ValueError(f"{label}: params.{key} 缺失或缺 shape/data")
        shape = tuple(int(x) for x in t["shape"])
        data = np.asarray(t["data"], dtype=np.float64)
        if data.size != int(np.prod(shape) or 0):
            raise ValueError(f"{label}: params.{key} data 长度与 shape 不符")
        out[key] = data.reshape(shape) if shape else np.zeros(0, dtype=np.float64)
    return out


def _resolve_weights(bundle, parent, in_path, cli_weights, label):
    """权重取用优先级：CLI --weights > 组内 weights/weights_path > 文件顶层同名字段。"""
    if cli_weights:
        return _params(_load_json(cli_weights), label + "(--weights)")
    for holder in (bundle, parent):
        src = holder.get("weights")
        if src is not None:
            return _params(src, label)
        if holder.get("weights_path"):
            ref = _load_json(Path(in_path).parent / str(holder["weights_path"]))
            return _params(ref.get("weights", ref), label)
    raise ValueError(f"{label}: 既无内联 weights 也无 weights_path")


def _forward_probs(params, group, obs_dim, label):
    """(obs, 候选特征列表) → f64 softmax 概率；f2 的 obs 向量在 obs_vec（obs 留给溯源）。"""
    vec = group["obs_vec"] if "obs_vec" in group else group["obs"]
    o = _dense(vec, obs_dim, label + "/obs")
    feats = group.get("candidates_act_feats")
    if not isinstance(feats, list) or len(feats) < 1:
        raise ValueError(f"{label}: candidates_act_feats 缺失或候选集为空")
    n_cand = len(group.get("candidates", feats))
    if n_cand != len(feats):
        raise ValueError(f"{label}: 候选 id 数与特征行数不一致")
    a = np.asarray(feats, dtype=np.float64)
    act_dim = int(params["wa"].shape[1])
    if a.shape != (len(feats), act_dim):
        raise ValueError(f"{label}: 动作特征形状 {a.shape} 与 wa 尾维 {act_dim} 不符")
    mask = np.ones(len(feats), dtype=bool)
    return train_nn.policy_forward(params, o, a, mask)


def _run_group(params, group, obs_dim, label, strict_top2):
    p = np.asarray(_forward_probs(params, group, obs_dim, label), dtype=np.float64).ravel()
    if strict_top2 and p.size < 2:
        raise ValueError(f"{label}: 候选数不足 2，无法给出 top2")
    return p


def main(argv=None):
    ap = argparse.ArgumentParser(description="F1/F2 跨语言前向 conformance 入口")
    ap.add_argument("--mode", required=True, choices=("f1", "f2"))
    ap.add_argument("--in", dest="in_path", required=True)
    ap.add_argument("--out", dest="out_path", required=True)
    ap.add_argument("--weights", default=None)
    args = ap.parse_args(argv)

    fx = _load_json(args.in_path)
    if args.mode == "f1":
        groups = fx.get("groups")
        if not isinstance(groups, list) or not groups:
            raise ValueError("f1: fixture 缺 groups 列表")
        out = []
        for k, g in enumerate(groups):
            params = _resolve_weights(g, fx, args.in_path, args.weights, f"f1#{k}")
            p = _run_group(params, g, fx.get("obsDim", 732), f"f1#{k}", False)
            out.append({"scores": [float(x) for x in p]})
    else:
        tasks = fx.get("tasks")
        if not isinstance(tasks, list) or not tasks:
            raise ValueError("f2: fixture 缺 tasks 列表")
        out = []
        for k, t in enumerate(tasks):
            params = _resolve_weights(t, fx, args.in_path, args.weights, f"f2#{k}")
            p = _run_group(params, t, fx.get("obsDim"), f"f2#{k}", True)
            order = np.argsort(-p, kind="stable")
            i1, i2 = int(order[0]), int(order[1])
            top1, top2 = float(p[i1]), float(p[i2])
            tied = (top1 - top2) < TIE_WINDOW
            action = min(i1, i2) if tied else i1
            out.append({"action_idx": action, "top1": top1, "top2": top2, "tied": bool(tied)})
    Path(args.out_path).write_text(json.dumps(out), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
