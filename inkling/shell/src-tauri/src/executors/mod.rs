//! 执行器模块：声明驱动注册 + 权限/沙箱守卫 + 系统操作后端。

pub mod backends;
pub mod headless;
pub mod impls;
pub mod registry;
pub mod tool_decl;

pub use backends::{PlatformBackend, SystemBackend};
pub use headless::{build_headless_registry, register_headless_os_dispatch};
pub use impls::{Authorization, ExecError, ExecOutcome, Executor, ExecutorSpec, ParamSpec};
pub use registry::{CallGate, ExecutorRegistry, build_registry_from_declarations};
pub use tool_decl::{
    Endpoint, ParamType, PermissionLevel, SandboxRule, ToolDecl, ToolDeclarations,
    load_tool_declarations,
};
