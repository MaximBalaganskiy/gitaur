use crate::{app_state::AppState, models::window_context::WindowContext};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

pub const STATE_FLAGS: StateFlags = StateFlags::SIZE
  .union(StateFlags::POSITION)
  .union(StateFlags::MAXIMIZED);

pub fn create(app: &AppHandle, label: &str, mode: &str, repo: String) -> Result<(), String> {
  let title = if mode == "commit" {
    let name = std::path::Path::new(&repo)
      .file_name()
      .unwrap_or_default()
      .to_string_lossy();
    format!("Commit — {name} — Gitaur")
  } else {
    "Gitaur".into()
  };
  app
    .state::<AppState>()
    .windows
    .lock()
    .map_err(|error| error.to_string())?
    .insert(
      label.into(),
      WindowContext {
        mode: mode.into(),
        repo,
      },
    );
  let data_dir = std::env::var_os("GITAUR_USER_DATA")
    .or_else(|| std::env::var_os("BRANCHLIGHT_USER_DATA"))
    .map(std::path::PathBuf::from)
    .unwrap_or(app.path().app_data_dir().map_err(|error| error.to_string())?);
  let result = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
    .data_directory(data_dir.join("webview"))
    .decorations(false)
    .title(&title)
    .inner_size(if mode == "commit" { 1220.0 } else { 1480.0 }, 920.0)
    .min_inner_size(900.0, 640.0)
    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
    .on_navigation(|url| crate::navigation::allowed(url, cfg!(debug_assertions)))
    .build();
  match result {
    Ok(window) => {
      let app = app.clone();
      let label = label.to_owned();
      window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
          if let Ok(mut windows) = app.state::<AppState>().windows.lock() {
            windows.remove(&label);
          }
          if let Err(error) = app.save_window_state(STATE_FLAGS) {
            eprintln!("Could not save window layout: {error}");
          }
        }
      });
      Ok(())
    }
    Err(error) => {
      if let Ok(mut windows) = app.state::<AppState>().windows.lock() {
        windows.remove(label);
      }
      Err(error.to_string())
    }
  }
}
