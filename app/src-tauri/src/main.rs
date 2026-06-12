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
        // Persist BEFORE printing, and never use eprintln! here: it panics if
        // the stderr write fails (e.g. stderr is a pipe whose reader died), a
        // panic inside the hook aborts the process, and the log below would
        // never be written — exactly how the Windows smoke harness lost its
        // first capture-stall post-mortem.
        let path = std::env::temp_dir().join("pluks-panic.log");
        let _ = std::fs::write(path, &msg);
        use std::io::Write as _;
        let _ = writeln!(std::io::stderr(), "{}", msg);
    }));

    app_lib::run()
}
