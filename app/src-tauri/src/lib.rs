mod app_state;
mod commands;
pub mod git;
pub mod models;
mod navigation;
mod windows;

use app_state::AppState;
use tauri::Manager;

pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .setup(|app| {
      let data_dir = std::env::var_os("GITAUR_USER_DATA")
        .or_else(|| std::env::var_os("BRANCHLIGHT_USER_DATA"))
        .map(std::path::PathBuf::from)
        .unwrap_or(app.path().app_data_dir()?);
      std::fs::create_dir_all(&data_dir)?;
      app.handle().plugin(
        tauri_plugin_window_state::Builder::default()
          .with_filename(data_dir.join("window-state.json").to_string_lossy().into_owned())
          .with_state_flags(windows::STATE_FLAGS)
          .map_label(|label| if label.starts_with("commit-") { "commit" } else { label })
          .build(),
      )?;
      let state = AppState::new(&data_dir);
      let repo = std::env::var_os("GITAUR_REPO")
        .or_else(|| std::env::var_os("BRANCHLIGHT_REPO"))
        .and_then(|path| state.git.open(std::path::Path::new(&path)).ok())
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();
      app.manage(state);
      windows::create(app.handle(), "main", "browse", repo).map_err(std::io::Error::other)?;
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      commands::open_project_repository,
      commands::open_release,
      commands::bootstrap,
      commands::reflog,
      commands::tags,
      commands::submodules,
      commands::lfs_status,
      commands::open_repository,
      commands::create_repository,
      commands::choose_directory,
      commands::rebase_plan,
      commands::snapshot,
      commands::detail,
      commands::commit_tree,
      commands::commit_file,
      commands::worktrees,
      commands::conflict_content,
      commands::message_options,
      commands::stashes,
      commands::stash_diff,
      commands::diff,
      commands::image_diff,
      commands::mutate,
      commands::remotes,
      commands::command_log,
      commands::commit_window
    ])
    .run(tauri::generate_context!())
    .expect("Could not start Gitaur");
}
