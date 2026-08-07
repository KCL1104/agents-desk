#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod core;
mod hooks;
mod pty;
mod shell_env;
mod store;

use ::core::result::Result as StdResult;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;

use crate::core::{Core, SessionMeta, UiSink};

/// Bridges the transport-agnostic core onto Tauri. Most events go straight to
/// the webview; `notify` is handled natively because the OS is the right
/// renderer for a desktop notification.
struct TauriSink(AppHandle);

impl UiSink for TauriSink {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        if event == "notify" {
            let title = payload["title"].as_str().unwrap_or("AgentDesk");
            let body = payload["body"].as_str().unwrap_or_default();
            if let Err(e) = self.0.notification().builder().title(title).body(body).show() {
                eprintln!("[tauri] notification failed: {e}");
            }
        }
        if let Err(e) = self.0.emit(event, payload) {
            eprintln!("[tauri] emit {event} failed: {e}");
        }
    }
}

#[derive(Default)]
struct AppState {
    core: Mutex<Option<Arc<Core>>>,
    boot_error: Mutex<Option<String>>,
}

impl AppState {
    fn core(&self) -> StdResult<Arc<Core>, String> {
        self.core
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| match self.boot_error.lock().unwrap().clone() {
                Some(e) => format!("AgentDesk failed to start: {e}"),
                None => "AgentDesk is still starting up.".to_string(),
            })
    }
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

#[tauri::command]
fn boot_status(state: State<'_, AppState>) -> serde_json::Value {
    let core = state.core.lock().unwrap().clone();
    match core {
        Some(c) => serde_json::json!({
            "ready": true,
            "shell": c.env.shell,
            "envResolved": c.env.resolved,
            "envVarCount": c.env.vars.len(),
            "path": c.env.path(),
            "claude": c.env.which("claude").map(|p| p.to_string_lossy().to_string()),
            "db": store::default_path().to_string_lossy(),
            "hookUrl": c.hook_url(),
        }),
        None => serde_json::json!({
            "ready": false,
            "error": state.boot_error.lock().unwrap().clone(),
        }),
    }
}

#[tauri::command]
fn new_session(
    state: State<'_, AppState>,
    cwd: String,
    agent: Option<String>,
    args: Option<Vec<String>>,
    cols: u16,
    rows: u16,
) -> StdResult<String, String> {
    state
        .core()?
        .new_session(
            cwd,
            agent.unwrap_or_else(|| "claude".into()),
            args.unwrap_or_default(),
            cols,
            rows,
        )
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn reopen_session(
    state: State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> StdResult<(), String> {
    state
        .core()?
        .reopen_session(&id, cols, rows)
        .map_err(|e| e.to_string())
}

/// Keystrokes from xterm.js, forwarded to the PTY verbatim.
#[tauri::command]
fn term_write(state: State<'_, AppState>, id: String, data: String) -> StdResult<(), String> {
    state.core()?.write(&id, &data).map_err(|e| e.to_string())
}

#[tauri::command]
fn term_resize(
    state: State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> StdResult<(), String> {
    state
        .core()?
        .resize(&id, cols, rows)
        .map_err(|e| e.to_string())
}

/// Replay buffer for a pane that is mounting after its PTY already started.
#[tauri::command]
fn term_snapshot(state: State<'_, AppState>, id: String) -> StdResult<serde_json::Value, String> {
    let (data, seq) = state.core()?.snapshot(&id).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "data": data, "seq": seq }))
}

#[tauri::command]
fn close_session(state: State<'_, AppState>, id: String) -> StdResult<(), String> {
    state.core()?.close_session(&id).map_err(|e| e.to_string())
}

/// Mark a session done, or undo it. See `Core::set_completed`.
#[tauri::command]
fn set_completed(state: State<'_, AppState>, id: String, completed: bool) -> StdResult<(), String> {
    state
        .core()?
        .set_completed(&id, completed)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn archive_session(state: State<'_, AppState>, id: String) -> StdResult<(), String> {
    state.core()?.archive_session(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_tabs(state: State<'_, AppState>) -> StdResult<Vec<store::StoredTab>, String> {
    Ok(state.core()?.tabs())
}

#[tauri::command]
fn create_tab(state: State<'_, AppState>, name: String) -> StdResult<String, String> {
    state.core()?.create_tab(name).map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_tab(state: State<'_, AppState>, id: String, name: String) -> StdResult<(), String> {
    state.core()?.rename_tab(&id, name).map_err(|e| e.to_string())
}

#[tauri::command]
fn close_tab(state: State<'_, AppState>, id: String) -> StdResult<(), String> {
    state.core()?.close_tab(&id).map_err(|e| e.to_string())
}

/// Set a tab's layout and slot assignment. Claiming a session here removes it
/// from any other tab — see `Core::update_tab`.
#[tauri::command]
fn update_tab(
    state: State<'_, AppState>,
    id: String,
    layout: String,
    slots: Vec<Option<String>>,
) -> StdResult<(), String> {
    state
        .core()?
        .update_tab(&id, layout, slots)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn list_sessions(state: State<'_, AppState>) -> StdResult<Vec<SessionMeta>, String> {
    Ok(state.core()?.sessions())
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let sink: Arc<dyn UiSink> = Arc::new(TauriSink(handle.clone()));
                let state = handle.state::<AppState>();
                let data_dir = store::default_path()
                    .parent()
                    .map(|p| p.to_path_buf())
                    .unwrap_or_else(std::env::temp_dir);
                match Core::start(sink, store::default_path(), data_dir).await {
                    Ok(core) => {
                        *state.core.lock().unwrap() = Some(core);
                        let _ = handle.emit("core:ready", serde_json::json!({}));
                        eprintln!("[main] core ready");
                    }
                    Err(e) => {
                        let msg = format!("{e:#}");
                        eprintln!("[main] core failed to start: {msg}");
                        *state.boot_error.lock().unwrap() = Some(msg.clone());
                        let _ = handle.emit("core:failed", serde_json::json!({ "error": msg }));
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            boot_status,
            new_session,
            reopen_session,
            term_write,
            term_resize,
            term_snapshot,
            close_session,
            archive_session,
            set_completed,
            list_sessions,
            list_tabs,
            create_tab,
            rename_tab,
            close_tab,
            update_tab,
        ])
        .build(tauri::generate_context!())
        .expect("error while building AgentDesk")
        .run(|handle, event| {
            // Kill child terminals on quit rather than leaving orphaned
            // `claude` processes behind.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(core) = handle.state::<AppState>().core.lock().unwrap().clone() {
                    core.shutdown();
                }
            }
        });
}
