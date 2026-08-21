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
use super::tool_decl::{ToolDeclarations, ParamType, PermissionLevel, Endpoint};

/// 注册表（工具名 → 执行器）
pub struct ExecutorRegistry {
    executors: Vec<Box<dyn Executor>>,
}

impl ExecutorRegistry {
    /// 按名取执行器
    pub fn get(&self, name: &str) -> Option<&dyn Executor> {
        self.executors.iter().find(|e| e.name() == name).map(|e| e.as_ref())
    }

    /// 已注册工具名（inspect_tools 快照面）
    pub fn names(&self) -> Vec<String> {
        self.executors.iter().map(|e| e.name().to_string()).collect()
    }

    /// 执行：查表 → 执行器 run（守卫在 run 内强制）
    pub fn run(
        &self,
        tool: &str,
        args: &BTreeMap<String, Value>,
        backend: &dyn SystemBackend,
        auth: &Authorization,
    ) -> Result<ExecOutcome, ExecError> {
        let executor = self
            .get(tool)
            .ok_or_else(|| ExecError::UnknownTool(tool.to_string()))?;
        executor.run(args, backend, auth)
    }
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
    if declared_params != &executor_params {
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

        registry.executors.push(Box::new(RegisteredExecutor {
            spec: executor_spec,
            run_fn,
        }));
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
        (self.run_fn)(self, args, backend, auth)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
