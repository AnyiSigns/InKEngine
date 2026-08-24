#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 出厂自检入口（全新机器路径验收）：不拉起 Tauri 界面，直接走
    // 资源解包 → 内嵌解释器 → 装配 → 回合 → 持久/导出/执行件断言。
    if std::env::args().any(|arg| arg == "--selftest") {
        std::process::exit(inkling_shell_lib::selftest());
    }
    inkling_shell_lib::run()
}
