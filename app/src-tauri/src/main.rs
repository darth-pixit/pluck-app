// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Capture panics into a local log file under the platform temp dir so we
    // can surface them on next launch (and so they aren't silently swallowed
    // by the windows_subsystem = "windows" attribute on release builds).
    // Home-directory paths are scrubbed to `~` to avoid leaking usernames.
    std::panic::set_hook(Box::new(|info| {
        let mut msg = format!("[pluks panic] {}\n", info);
        if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
            if let Some(h) = home.to_str() {
                msg = msg.replace(h, "~");
            }
        }
        eprintln!("{}", msg);
        let path = std::env::temp_dir().join("pluks-panic.log");
        let _ = std::fs::write(path, msg);
    }));

    app_lib::run()
}
