//! 捆绑运行时的装配准备：资源解包（首启 provision）+ 内嵌解释器定位。
//!
//! 发行形态 = 用户零 Python 前置：嵌入式 Python 运行时（embed 发行包）、
//! 引擎包、种子数据、向量模型、执行件二进制的原始拷贝都随安装包放在
//! 资源目录（Tauri resources）；首次装配时按需解包到运行数据目录
//! （用户可写、路径稳定），此后直接复用（幂等：缺才拷）。
//!
//! 定位规则：
//! - 资源根：`INKLING_RESOURCE_DIR` 环境覆盖（本地模拟/测试用）→
//!   Windows 安装形态 `exe 同目录/resources` → macOS app 形态
//!   `exe 同目录/../Resources`；
//! - 捆绑模式判定：发行构建（release）恒为捆绑；debug 构建可经
//!   `INKLING_BUNDLED=1` 显式开启（在开发机上模拟无仓库环境）。
//!
//! 解释器初始化（捆绑模式）：运行时目录加入 DLL 搜索路径（Windows
//! 的 PATH / macOS 的 DYLD_LIBRARY_PATH）+ `PYTHONHOME` 指向运行时
//! 目录——pyo3 的 auto-initialize 走 `Py_InitializeEx` 时按环境变量
//! 解析路径；embed 发行包的 `python3xx._pth` 使路径解析固定为
//! 「标准库 zip + DLL 同目录」，引擎包路径由装配期注入（宿主侧
//! sys.path 插前），两者互不依赖。

use std::path::{Path, PathBuf};

/// 资源根目录名（Tauri bundle.resources 的落位名；安装形态与 exe 同级）。
pub const RESOURCE_DIR_NAME: &str = "resources";

/// 资源内的运行时目录名（embed 发行包解包形态）。
pub const RUNTIME_DIR_NAME: &str = "python";

/// 资源/数据目录内的引擎包目录名（sys.path 注入目标 = 引擎包外层）。
pub const ENGINE_DIR_NAME: &str = "ink_engine";

/// 数据目录内的种子根目录名（seed_data 与 manifest.json 所在目录）。
pub const SEED_DIR_NAME: &str = "inkling";

/// 数据目录内的模型资产根目录名（随包模型解包落位）。
pub const ASSETS_DIR_NAME: &str = "assets";

/// 模型目录名（granite-97m 内嵌语义检索模型）。
pub const MODEL_DIR_NAME: &str = "granite-97m";

/// 数据目录内的执行件目录名（随包 exec 二进制的解包落位）。
pub const EXEC_DIR_NAME: &str = "exec";

/// 捆绑模式判定：发行构建恒为捆绑；debug 构建经环境变量显式开启
/// （本地模拟无仓库环境时使用）。
pub fn bundled_mode() -> bool {
    cfg!(not(debug_assertions))
        || std::env::var("INKLING_BUNDLED")
            .map(|value| value == "1")
            .unwrap_or(false)
}

/// 资源根定位（env 覆盖 → 安装形态的 exe 邻接目录 → macOS app 形态）。
pub fn resource_root() -> Option<PathBuf> {
    if let Ok(override_dir) = std::env::var("INKLING_RESOURCE_DIR") {
        if !override_dir.is_empty() {
            let dir = PathBuf::from(override_dir);
            if dir.is_dir() {
                return Some(dir);
            }
        }
    }
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let sibling = exe_dir.join(RESOURCE_DIR_NAME);
    if sibling.is_dir() {
        return Some(sibling);
    }
    let mac_app = exe_dir.join("..").join("Resources");
    let mac_app = mac_app.canonicalize().unwrap_or(mac_app);
    if mac_app.is_dir() {
        return Some(mac_app);
    }
    None
}

/// 资源内子目录存在性判定（provision 的取用源；缺目录 = 未打包）。
fn resource_subdir(root: &Path, name: &str) -> Option<PathBuf> {
    let dir = root.join(name);
    dir.is_dir().then_some(dir)
}

/// 数据目录内的运行时目录（bundled 形态的解释器落位）。
pub fn runtime_dir_in(data_dir: &Path) -> PathBuf {
    data_dir.join(RUNTIME_DIR_NAME)
}

/// 数据目录内的模型资产目录（bundled 形态的语义检索模型落位）。
pub fn model_dir_in(data_dir: &Path) -> PathBuf {
    data_dir.join(ASSETS_DIR_NAME).join(MODEL_DIR_NAME)
}

/// 数据目录内的执行件目录（bundled 形态的 exec 二进制落位）。
pub fn exec_dir_in(data_dir: &Path) -> PathBuf {
    data_dir.join(EXEC_DIR_NAME)
}

/// 递归拷贝（缺目标才拷：幂等 provision 语义）。
///
/// 目标已存在（目录或哨兵文件）即跳过——首启之后重复启动零拷贝。
/// 源缺失 = 显式错误（资源未打包 = 安装不完整，不静默跳过）。
fn copy_tree_skip_existing(source: &Path, target: &Path) -> Result<(), String> {
    if !source.is_dir() {
        return Err(format!("资源缺失: {}", source.display()));
    }
    if target.is_dir() {
        return Ok(());
    }
    std::fs::create_dir_all(target)
        .map_err(|err| format!("目录创建失败 {}: {err}", target.display()))?;
    let entries = std::fs::read_dir(source)
        .map_err(|err| format!("资源读取失败 {}: {err}", source.display()))?;
    for entry in entries {
        let entry = entry.map_err(|err| format!("资源条目读取失败: {err}"))?;
        let from = entry.path();
        let to = target.join(entry.file_name());
        let kind = entry
            .file_type()
            .map_err(|err| format!("资源条目类型失败 {}: {err}", from.display()))?;
        if kind.is_dir() {
            copy_tree_skip_existing(&from, &to)?;
        } else if !to.exists() {
            std::fs::copy(&from, &to)
                .map_err(|err| format!("拷贝失败 {} → {}: {err}", from.display(), to.display()))?;
        }
    }
    Ok(())
}

/// 首启解包报告（各分量的落位与来源）。
#[derive(Debug, Clone, Default)]
pub struct ProvisionReport {
    pub runtime_dir: PathBuf,
    pub engine_dir: PathBuf,
    pub seed_dir: PathBuf,
    pub model_dir: PathBuf,
    pub exec_dir: PathBuf,
    pub provisioned: Vec<String>,
}

/// 首启解包：资源目录 → 数据目录（缺才拷，幂等）。
///
/// 解包分量 = 运行时（embed 发行包）/ 引擎包 / 种子根 / 向量模型 /
/// 执行件；种子根与引擎包保持「仓库同名相对布局」，装配期按
/// `data_dir/ink_engine`、`data_dir/inkling` 的既有相对路径解析。
pub fn provision(data_dir: &Path) -> Result<ProvisionReport, String> {
    let root = resource_root().ok_or_else(|| {
        "资源目录不可用（发行包缺 resources/；或经 INKLING_RESOURCE_DIR 指向打包产物）".to_string()
    })?;
    let mut report = ProvisionReport {
        runtime_dir: runtime_dir_in(data_dir),
        engine_dir: data_dir.join(ENGINE_DIR_NAME),
        seed_dir: data_dir.join(SEED_DIR_NAME),
        model_dir: model_dir_in(data_dir),
        exec_dir: exec_dir_in(data_dir),
        provisioned: Vec::new(),
    };
    if let Some(source) = resource_subdir(&root, RUNTIME_DIR_NAME) {
        copy_tree_skip_existing(&source, &report.runtime_dir)?;
        report.provisioned.push(RUNTIME_DIR_NAME.to_string());
    }
    if let Some(source) = resource_subdir(&root, ENGINE_DIR_NAME) {
        copy_tree_skip_existing(&source, &report.engine_dir)?;
        report.provisioned.push(ENGINE_DIR_NAME.to_string());
    }
    if let Some(source) = resource_subdir(&root, SEED_DIR_NAME) {
        copy_tree_skip_existing(&source, &report.seed_dir)?;
        report.provisioned.push(SEED_DIR_NAME.to_string());
    }
    if let Some(source) = resource_subdir(&root, MODEL_DIR_NAME) {
        let target = report.model_dir.clone();
        copy_tree_skip_existing(&source, &target)?;
        report.provisioned.push(MODEL_DIR_NAME.to_string());
    }
    if let Some(source) = resource_subdir(&root, EXEC_DIR_NAME) {
        copy_tree_skip_existing(&source, &report.exec_dir)?;
        report.provisioned.push(EXEC_DIR_NAME.to_string());
    }
    Ok(report)
}

/// 运行时目录完备性校验（哨兵 = 解释器 DLL + 标准库归档）。
fn runtime_ready(runtime_dir: &Path) -> Result<(), String> {
    let entries = std::fs::read_dir(runtime_dir)
        .map_err(|err| format!("运行时目录不可读 {}: {err}", runtime_dir.display()))?;
    let mut has_dll = false;
    let mut has_stdlib = false;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with("python3") && name.ends_with(".dll") {
            has_dll = true;
        }
        if name.starts_with("python3") && name.ends_with(".zip") {
            has_stdlib = true;
        }
        if has_dll && has_stdlib {
            return Ok(());
        }
    }
    Err(format!(
        "运行时不完整（缺 python3xx.dll 或标准库 zip）: {}",
        runtime_dir.display()
    ))
}

/// 标准库归档文件名（python3xx.zip；缺失 = 运行时不完整）。
fn stdlib_zip_name(runtime_dir: &Path) -> Result<String, String> {
    let entries = std::fs::read_dir(runtime_dir)
        .map_err(|err| format!("运行时目录不可读 {}: {err}", runtime_dir.display()))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with("python3") && name.ends_with(".zip") {
            return Ok(name);
        }
    }
    Err(format!(
        "标准库归档缺失（python3xx.zip）: {}",
        runtime_dir.display()
    ))
}

/// 平台 wchar 宽字符串（解释器路径配置的跨平台形态：
/// Windows = UTF-16；macOS/Linux = UTF-32）。
#[cfg(windows)]
fn wide_string(text: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(text)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(not(windows))]
fn wide_string(text: &str) -> Vec<i32> {
    text.chars().map(|c| c as i32).chain(std::iter::once(0)).collect()
}

/// 内嵌解释器初始化（自定义 PyConfig）：发行形态的确定性路径解析。
///
/// 环境变量途径（PYTHONHOME）在此不可靠——壳进程经 Rust 改写进程
/// 环境块，而 CPython 的 getenv 走 CRT 缓存，两者不同步；且环境残留
/// （开发机上的 PYTHONPATH 等）会污染发行环境。因此路径全部显式
/// 声明：home = 运行时目录，module_search_paths = 标准库 zip + 运行
/// 时目录（引擎包路径由装配期注入，见宿主 boot）。use_environment=0
/// 后 PYTHON* 环境一律不参与，行为与安装环境解耦。
///
/// 幂等：解释器已初始化（开发形态或二次准备）直接跳过。
fn init_embedded_interpreter(runtime_dir: &Path) -> Result<(), String> {
    unsafe {
        use pyo3::ffi::{
            PyConfig, PyConfig_Clear, PyConfig_InitPythonConfig, PyConfig_SetString,
            PyStatus_IsError, Py_InitializeFromConfig, PyWideStringList_Append,
        };
        if pyo3::ffi::Py_IsInitialized() != 0 {
            return Ok(());
        }
        let zip_name = stdlib_zip_name(runtime_dir)?;
        let mut config: PyConfig = std::mem::zeroed();
        PyConfig_InitPythonConfig(&mut config);
        config.use_environment = 0;
        // site 处理开启：随包第三方依赖的 .pth 引导（pywin32 等按
        // 标准 site-packages 布局安装的包依赖 .pth 运行期引导）
        config.site_import = 1;

        let home = wide_string(&runtime_dir.to_string_lossy());
        let status = PyConfig_SetString(&mut config, &mut config.home, home.as_ptr());
        if PyStatus_IsError(status) != 0 {
            PyConfig_Clear(&mut config);
            return Err("解释器 home 设置失败".to_string());
        }
        let zip_path = wide_string(&runtime_dir.join(&zip_name).to_string_lossy());
        config.module_search_paths_set = 1;
        let status =
            PyWideStringList_Append(&mut config.module_search_paths, zip_path.as_ptr());
        if PyStatus_IsError(status) != 0 {
            PyConfig_Clear(&mut config);
            return Err("解释器标准库路径追加失败".to_string());
        }
        let status = PyWideStringList_Append(&mut config.module_search_paths, home.as_ptr());
        if PyStatus_IsError(status) != 0 {
            PyConfig_Clear(&mut config);
            return Err("解释器运行目录路径追加失败".to_string());
        }
        // 出厂第三方依赖（pip install --target 落位的随包 site-packages；
        // site_import=0 下不自动进 sys.path，此处显式挂载）
        let site_packages = runtime_dir.join("Lib").join("site-packages");
        if site_packages.is_dir() {
            let site_text = wide_string(&site_packages.to_string_lossy());
            let status =
                PyWideStringList_Append(&mut config.module_search_paths, site_text.as_ptr());
            if PyStatus_IsError(status) != 0 {
                PyConfig_Clear(&mut config);
                return Err("解释器站点包路径追加失败".to_string());
            }
        }
        let status = Py_InitializeFromConfig(&mut config);
        PyConfig_Clear(&mut config);
        if PyStatus_IsError(status) != 0 {
            return Err("内嵌解释器初始化失败".to_string());
        }
    }
    Ok(())
}

/// 捆绑模式解释器准备：运行时目录入搜索路径 + 自定义初始化。
///
/// 必须在任何 Python API 触碰之前调用（pyo3 auto-initialize 首次
/// attach 即执行初始化——已初始化的解释器会被 pyo3 跳过，本函数
/// 先行完成确定性路径配置）。平台差异：Windows 的 DLL 搜索走 PATH；
/// macOS 走 DYLD_LIBRARY_PATH（Linux 预留 LD_LIBRARY_PATH 后续档）。
pub fn prepare_bundled_python(data_dir: &Path) -> Result<(), String> {
    let runtime_dir = runtime_dir_in(data_dir);
    runtime_ready(&runtime_dir)?;
    let runtime_text = runtime_dir.to_string_lossy().into_owned();
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let search_env = "PATH".to_string();
    #[cfg(target_os = "macos")]
    let search_env = "DYLD_LIBRARY_PATH".to_string();
    #[cfg(target_os = "linux")]
    let search_env = "LD_LIBRARY_PATH".to_string();
    let existing = std::env::var(&search_env).unwrap_or_default();
    if !existing.split(';').any(|part| part == runtime_text) {
        let joined = if existing.is_empty() {
            runtime_text.clone()
        } else {
            format!("{runtime_text};{existing}")
        };
        std::env::set_var(&search_env, joined);
    }
    init_embedded_interpreter(&runtime_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 环境变量互斥（多个测试改写同一 INK_* 环境键，须串行）。
    static ENV_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct Scratch(PathBuf);
    impl Scratch {
        fn new(label: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "inkling-runtime-{label}-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn touch(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"x").unwrap();
    }

    #[test]
    fn provision_copies_missing_components_and_is_idempotent() {
        let _env = ENV_GUARD.lock().unwrap();
        let ws = Scratch::new("provision");
        let resources = ws.0.join("resources");
        touch(&resources.join("python/python314.dll"));
        touch(&resources.join("python/python314.zip"));
        touch(&resources.join("ink_engine/ink_engine/__init__.py"));
        touch(&resources.join("inkling/manifest.json"));
        touch(&resources.join("inkling/seed_data/tools.json"));
        touch(&resources.join("granite-97m/config.json"));
        touch(&resources.join("exec/inkling_exec.exe"));
        std::env::set_var("INKLING_RESOURCE_DIR", resources.to_string_lossy().into_owned());

        let data_dir = ws.0.join("data");
        let report = provision(&data_dir).expect("解包成功");
        assert!(report.runtime_dir.join("python314.dll").is_file());
        assert!(report.engine_dir.join("ink_engine/__init__.py").is_file());
        assert!(report.seed_dir.join("seed_data/tools.json").is_file());
        assert!(report.model_dir.join("config.json").is_file());
        assert!(report.exec_dir.join("inkling_exec.exe").is_file());
        assert_eq!(report.provisioned.len(), 5, "五个分量全解包");

        let report2 = provision(&data_dir).expect("二次解包成功");
        assert!(report2.provisioned.len() == 5, "幂等：分量缺才拷");
        std::env::remove_var("INKLING_RESOURCE_DIR");
    }

    /// 资源根解析：环境覆盖优先于 exe 邻接目录（发行形态 = 安装目录
    /// resources；本机 debug 构建期 tauri 也会向 target 拷贝一份）。
    #[test]
    fn resource_root_env_override_wins_over_exe_fallback() {
        let _env = ENV_GUARD.lock().unwrap();
        let ws = Scratch::new("rootenv");
        let resources = ws.0.join("resources");
        touch(&resources.join("python/python314.dll"));
        std::env::set_var("INKLING_RESOURCE_DIR", resources.to_string_lossy().into_owned());
        let root = resource_root().expect("环境覆盖应命中");
        assert_eq!(root, resources, "环境覆盖优先于 exe 邻接目录");
        std::env::remove_var("INKLING_RESOURCE_DIR");
    }

    #[test]
    fn provision_skips_absent_optional_components() {
        let _env = ENV_GUARD.lock().unwrap();
        let ws = Scratch::new("partial");
        let resources = ws.0.join("resources");
        touch(&resources.join("python/python314.dll"));
        touch(&resources.join("python/python314.zip"));
        touch(&resources.join("ink_engine/ink_engine/__init__.py"));
        touch(&resources.join("inkling/manifest.json"));
        std::env::set_var("INKLING_RESOURCE_DIR", resources.to_string_lossy().into_owned());
        let data_dir = ws.0.join("data");
        let report = provision(&data_dir).expect("部分资源解包成功");
        assert!(
            !report.provisioned.contains(&"granite-97m".to_string()),
            "缺模型的资源不报错（随包分量缺失可降级）"
        );
        std::env::remove_var("INKLING_RESOURCE_DIR");
    }

    #[test]
    fn runtime_ready_validates_sentinel_files() {
        let ws = Scratch::new("ready");
        let dir = ws.0.join("rt");
        std::fs::create_dir_all(&dir).unwrap();
        assert!(runtime_ready(&dir).is_err(), "空目录不通过");
        std::fs::write(dir.join("python314.dll"), b"MZ").unwrap();
        assert!(runtime_ready(&dir).is_err(), "缺标准库不通过");
        std::fs::write(dir.join("python314.zip"), b"PK").unwrap();
        assert!(runtime_ready(&dir).is_ok(), "DLL + 标准库齐备通过");
    }

    #[test]
    fn bundled_mode_env_override_works_in_debug() {
        let _env = ENV_GUARD.lock().unwrap();
        std::env::set_var("INKLING_BUNDLED", "1");
        assert!(bundled_mode(), "显式开启生效");
        std::env::set_var("INKLING_BUNDLED", "0");
        assert!(!bundled_mode() || cfg!(not(debug_assertions)), "显式关闭生效");
        std::env::remove_var("INKLING_BUNDLED");
    }
}
