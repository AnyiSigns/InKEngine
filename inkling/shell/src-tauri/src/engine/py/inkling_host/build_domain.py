"""构建管线域（设计文档第六节模块 M3-2 构建管线）。

build.json（数据声明）→ 引擎 Builder（白名单沙箱构建 + 内容寻址产物 +
冒烟门禁）的宿主接线：

- **builder 白名单沙箱构建**：构建命令白名单 = build.json（数据驱动），
  非白名单命令 fail-closed 拒绝；产物内容寻址（artifact_id = 类别 +
  内容哈希前缀），文件级 sha256 哈希可校验；
- **冒烟门禁**：产物 promote 前经探针自检（命令/期望退出码可配置 =
  数据驱动），失败不落产物记录、不发起补丁（保留现状 + 留痕）；
- **vetting_l2_hook 挂钩**：ARTIFACT 补丁（L2 档）部署前经本域钩子
  验证——产物目录哈希逐文件比对 + 冒烟记录（meta.smoke.ok），验证
  失败拒绝落链；
- **artifact 补丁落链**：构建产物描述（artifact_id/kind/hashes/meta）
  → SelfProposal（ARTIFACT，L2 人工审批）→ 补丁链；应用目标把产物
  声明的工具注册进工具表（产物挂载引擎）；
- **container 部署**：产物声明容器形态（deploy.image_prefix + 内容
  寻址 id = 镜像名），经容器环境提供器运行（隔离边界，重执行件安全
  落地的通道；Docker 不可用时结构化降级）。

构建耗时/成败/错误码随结构化日志与产物 meta 留痕（可观测性）。
"""
from __future__ import annotations

import contextlib
import json
import os
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from ink_engine.core.builder import (
    BuildArtifact,
    Builder,
    BuildError,
    BuildKind,
    BuildSpec,
    SmokeProbe,
    SmokeResult,
)
from ink_engine.core.declarative_tools import DeclarativeToolSpec
from ink_engine.core.logging import get_logger
from ink_engine.core.sandbox import ProcessSandbox
from ink_engine.core.self_application import ApplyTarget
from ink_engine.core.self_proposal import PatchKind, SelfProposal

logger = get_logger("host.build")

# 构建/冒烟/挂载失败的错误码（结构化可观测，防魔法字符串）
BUILD_ERROR_WHITELIST = "BLD_001"  # 构建命令不在白名单（fail-closed）
BUILD_ERROR_FAILED = "BLD_002"  # 构建命令失败/超时/产物缺失
BUILD_ERROR_SMOKE = "BLD_003"  # 冒烟门禁未通过（不 promote）
BUILD_ERROR_VETTING = "BLD_004"  # ARTIFACT 补丁部署前验证未通过

# 前端组件清单落位（data_dir/components/manifest.json——壳 components_manifest
# 命令与前端 artifactLoader 的消费文件；本域是其唯一写入方，链为权威）
COMPONENT_DIR_NAME = "components"
COMPONENT_MANIFEST_FILE = "manifest.json"


class BuildDomain:
    """构建管线域（build.json 数据 + 引擎 Builder + 补丁链/部署接线）。

    Args:
        build_data: seed_data/build.json 装载产物（数据驱动声明）。
        artifact_dir: 产物根目录（内容寻址子目录）。
    """

    def __init__(
        self,
        build_data: dict[str, Any],
        *,
        artifact_dir: str | Path,
    ) -> None:
        builder_cfg = build_data.get("builder") or {}
        self._allowlist = tuple(builder_cfg.get("allowlist") or ())
        timeout = float(builder_cfg.get("default_timeout") or 120.0)
        # 宿主注入平台 PATH（引擎不替宿主决定平台默认值；白名单裸命令
        # 名经 PATH 解析——构建/冒烟同用）
        self._sandbox = ProcessSandbox(
            allowlist=self._allowlist,
            timeout=timeout,
            path=os.environ.get("PATH"),
        )
        self._artifact_dir = Path(artifact_dir)
        self._builder = Builder(self._sandbox, self._artifact_dir)
        probe_cfg = (build_data.get("smoke_probes") or {}).get("default") or {}
        self._default_probe = SmokeProbe(
            command=str(probe_cfg.get("command") or "echo"),
            args=tuple(probe_cfg.get("args") or ()),
            timeout=float(probe_cfg.get("timeout") or 30.0),
            expect_exit=int(probe_cfg.get("expect_exit") or 0),
        )
        deploy_cfg = build_data.get("deploy") or {}
        self._deploy = dict(deploy_cfg)
        self._runtime: Any | None = None
        # 活跃产物登记（artifact_id → BuildArtifact；补丁/部署/校验取用）
        self.artifacts: dict[str, BuildArtifact] = {}
        # 产物声明工具登记（工具名 → artifact_id；回退同步的移除依据）
        self.declared_tools: dict[str, str] = {}

    def attach(self, runtime: Any) -> None:
        """运行时注入（提案/重建/工具表生效需要；boot 装配期调用）。"""
        self._runtime = runtime

    # ── 构建与冒烟 ──

    def build_spec(
        self,
        *,
        kind: str,
        command: str,
        args: tuple[str, ...] = (),
        workdir: str | Path = ".",
        output_paths: tuple[str, ...],
        meta: dict[str, Any] | None = None,
    ) -> BuildSpec:
        """构建声明（命令/产物清单数据驱动；白名单在 Builder 内强制）。"""
        return BuildSpec(
            kind=BuildKind(kind),
            command=command,
            args=tuple(args),
            workdir=workdir,
            output_paths=tuple(output_paths),
            meta=dict(meta or {}),
        )

    async def build(self, spec: BuildSpec) -> BuildArtifact:
        """执行构建（白名单/产物收口/内容寻址全在 Builder；耗时留痕）。"""
        started = time.monotonic()
        try:
            artifact = await self._builder.build(spec)
        except BuildError as exc:
            code = (
                BUILD_ERROR_WHITELIST
                if spec.command not in self._allowlist
                else BUILD_ERROR_FAILED
            )
            logger.warning(
                "build failed code=%s command=%s duration_ms=%d reason=%s",
                code,
                spec.command,
                int((time.monotonic() - started) * 1000),
                exc,
            )
            raise
        self.artifacts[artifact.artifact_id] = artifact
        logger.info(
            "build ok artifact=%s kind=%s duration_ms=%d files=%d",
            artifact.artifact_id,
            artifact.kind,
            int((time.monotonic() - started) * 1000),
            len(artifact.files),
        )
        return artifact

    async def smoke(self, artifact: BuildArtifact, probe: SmokeProbe | None = None) -> SmokeResult:
        """冒烟门禁（缺省探针 = build.json default；命令须在白名单内）。"""
        started = time.monotonic()
        probe = probe or self._default_probe
        result = await self._builder.smoke(artifact, probe)
        logger.info(
            "smoke %s artifact=%s command=%s duration_ms=%d exit=%s",
            "ok" if result.ok else "failed",
            artifact.artifact_id,
            probe.command,
            int((time.monotonic() - started) * 1000),
            result.exit_code,
        )
        return result

    def default_probe(self) -> SmokeProbe:
        return self._default_probe

    def artifact_dir(self, artifact: BuildArtifact) -> Path:
        return self._builder.artifact_dir(artifact)

    def sync_artifact_tools(self, runtime: Any, artifacts: dict[str, Any]) -> None:
        """产物声明工具与链同步（回退/重启后：链内注册、链外移除）。

        补丁链是权威记录：链内产物的声明工具注册进工具表（幂等），
        此前已注册但已不在链内的声明工具移除（回退 = 挂载撤销）。
        """
        from ink_engine.core.declarative_tools import DeclarativeToolSpec

        in_chain: set[str] = set()
        for payload in (artifacts or {}).values():
            if not isinstance(payload, dict):
                continue
            tool_data = (payload.get("meta") or {}).get("tool")
            if not isinstance(tool_data, dict):
                continue
            with contextlib.suppress(Exception):
                spec = DeclarativeToolSpec.from_dict(tool_data)
                runtime.harness_registry.declarative.register_definition(spec)
                runtime.tool_registry[spec.name] = spec.to_spec()
                self.declared_tools[spec.name] = str(payload.get("artifact_id") or "")
                in_chain.add(spec.name)
        for name, _artifact_id in list(self.declared_tools.items()):
            if name not in in_chain:
                runtime.tool_registry.pop(name, None)
                runtime.harness_registry.declarative.unregister_definition(name)
                self.declared_tools.pop(name, None)

    # ── 前端组件清单（已挂载 UI 组件的权威落位：链 → manifest.json）──

    def component_manifest_path(self) -> Path:
        """前端组件清单路径（data_dir/components/manifest.json）。

        与壳侧 components_manifest 命令读取文件同一路径（data_dir 为
        壳 app_data_dir 注入）；本域 = 唯一写入方，补丁链为权威。
        """
        return self._artifact_dir.parent / COMPONENT_DIR_NAME / COMPONENT_MANIFEST_FILE

    @staticmethod
    def component_entry_from_payload(payload: Any) -> dict[str, Any] | None:
        """ARTIFACT 补丁载荷 → 前端组件清单条目（无组件声明 = None）。

        组件声明 = ``meta.component``（agent 自写/外部拉取 UI 组件的数据
        形态）：name 必填，url 缺省回落本地产物首文件路径
        （``artifacts/<id>/<file>``——能否加载取决于宿主提供方式，清单
        条目本身以链为权威）。renderer_key/view_forms 有值才携带（与
        前端 ArtifactManifestEntry 契约对齐）。
        """
        if not isinstance(payload, dict):
            return None
        meta = payload.get("meta")
        if not isinstance(meta, dict):
            return None
        component = meta.get("component")
        if not isinstance(component, dict):
            return None
        name = str(component.get("name") or "").strip()
        if not name:
            return None
        hashes = payload.get("hashes")
        file_names = list((hashes or {}).keys()) if isinstance(hashes, dict) else []
        first_hash = ""
        if isinstance(hashes, dict):
            first_hash = next((str(h) for h in hashes.values() if h), "")
        url = str(component.get("url") or "").strip()
        if not url:
            artifact_id = str(payload.get("artifact_id") or "")
            url = f"artifacts/{artifact_id}/{file_names[0]}" if artifact_id and file_names else ""
        entry: dict[str, Any] = {
            "name": name,
            "url": url,
            "hash": str(component.get("hash") or first_hash or ""),
            "version": str(component.get("version") or "1"),
        }
        if component.get("renderer_key"):
            entry["renderer_key"] = str(component["renderer_key"])
        if isinstance(component.get("view_forms"), list):
            entry["view_forms"] = component["view_forms"]
        return entry

    def sync_component_manifest(self, artifacts: dict[str, Any] | None) -> None:
        """从链产物声明重建前端组件清单（补丁链 = 权威，幂等可重放）。

        链内产物带组件声明（meta.component）→ 写入清单条目；链外
        （回退撤销）自动移除。前端 artifactLoader 消费本文件注册
        即插即显；写入失败留痕不抛穿（派生数据，重启装配重建）。
        """
        entries: list[dict[str, Any]] = []
        for payload in (artifacts or {}).values():
            entry = self.component_entry_from_payload(payload)
            if entry is not None:
                entries.append(entry)
        path = self.component_manifest_path()
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(
                json.dumps({"artifacts": entries}, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except OSError as exc:
            logger.warning("组件清单写入失败 path=%s reason=%s", path, exc)

    # ── ARTIFACT 补丁链路 ──

    def l2_vetting_hook(self) -> Callable[[Any], list[str]]:
        """ARTIFACT 补丁部署前验证（vetting_l2_hook 挂钩）。

        双形态（fail-closed）：
        - 外部 URL 组件（``meta.component.url`` 直引，dsh 形态）：验证
          URL 为 http(s) + 名称声明齐备，L2 人工审批把关；
        - 本地构建产物：产物在构建登记内、声明的文件哈希与产物目录
          逐文件一致、冒烟记录为通过（meta.smoke.ok）。
        非 ARTIFACT 补丁不在此钩子作用域（放行，交给审批分级）。
        """

        def hook(proposal: Any) -> list[str]:
            if getattr(proposal, "kind", None) is not PatchKind.ARTIFACT:
                return []
            payload = proposal.payload or {}
            component = (payload.get("meta") or {}).get("component")
            if isinstance(component, dict) and component.get("url"):
                # 外部 URL 组件（dsh 形态：直引 http(s) 构件，无本地构建）：
                # 验证面 = URL 形态 + 名称声明，L2 人工审批把关
                url = str(component["url"])
                if not (url.startswith("http://") or url.startswith("https://")):
                    return ["外部组件 url 仅支持 http(s)（部署前门禁，fail-closed）"]
                if not str(component.get("name") or "").strip():
                    return ["外部组件声明缺 name（部署前门禁，fail-closed）"]
                return []
            artifact = self.artifacts.get(str(payload.get("artifact_id") or ""))
            if artifact is None:
                return ["产物未在构建登记（artifact_id 不存在于本域产物目录）"]
            hashes = payload.get("hashes") or {}
            for name, digest in hashes.items():
                if not self._builder.verify_hash(artifact, name, digest):
                    return [f"产物哈希校验未通过: {name}（部署前门禁，fail-closed）"]
            smoke = (payload.get("meta") or {}).get("smoke") or {}
            if smoke.get("ok") is not True:
                return ["冒烟记录缺失或未通过（产物不得跳过冒烟门禁 promote）"]
            return []

        return hook

    async def propose_artifact_patch(
        self,
        ctx: Any,
        artifact: BuildArtifact,
        *,
        declared_tool: DeclarativeToolSpec | None = None,
        smoke: SmokeResult | None = None,
        round_id: str | None = None,
    ) -> Any:
        """构建产物 → ARTIFACT 补丁提案（L2 人工审批 → 落链 → 挂载）。

        产物描述 = 数据（artifact_id/kind/hashes + meta：声明工具/冒烟
        记录/构建耗时）；审批通过后经 ArtifactApplyTarget 把声明工具
        注册进工具表（产物挂载引擎，工具表即时生效）。

        冒烟门禁强制（ENG7-3）：``smoke=None`` 拒绝直接走 propose——
        冒烟是产物的不可跳过的环节（vetting_l2_hook 也会在落链前拦
        截，但「先 produce 再被拦」是双失败路径）；本入口先决校验
        ``smoke.ok is True``，未冒烟或冒烟失败 = 抛 ``BuildError``，
        调用方需先调 :meth:`smoke`（或 :meth:`build_and_verify` 一
        站完成）拿到冒烟结果再 propose。
        """
        if smoke is None:
            raise BuildError(
                "propose_artifact_patch 必须传入冒烟结果（smoke=None 拒绝；"
                "先调 build_and_verify 或本域 smoke() 取得 smoke.ok=True 再 propose）"
            )
        if not smoke.ok:
            raise BuildError(
                f"冒烟门禁未通过：propose_artifact_patch 拒绝（exit={smoke.exit_code}）"
            )
        if self._runtime is None or self._runtime.self_pipeline is None:
            raise BuildError("构建域未装配运行时（无法发起产物补丁）")
        meta: dict[str, Any] = {
            "built_at": artifact.built_at,
            "kind_label": artifact.kind,
            "smoke": {"ok": bool(smoke and smoke.ok), "output": (smoke.output if smoke else "")[:500]},
        }
        if declared_tool is not None:
            meta["tool"] = declared_tool.to_dict()
        payload: dict[str, Any] = {
            "artifact_id": artifact.artifact_id,
            "kind": artifact.kind,
            "hashes": dict(artifact.files),
            "meta": meta,
        }
        base_version = await self._runtime.self_pipeline.chain.current_version()
        proposal = SelfProposal(
            kind=PatchKind.ARTIFACT,
            payload=payload,
            base_version=base_version,
            rationale="构建产物挂载（内容寻址 + 冒烟门禁 + L2 人工审批）",
            meta={"artifact_id": artifact.artifact_id},
        )
        return await self._runtime.self_pipeline.apply(ctx, proposal, round_id=round_id)

    # ── 容器部署 ──

    async def deploy_to_container(
        self,
        ctx: Any,
        artifact: BuildArtifact,
        env_domain: Any,
        *,
        env_name: str,
        command: str,
        args: tuple[str, ...] = (),
    ) -> dict[str, Any]:
        """产物部署至容器环境（镜像名 = 前缀 + 内容寻址 id，数据形态）。

        三步走：① 容器环境声明经 ENVIRONMENT 补丁链落链（镜像描述 =
        数据，含构建上下文 = 产物目录）；② 提供器 ensure（无 Docker =
        结构化失败 ENV_004，降级不崩溃）；③ 白名单命令在容器内运行。
        容器是隔离边界（重执行件安全落地的通道），部署全链路可回退
        （环境补丁回退 = 声明回退）。
        """
        prefix = str(self._deploy.get("image_prefix") or "inkling/artifact")
        image_name = f"{prefix}:{artifact.artifact_id}"
        payload: dict[str, Any] = {
            "name": env_name,
            "runtime": "container",
            "tools": [command],
            "install_cmds": [],
            "version": artifact.artifact_id,
            "meta": {
                "versioned_by_patch_chain": True,
                "image": {
                    "name": image_name,
                    "build_context": str(self.artifact_dir(artifact)),
                },
                "artifact_id": artifact.artifact_id,
            },
        }
        if self._runtime is None or self._runtime.self_pipeline is None:
            return {"ok": False, "status": "not_assembled", "error": "构建域未装配运行时"}
        base_version = await self._runtime.self_pipeline.chain.current_version()
        outcome = await self._runtime.self_pipeline.apply(
            ctx,
            SelfProposal(
                kind=PatchKind.ENVIRONMENT,
                payload=payload,
                base_version=base_version,
                rationale=f"容器部署产物 {artifact.artifact_id}",
                meta={"artifact_id": artifact.artifact_id},
            ),
        )
        if not outcome.applied:
            return {
                "ok": False,
                "patch_id": outcome.patch_id,
                "status": outcome.status,
                "image_name": image_name,
                "error": outcome.reason or outcome.apply_error,
            }
        handle = await env_domain.ensure(env_name)
        if handle.status != "ready":
            return {
                "ok": False,
                "patch_id": outcome.patch_id,
                "status": "container_unavailable",
                "image_name": image_name,
                "error": handle.error or "容器环境未就绪",
            }
        result = await env_domain.run(env_name, command, args)
        return {
            "ok": result.exit_code == 0,
            "patch_id": outcome.patch_id,
            "status": "deployed" if result.exit_code == 0 else "run_failed",
            "image_name": image_name,
            "exit_code": result.exit_code,
            "output": result.stdout[:500],
            "error": result.stderr[:300] if result.exit_code != 0 else None,
        }


class ArtifactApplyTarget(ApplyTarget):
    """ARTIFACT 补丁落链后的活跃态生效：产物声明工具注册进工具表。

    补丁链是权威记录（重启经链恢复：宿主 boot 从链组装注册声明工具）；
    本钩子只做当前进程的活跃态同步——产物挂载引擎 = 工具表出现新声明。
    """

    name = "inkling.artifact"

    def __init__(self, domain: BuildDomain, runtime: Any) -> None:
        self._domain = domain
        self._runtime = runtime

    async def apply(self, payload: dict[str, Any], patch_id: int) -> None:
        artifact = self._domain.artifacts.get(str(payload.get("artifact_id") or ""))
        if artifact is not None:
            self._domain.artifacts[artifact.artifact_id] = artifact
        tool_data = (payload.get("meta") or {}).get("tool")
        if isinstance(tool_data, dict):
            spec = DeclarativeToolSpec.from_dict(tool_data)
            self._runtime.harness_registry.declarative.register_definition(spec)
            self._runtime.tool_registry[spec.name] = spec.to_spec()
            self._domain.declared_tools[spec.name] = str(payload.get("artifact_id") or "")
        # 组件清单同步：链内组件声明 → data_dir/components/manifest.json
        # （落链已 append，链含本补丁；前端 artifactLoader 注册即插即显）
        try:
            assembled = await self._runtime.self_pipeline.chain.assemble()
            self._domain.sync_component_manifest(assembled.get("artifacts") or {})
        except Exception as exc:
            logger.warning("组件清单同步失败（重启装配经链恢复）: %s", exc)


__all__ = [
    "BUILD_ERROR_FAILED",
    "BUILD_ERROR_SMOKE",
    "BUILD_ERROR_VETTING",
    "BUILD_ERROR_WHITELIST",
    "ArtifactApplyTarget",
    "BuildDomain",
]
