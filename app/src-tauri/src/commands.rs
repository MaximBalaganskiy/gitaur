use crate::models::{conflict_content::ConflictContent, message_options::MessageOptions, worktree::Worktree};
use crate::models::{file_preview::FilePreview, tree_entry::TreeEntry};
use crate::{
  app_state::AppState,
  models::{
    command_entry::CommandEntry, detail::Detail, diff_request::DiffRequest, mutation::Mutation, remote::Remote,
    snapshot::Snapshot,
  },
  windows,
};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub async fn open_release(version: String) -> Result<(), String> {
  if version.is_empty()
    || !version
      .bytes()
      .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
  {
    return Err("Invalid release version".into());
  }
  tauri::async_runtime::spawn_blocking(move || {
    tauri_plugin_opener::open_url(
      format!("https://github.com/MaximBalaganskiy/gitaur/releases/tag/v{version}"),
      None::<&str>,
    )
    .map_err(|error| error.to_string())
  })
  .await
  .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn open_project_repository() -> Result<(), String> {
  tauri::async_runtime::spawn_blocking(|| {
    tauri_plugin_opener::open_url("https://github.com/MaximBalaganskiy/gitaur", None::<&str>)
      .map_err(|error| error.to_string())
  })
  .await
  .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn reflog(
  app: AppHandle,
  window: WebviewWindow,
) -> Result<Vec<crate::models::reflog_entry::ReflogEntry>, String> {
  let repo = app.state::<AppState>().repo(window.label())?;
  tauri::async_runtime::spawn_blocking(move || app.state::<AppState>().git.reflog(&repo))
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn tags(app: AppHandle, window: WebviewWindow) -> Result<Vec<crate::models::tag::Tag>, String> {
  let repo = app.state::<AppState>().repo(window.label())?;
  tauri::async_runtime::spawn_blocking(move || app.state::<AppState>().git.tags(&repo))
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn submodules(
  app: AppHandle,
  window: WebviewWindow,
) -> Result<Vec<crate::models::submodule::Submodule>, String> {
  let repo = app.state::<AppState>().repo(window.label())?;
  tauri::async_runtime::spawn_blocking(move || app.state::<AppState>().git.submodules(&repo))
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn lfs_status(app: AppHandle, window: WebviewWindow) -> Result<crate::models::lfs_status::LfsStatus, String> {
  let repo = app.state::<AppState>().repo(window.label())?;
  tauri::async_runtime::spawn_blocking(move || app.state::<AppState>().git.lfs_status(&repo))
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn create_repository(
  app: AppHandle,
  window: WebviewWindow,
  request: crate::models::repository_request::RepositoryRequest,
) -> Result<String, String> {
  if app.state::<AppState>().context(window.label())?.mode != "browse" {
    return Err("Create repositories from the main window.".into());
  }
  tauri::async_runtime::spawn_blocking(move || app.state::<AppState>().git.create_repository(&request))
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn choose_directory(app: AppHandle) -> Result<Option<String>, String> {
  tauri::async_runtime::spawn_blocking(move || {
    app
      .dialog()
      .file()
      .set_title("Choose a destination folder")
      .blocking_pick_folder()
      .map(|path| {
        path
          .into_path()
          .map(|path| path.to_string_lossy().into_owned())
          .map_err(|error| error.to_string())
      })
      .transpose()
  })
  .await
  .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn rebase_plan(
  app: AppHandle,
  window: WebviewWindow,
  reference: String,
) -> Result<Vec<crate::models::rebase_step::RebaseStep>, String> {
  let repo = app.state::<AppState>().repo(window.label())?;
  tauri::async_runtime::spawn_blocking(move || app.state::<AppState>().git.rebase_plan(&repo, &reference))
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn stashes(app: AppHandle, window: WebviewWindow) -> Result<Vec<crate::models::stash::Stash>, String> {
  let repo = app.state::<AppState>().repo(window.label())?;
  tauri::async_runtime::spawn_blocking(move || app.state::<AppState>().git.stashes(&repo))
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn stash_diff(app: AppHandle, window: WebviewWindow, hash: String) -> Result<String, String> {
  let repo = app.state::<AppState>().repo(window.label())?;
  tauri::async_runtime::spawn_blocking(move || app.state::<AppState>().git.stash_diff(&repo, &hash))
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn worktrees(app: AppHandle, window: WebviewWindow) -> Result<Vec<Worktree>, String> {
  let repo = app.state::<AppState>().repo(window.label())?;
  tauri::async_runtime::spawn_blocking(move || app.state::<AppState>().git.worktrees(&repo))
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn conflict_content(app: AppHandle, window: WebviewWindow, path: String) -> Result<ConflictContent, String> {
  let repo = app.state::<AppState>().repo(window.label())?;
  tauri::async_runtime::spawn_blocking(move || app.state::<AppState>().git.conflict_content(&repo, &path))
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn message_options(app: AppHandle, window: WebviewWindow) -> Result<MessageOptions, String> {
  let repo = app.state::<AppState>().repo(window.label())?;
  tauri::async_runtime::spawn_blocking(move || app.state::<AppState>().git.message_options(&repo))
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn commit_tree(app: AppHandle, window: WebviewWindow, hash: String) -> Result<Vec<TreeEntry>, String> {
  let repo = app.state::<AppState>().repo(window.label())?;
  tauri::async_runtime::spawn_blocking(move || app.state::<AppState>().git.commit_tree(&repo, &hash))
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn commit_file(
  app: AppHandle,
  window: WebviewWindow,
  hash: String,
  path: String,
) -> Result<FilePreview, String> {
  let repo = app.state::<AppState>().repo(window.label())?;
  tauri::async_runtime::spawn_blocking(move || app.state::<AppState>().git.commit_file(&repo, &hash, &path))
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn bootstrap(app: AppHandle, window: WebviewWindow) -> Result<Value, String> {
  let state = app.state::<AppState>();
  let context = state.context(window.label())?;
  Ok(json!({ "mode": context.mode, "repo": context.repo, "recent": state.recent()? }))
}

#[tauri::command]
pub async fn open_repository(
  app: AppHandle,
  window: WebviewWindow,
  directory: Option<String>,
) -> Result<Option<String>, String> {
  if app.state::<AppState>().context(window.label())?.mode != "browse" {
    return Err("Open repositories from the main window.".into());
  }
  tauri::async_runtime::spawn_blocking(move || {
    let directory = match directory {
      Some(value) => PathBuf::from(value),
      None => match app
        .dialog()
        .file()
        .set_title("Open Git repository")
        .blocking_pick_folder()
      {
        Some(path) => path.into_path().map_err(|error| error.to_string())?,
        None => return Ok(None),
      },
    };
    let state = app.state::<AppState>();
    let repo = state.git.open(&directory)?;
    let name = repo.file_name().unwrap_or_default().to_string_lossy();
    window
      .set_title(&format!("{name} — Gitaur"))
      .map_err(|error| error.to_string())?;
    let repo = repo.to_string_lossy().into_owned();
    state.remember(&repo)?;
    state
      .windows
      .lock()
      .map_err(|error| error.to_string())?
      .get_mut(window.label())
      .ok_or("Unknown application window.")?
      .repo = repo.clone();
    Ok(Some(repo))
  })
  .await
  .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn snapshot(app: AppHandle, window: WebviewWindow, limit: usize) -> Result<Snapshot, String> {
  let repo = app.state::<AppState>().repo(window.label())?;
  tauri::async_runtime::spawn_blocking(move || app.state::<AppState>().git.snapshot(&repo, limit))
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn detail(app: AppHandle, window: WebviewWindow, hash: String) -> Result<Detail, String> {
  let repo = app.state::<AppState>().repo(window.label())?;
  tauri::async_runtime::spawn_blocking(move || app.state::<AppState>().git.detail(&repo, &hash))
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn diff(app: AppHandle, window: WebviewWindow, request: DiffRequest) -> Result<String, String> {
  let repo = app.state::<AppState>().repo(window.label())?;
  tauri::async_runtime::spawn_blocking(move || app.state::<AppState>().git.diff(&repo, &request))
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn image_diff(
  app: AppHandle,
  window: WebviewWindow,
  request: DiffRequest,
) -> Result<crate::models::image_diff::ImageDiff, String> {
  let repo = app.state::<AppState>().repo(window.label())?;
  tauri::async_runtime::spawn_blocking(move || app.state::<AppState>().git.image_diff(&repo, &request))
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn mutate(app: AppHandle, window: WebviewWindow, action: String, payload: Mutation) -> Result<bool, String> {
  let repo = app.state::<AppState>().repo(window.label())?;
  tauri::async_runtime::spawn_blocking(move || {
    let state = app.state::<AppState>();
    let result = state.git.mutate(&repo, &action, &payload);
    // Failed hooks and Git operations can still change the index or worktree.
    let labels: Vec<_> = state
      .windows
      .lock()
      .map_err(|error| error.to_string())?
      .iter()
      .filter(|(_, context)| std::path::Path::new(&context.repo) == repo)
      .map(|(label, _)| label.clone())
      .collect();
    for label in labels {
      let _ = app.emit_to(label, "repository-changed", ());
    }
    result
  })
  .await
  .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn remotes(app: AppHandle, window: WebviewWindow) -> Result<Vec<Remote>, String> {
  let repo = app.state::<AppState>().repo(window.label())?;
  tauri::async_runtime::spawn_blocking(move || app.state::<AppState>().git.remotes(&repo))
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn command_log(app: AppHandle, window: WebviewWindow) -> Result<Vec<CommandEntry>, String> {
  let state = app.state::<AppState>();
  state.git.log(&state.repo(window.label())?)
}

#[tauri::command]
pub async fn commit_window(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
  let state = app.state::<AppState>();
  let repo = state.repo(window.label())?.to_string_lossy().into_owned();
  let existing = state
    .windows
    .lock()
    .map_err(|error| error.to_string())?
    .iter()
    .find(|(_, context)| context.mode == "commit" && context.repo == repo)
    .map(|(label, _)| label.clone());
  if let Some(existing) = existing.and_then(|label| app.get_webview_window(&label)) {
    existing.show().map_err(|error| error.to_string())?;
    return existing.set_focus().map_err(|error| error.to_string());
  }
  let label = format!("commit-{}", state.next_window.fetch_add(1, Ordering::Relaxed));
  windows::create(&app, &label, "commit", repo)
}
