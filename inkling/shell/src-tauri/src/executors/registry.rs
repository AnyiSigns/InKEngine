//! 执行器注册表：声明驱动注册 + 签名一致性校验（禁硬编码漂移）。
//!
//! 注册流程：声明（fixtures/tools_os.json，数据资产）→ 逐条校验
//! 「声明 params/permission/endpoint/sandbox ↔ 执行器侧签名契约」一致 →
//! 一致才注册；任一不一致或声明引用未实现执行器 = 注册失败（fail-closed，
//! 壳拒绝启动——声明与执行器漂移必须在启动即暴露，不静默降级）。

use std::collections::BTreeMap;

use serde_json::Value;

use super::backends::SystemBackend;
use super::impls::{Authorization, ExecError, ExecOutcome, Executor, ExecutorSpec, executor_impl};
use super::tool_decl::{ToolDeclarations, ParamType, PermissionLevel, Endpoint, SandboxRule};

/// 注册表（工具名 → 执行器）
pub struct ExecutorRegistry {
    executors: Vec<RegisteredExecutor>,
}

/// 调用闸门（L7 端点隔离 + L4 动态挂载根）：命令面到注册表的
/// （端点, 动态根）载体——端点校验在注册表层强制（process_exec 端点
/// 不可调 device_mcp 工具，反之亦然）；动态挂载根并入路径根沙箱裁决。
#[derive(Debug, Clone)]
pub struct CallGate {
    pub endpoint: Endpoint,
    pub dynamic_roots: Vec<String>,
}

impl CallGate {
    pub fn new(endpoint: Endpoint) -> Self {
        Self { endpoint, dynamic_roots: Vec::new() }
    }

    pub fn with_roots(endpoint: Endpoint, dynamic_roots: Vec<String>) -> Self {
        Self { endpoint, dynamic_roots }
    }
}

impl ExecutorRegistry {
    /// 按名取执行器
    pub fn get(&self, name: &str) -> Option<&dyn Executor> {
        self.executors.iter().find(|e| e.spec.name == name).map(|e| e as &dyn Executor)
    }

    /// 已注册工具名（inspect_tools 快照面）
    pub fn names(&self) -> Vec<String> {
        self.executors.iter().map(|e| e.spec.name.to_string()).collect()
    }

    /// 执行：查表 → 端点隔离校验（L7）→ 动态挂载根并入路径根沙箱（L4）
    /// → 执行器 run（权限/沙箱守卫在 run 内强制）。
    ///
    /// 端点校验在注册表层强制：调用闸门端点与工具声明端点不一致 =
    /// 沙箱级拒绝（端点隔离是命令面的最后一层防线，禁被绕行）。
    pub fn run(
        &self,
        tool: &str,
        args: &BTreeMap<String, Value>,
        backend: &dyn SystemBackend,
        auth: &Authorization,
        gate: &CallGate,
    ) -> Result<ExecOutcome, ExecError> {
        let registered = self
            .find(tool)
            .ok_or_else(|| ExecError::UnknownTool(tool.to_string()))?;
        if registered.spec.endpoint != gate.endpoint {
            return Err(ExecError::SandboxViolation(format!(
                "端点隔离拒绝: 工具 {tool} 声明端点 {:?}，调用端点 {:?}",
                registered.spec.endpoint, gate.endpoint
            )));
        }
        // L4（决议 14）：授权挂载点并入路径根沙箱——路径根工具按「声明根 +
        // 动态挂载根」裁决；非路径根工具（命令白名单/边界/模板）不受影响。
        if !gate.dynamic_roots.is_empty() {
            if let Some(merged) = merge_dynamic_roots(&registered.spec, &gate.dynamic_roots) {
                return registered.run_view(&merged, args, backend, auth);
            }
        }
        registered.run(args, backend, auth)
    }

    fn find(&self, name: &str) -> Option<&RegisteredExecutor> {
        self.executors.iter().find(|e| e.spec.name == name)
    }
}

/// 把动态挂载根并入 PathRoots 沙箱（仅路径根形态；无动态根/非路径根 = None）。
fn merge_dynamic_roots(
    spec: &ExecutorSpec,
    dynamic_roots: &[String],
) -> Option<ExecutorSpec> {
    let SandboxRule::PathRoots { roots } = &spec.sandbox else {
        return None;
    };
    let mut merged = roots.clone();
    let mut changed = false;
    for root in dynamic_roots {
        if !merged.iter().any(|r| r == root) {
            merged.push(root.clone());
            changed = true;
        }
    }
    if !changed {
        return None;
    }
    let mut merged_spec = spec.clone();
    merged_spec.sandbox = SandboxRule::PathRoots { roots: merged };
    Some(merged_spec)
}

/// 签名一致性校验（声明 ↔ 执行器）：逐项比对，返回首处不一致描述
fn validate_signature(declared_name: &str, declared_params: &[(String, ParamType, bool)], executor: &ExecutorSpec) -> Result<(), String> {
    if declared_name != executor.name {
        return Err(format!(
            "声明名 {declared_name} ≠ 执行器名 {}",
            executor.name
        ));
    }
    let executor_params: Vec<(String, ParamType, bool)> = executor
        .params
        .iter()
        .map(|p| (p.name.to_string(), p.param_type, p.required))
        .collect();
    if declared_params != executor_params {
        return Err(format!(
            "参数签名不一致: 声明 {declared_params:?} ≠ 执行器 {executor_params:?}（工具 {declared_name}）"
        ));
    }
    Ok(())
}

fn validate_permission_endpoint(
    declared_permission: PermissionLevel,
    declared_endpoint: Endpoint,
    executor: &ExecutorSpec,
    tool: &str,
) -> Result<(), String> {
    if declared_permission != executor.permission {
        return Err(format!(
            "权限声明不一致: 声明 {declared_permission:?} ≠ 执行器 {:?}（工具 {tool}）",
            executor.permission
        ));
    }
    if declared_endpoint != executor.endpoint {
        return Err(format!(
            "端点声明不一致: 声明 {declared_endpoint:?} ≠ 执行器 {:?}（工具 {tool}）",
            executor.endpoint
        ));
    }
    Ok(())
}

fn validate_sandbox(
    declared_sandbox: &super::tool_decl::SandboxRule,
    executor: &ExecutorSpec,
    tool: &str,
) -> Result<(), String> {
    // 沙箱模式必须一致（规则值以声明为准——执行器侧守卫按声明值执行，
    // 实现侧仅承载结构；数值/清单内容比对由声明为单一事实源）
    let declared_mode = std::mem::discriminant(declared_sandbox);
    let executor_mode = std::mem::discriminant(&executor.sandbox);
    if declared_mode != executor_mode {
        return Err(format!(
            "沙箱模式不一致: 声明 {:?} ≠ 执行器 {:?}（工具 {tool}）",
            declared_sandbox, executor.sandbox
        ));
    }
    Ok(())
}

/// 声明驱动注册：校验通过才注册；任一失败返回全部错误（fail-closed）
pub fn build_registry_from_declarations(declarations: &ToolDeclarations) -> Result<ExecutorRegistry, String> {
    let mut registry = ExecutorRegistry { executors: Vec::new() };
    let mut errors: Vec<String> = Vec::new();

    for declaration in &declarations.tools {
        let declared_params: Vec<(String, ParamType, bool)> = declaration
            .params
            .iter()
            .map(|p| (p.name.clone(), p.param_type, p.required))
            .collect();

        let Some((executor_spec, run_fn)) = executor_impl(&declaration.name) else {
            errors.push(format!(
                "声明引用未实现执行器: {}（禁硬编码——要么补实现，要么声明不落注册表）",
                declaration.name
            ));
            continue;
        };

        if let Err(error) = validate_signature(&declaration.name, &declared_params, &executor_spec) {
            errors.push(error);
            continue;
        }
        if let Err(error) = validate_permission_endpoint(declaration.permission, declaration.endpoint, &executor_spec, &declaration.name) {
            errors.push(error);
            continue;
        }
        if let Err(error) = validate_sandbox(&declaration.sandbox, &executor_spec, &declaration.name) {
            errors.push(error);
            continue;
        }

        registry.executors.push(RegisteredExecutor {
            spec: executor_spec,
            run_fn,
        });
    }

    if !errors.is_empty() {
        return Err(errors.join("\n"));
    }
    Ok(registry)
}

/// 注册态执行器：签名契约 + 运行体
struct RegisteredExecutor {
    spec: ExecutorSpec,
    run_fn: super::impls::RunFn,
}

impl RegisteredExecutor {
    fn run(
        &self,
        args: &BTreeMap<String, Value>,
        backend: &dyn SystemBackend,
        auth: &Authorization,
    ) -> Result<ExecOutcome, ExecError> {
        (self.run_fn)(self, args, backend, auth)
    }

    /// 以替换签名（动态挂载根并入后的 PathRoots）运行同一运行体：
    /// 运行体只读 name/spec，spec 换成合并态即完成动态根生效（L4）。
    fn run_view(
        &self,
        spec: &ExecutorSpec,
        args: &BTreeMap<String, Value>,
        backend: &dyn SystemBackend,
        auth: &Authorization,
    ) -> Result<ExecOutcome, ExecError> {
        let view = SpecView { spec: spec.clone() };
        (self.run_fn)(&view, args, backend, auth)
    }
}

impl Executor for RegisteredExecutor {
    fn name(&self) -> &str {
        self.spec.name
    }

    fn spec(&self) -> &ExecutorSpec {
        &self.spec
    }

    fn run(
        &self,
        args: &BTreeMap<String, Value>,
        backend: &dyn SystemBackend,
        auth: &Authorization,
    ) -> Result<ExecOutcome, ExecError> {
        RegisteredExecutor::run(self, args, backend, auth)
    }
}

/// 签名承载视图（动态挂载根合并态的只读 spec 载体；不参与 run 分发）。
struct SpecView {
    spec: ExecutorSpec,
}

impl Executor for SpecView {
    fn name(&self) -> &str {
        self.spec.name
    }

    fn spec(&self) -> &ExecutorSpec {
        &self.spec
    }

    fn run(
        &self,
        _args: &BTreeMap<String, Value>,
        _backend: &dyn SystemBackend,
        _auth: &Authorization,
    ) -> Result<ExecOutcome, ExecError> {
        unreachable!("SpecView 仅承载合并签名，不参与 run 分发")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::executors::load_tool_declarations;

    fn params_of(decl: &super::super::tool_decl::ToolDecl) -> Vec<(String, ParamType, bool)> {
        decl.params.iter().map(|p| (p.name.clone(), p.param_type, p.required)).collect()
    }

    #[test]
    fn signature_check_rejects_param_mismatch() {
        let decl = super::super::tool_decl::ToolDecl {
            name: "launch_app".into(),
            description: String::new(),
            permission: PermissionLevel::Review,
            endpoint: Endpoint::ProcessExec,
            sandbox: super::super::tool_decl::SandboxRule::CommandAllowlist {
                allowlist: vec!["notepad".into()],
            },
            params: vec![
                super::super::tool_decl::ParamDecl {
                    name: "app".into(),
                    param_type: ParamType::String,
                    required: true,
                },
                // 声明多出参数 → 签名不一致
                super::super::tool_decl::ParamDecl {
                    name: "extra".into(),
                    param_type: ParamType::String,
                    required: false,
                },
            ],
        };
        let result = validate_signature(
            &decl.name,
            &params_of(&decl),
            &super::super::impls::executor_impl("launch_app").unwrap().0,
        );
        assert!(result.is_err());
    }

    #[test]
    fn fixture_declarations_match_executor_signatures() {
        // 运行期夹具（tools_os.json）声明须与执行器签名逐项一致，任一
        // 漂移 = 注册失败；此处断言新增 UI 工具全部可成功注册。
        let declarations = load_tool_declarations(include_str!("../../fixtures/tools_os.json"))
            .expect("夹具须可解析");
        let registry = build_registry_from_declarations(&declarations);
        let names = match registry {
            Ok(reg) => reg.names(),
            Err(err) => panic!("注册失败: {err}"),
        };
        for name in [
            "ui_query",
            "ui_click",
            "ui_type",
            "window_focus",
            "window_minimize",
            "shell_exec",
        ] {
            assert!(names.iter().any(|n| n == name), "夹具未注册工具: {name}");
        }
    }

    fn args(pairs: &[(&str, serde_json::Value)]) -> BTreeMap<String, serde_json::Value> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
    }

    /// L7：process_exec 端点不可调 device_mcp 工具（端点隔离在注册表强制）。
    #[test]
    fn process_exec_gate_rejects_device_mcp_tools() {
        let declarations = load_tool_declarations(include_str!("../../fixtures/tools_os.json"))
            .expect("夹具须可解析");
        let registry = build_registry_from_declarations(&declarations).expect("注册须成功");
        let backend = crate::executors::backends::MockBackend::new();
        let auth = Authorization { approved: true };
        let call = args(&[("target", "tree".into())]);
        let err = registry
            .run("ui_query", &call, &backend, &auth, &CallGate::new(Endpoint::ProcessExec))
            .unwrap_err();
        assert!(
            matches!(err, ExecError::SandboxViolation(_)),
            "device_mcp 工具经 process_exec 端点必须被拒: {err}"
        );
        assert!(backend.calls.lock().unwrap().is_empty(), "隔离拒绝不得触达后端");
    }

    /// L7：device_mcp 端点不可调 process_exec 工具（双向隔离）。
    #[test]
    fn device_gate_rejects_process_exec_tools() {
        let declarations = load_tool_declarations(include_str!("../../fixtures/tools_os.json"))
            .expect("夹具须可解析");
        let registry = build_registry_from_declarations(&declarations).expect("注册须成功");
        let backend = crate::executors::backends::MockBackend::new();
        let auth = Authorization { approved: true };
        let call = args(&[("app", "notepad".into())]);
        let err = registry
            .run("launch_app", &call, &backend, &auth, &CallGate::new(Endpoint::DeviceMcp))
            .unwrap_err();
        assert!(
            matches!(err, ExecError::SandboxViolation(_)),
            "process_exec 工具经 device 端点必须被拒: {err}"
        );
    }

    /// L4：动态挂载根并入路径根沙箱——挂载点内路径放行、声明根内路径照常、
    /// 两者之外的路径仍拒绝（决议 14：授权挂载点成为文件沙箱的动态根）。
    #[test]
    fn dynamic_mount_roots_merged_into_path_roots() {
        let declarations = load_tool_declarations(include_str!("../../fixtures/tools_os.json"))
            .expect("夹具须可解析");
        let registry = build_registry_from_declarations(&declarations).expect("注册须成功");
        let backend = crate::executors::backends::MockBackend::new();
        let auth = Authorization { approved: true };

        let mount = std::env::temp_dir()
            .join(format!("inkling-mount-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&mount).expect("挂载目录创建失败");
        let inside = mount.join("a.txt").to_string_lossy().into_owned();
        std::fs::write(mount.join("a.txt"), "x").unwrap();

        let gate = CallGate::with_roots(Endpoint::ProcessExec, vec![mount.to_string_lossy().into_owned()]);

        // 挂载点内路径放行（动态根生效）
        let call = args(&[("path", inside.clone().into())]);
        let outcome = registry.run("open_file", &call, &backend, &auth, &gate).expect("动态根内应放行");
        assert!(outcome.result.contains("a.txt"), "{}", outcome.result);

        // 无动态根时同一路径仍被拒（挂载点未授权 = 沙箱外）
        let call = args(&[("path", inside.into())]);
        let err = registry
            .run("open_file", &call, &backend, &auth, &CallGate::new(Endpoint::ProcessExec))
            .unwrap_err();
        assert!(matches!(err, ExecError::SandboxViolation(_)), "未挂载路径必须拒绝: {err}");

        let _ = std::fs::remove_dir_all(&mount);
    }
}
