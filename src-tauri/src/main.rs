#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod core;
mod host;
mod hooks;
mod i18n;
mod pty;
mod shell_env;
mod prompt;
mod store;
mod worktree;

use ::core::result::Result as StdResult;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;

use crate::core::{Core, SessionMeta, UiSink};

/// Whether the main window has the user's eyes. One window, one flag; written
/// by the window-event handler, read on the notification path.
static FOCUSED: AtomicBool = AtomicBool::new(true);

/// Bridges the transport-agnostic core onto Tauri. Most events go straight to
/// the webview; `notify` and `badge` are handled natively because the OS is
/// the right renderer for both — they are exactly the signals that must reach
/// someone who is not looking at the app.
struct TauriSink(AppHandle);

impl UiSink for TauriSink {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        if event == "notify" {
            // Only when the window is unfocused: with the app in front of
            // you, the in-app banner already says it, and an OS notification
            // on top would just be an echo.
            if !FOCUSED.load(Ordering::Relaxed) {
                let title = payload["title"].as_str().unwrap_or("AgentDesk");
                let body = payload["body"].as_str().unwrap_or_default();
                if let Err(e) = self.0.notification().builder().title(title).body(body).show() {
                    eprintln!("[tauri] notification failed: {e}");
                }
            }
        }
        if event == "badge" {
            // The dock/taskbar wears the waiting count, so "how many agents
            // need me" survives minimising the window. macOS and Unity
            // launchers render it; elsewhere the call is a harmless no-op.
            let count = payload["count"].as_i64().unwrap_or(0);
            let app = self.0.clone();
            let run = self.0.run_on_main_thread(move || {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.set_badge_count((count > 0).then_some(count));
                }
            });
            if let Err(e) = run {
                eprintln!("[tauri] badge update failed: {e}");
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
fn set_locale(state: State<'_, AppState>, locale: String) -> StdResult<(), String> {
    // Best-effort: the language is a display preference, so a call that lands
    // before the core is up is not worth surfacing as an error to the webview.
    if let Ok(core) = state.core() {
        core.locale.set(i18n::Locale::parse(&locale));
    }
    Ok(())
}

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
            "claudeVersion": c.claude_version(),
            // Whether this desk's claude sessions can name themselves and,
            // with that, message each other across cards.
            "messaging": c.named_sessions(),
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

/* ----------------------------- board ------------------------------- */

#[tauri::command]
fn list_tasks(state: State<'_, AppState>) -> StdResult<Vec<crate::core::TaskView>, String> {
    Ok(state.core()?.task_board())
}

#[tauri::command]
fn create_task(
    state: State<'_, AppState>,
    title: String,
    prompt: String,
    repo_path: String,
    base_branch: String,
) -> StdResult<String, String> {
    state
        .core()?
        .create_task(title, prompt, repo_path, base_branch)
        .map_err(|e| format!("{e:#}"))
}

/// Move a card between columns, or reorder it within one. Only a drag calls
/// this — see `Core::move_task`.
#[tauri::command]
fn move_task(
    state: State<'_, AppState>,
    id: String,
    lifecycle: String,
    position: i64,
) -> StdResult<(), String> {
    let lifecycle = store::Lifecycle::parse(&lifecycle)
        .ok_or_else(|| format!("unknown lifecycle: {lifecycle}"))?;
    state
        .core()?
        .move_task(&id, lifecycle, position)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_task(state: State<'_, AppState>, id: String) -> StdResult<(), String> {
    state.core()?.delete_task(&id).map_err(|e| format!("{e:#}"))
}

/* ---------------------------- attempts ----------------------------- */

/// The first message as it would be sent, for the dialog to show and let the
/// person edit before any worktree is created.
#[tauri::command]
fn preview_prompt(
    state: State<'_, AppState>,
    task_id: String,
    agent: String,
) -> StdResult<serde_json::Value, String> {
    state
        .core()?
        .preview_prompt(&task_id, &agent)
        .map_err(|e| format!("{e:#}"))
}

/// Start an attempt, or queue it when every slot is taken. `mode` is the
/// permission mode the dialog offered — parsed leniently, because an unknown
/// value must degrade to asking, never to not asking.
#[tauri::command]
fn open_attempt(
    state: State<'_, AppState>,
    task_id: String,
    agent: Option<String>,
    prompt: Option<String>,
    mode: Option<String>,
    cols: u16,
    rows: u16,
) -> StdResult<crate::core::StartResult, String> {
    state
        .core()?
        .start_attempt(
            &task_id,
            agent.unwrap_or_else(|| "claude".into()),
            prompt,
            store::PermissionMode::parse(mode.as_deref().unwrap_or("")),
            cols,
            rows,
        )
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn cancel_queued(state: State<'_, AppState>, task_id: String) -> StdResult<(), String> {
    state.core()?.cancel_queued(&task_id).map_err(|e| e.to_string())
}

/// How many attempts may hold a terminal at once. The thing being rationed
/// is a person's attention, not a machine.
#[tauri::command]
fn concurrency(state: State<'_, AppState>) -> StdResult<serde_json::Value, String> {
    let core = state.core()?;
    Ok(serde_json::json!({
        "max": core.max_concurrent(),
        "running": core.running_attempts(),
        "queued": core.queue().len(),
    }))
}

#[tauri::command]
fn set_concurrency(state: State<'_, AppState>, max: i64) -> StdResult<(), String> {
    state.core()?.set_max_concurrent(max).map_err(|e| e.to_string())
}

/// Fold the attempt's branch back into its base, then close it out.
#[tauri::command]
fn merge_attempt(state: State<'_, AppState>, attempt_id: String) -> StdResult<String, String> {
    state
        .core()?
        .merge_attempt(&attempt_id)
        .map_err(|e| format!("{e:#}"))
}

/// Push the branch and open a pull request. The attempt stays open: review is
/// exactly when there is still something to change.
#[tauri::command]
fn open_pr(state: State<'_, AppState>, attempt_id: String) -> StdResult<String, String> {
    state.core()?.open_pr(&attempt_id).map_err(|e| format!("{e:#}"))
}

/// Put a terminal back on an attempt that is not running — the state every
/// attempt is in after a restart.
#[tauri::command]
fn reopen_attempt(
    state: State<'_, AppState>,
    attempt_id: String,
    cols: u16,
    rows: u16,
) -> StdResult<String, String> {
    state
        .core()?
        .reopen_attempt(&attempt_id, cols, rows)
        .map_err(|e| format!("{e:#}"))
}

/// End an attempt: freeze its diff, then give the worktree back.
#[tauri::command]
fn finish_attempt(
    state: State<'_, AppState>,
    attempt_id: String,
    outcome: String,
) -> StdResult<(), String> {
    let outcome =
        store::Outcome::parse(&outcome).ok_or_else(|| format!("unknown outcome: {outcome}"))?;
    state
        .core()?
        .finish_attempt(&attempt_id, outcome)
        .map_err(|e| format!("{e:#}"))
}

/// Send a later message into an attempt's live terminal — the review drawer's
/// way of saying what is still wrong without leaving the diff.
#[tauri::command]
fn send_followup(state: State<'_, AppState>, id: String, text: String) -> StdResult<(), String> {
    state
        .core()?
        .send_followup(&id, &text)
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn attempt_diff(state: State<'_, AppState>, attempt_id: String) -> StdResult<String, String> {
    state
        .core()?
        .attempt_diff(&attempt_id)
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn attempt_events(
    state: State<'_, AppState>,
    attempt_id: String,
) -> StdResult<Vec<store::AttemptEvent>, String> {
    state
        .core()?
        .attempt_events(&attempt_id)
        .map_err(|e| e.to_string())
}

/// The repository's run scripts, for the drawer's buttons.
#[tauri::command]
fn list_run_scripts(
    state: State<'_, AppState>,
    attempt_id: String,
) -> StdResult<Vec<String>, String> {
    state
        .core()?
        .list_run_scripts(&attempt_id)
        .map_err(|e| format!("{e:#}"))
}

/// Start a run script in the attempt's worktree, in a terminal of its own.
#[tauri::command]
fn run_script(
    state: State<'_, AppState>,
    attempt_id: String,
    name: String,
    cols: u16,
    rows: u16,
) -> StdResult<String, String> {
    state
        .core()?
        .run_script(&attempt_id, &name, cols, rows)
        .map_err(|e| format!("{e:#}"))
}

/* ---------------------------- profiles ----------------------------- */

/// Everything a launch dialog can offer: bare agents, then profiles.
#[tauri::command]
fn list_launchers(state: State<'_, AppState>) -> StdResult<Vec<crate::core::Launcher>, String> {
    state.core()?.launchers().map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn list_profiles(state: State<'_, AppState>) -> StdResult<Vec<store::Profile>, String> {
    state.core()?.profiles().map_err(|e| format!("{e:#}"))
}

/// Replace the profiles wholesale — there are few enough that the editor
/// works on the whole list.
#[tauri::command]
fn save_profiles(
    state: State<'_, AppState>,
    profiles: Vec<store::Profile>,
) -> StdResult<(), String> {
    state
        .core()?
        .set_profiles(profiles)
        .map_err(|e| format!("{e:#}"))
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(|_, event| {
            if let tauri::WindowEvent::Focused(focused) = event {
                FOCUSED.store(*focused, Ordering::Relaxed);
            }
        })
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
            set_locale,
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
            list_tasks,
            create_task,
            move_task,
            delete_task,
            preview_prompt,
            open_attempt,
            reopen_attempt,
            finish_attempt,
            attempt_diff,
            attempt_events,
            send_followup,
            list_run_scripts,
            run_script,
            list_launchers,
            list_profiles,
            save_profiles,
            cancel_queued,
            concurrency,
            set_concurrency,
            merge_attempt,
            open_pr,
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
