use base64::{engine::general_purpose::STANDARD, Engine};
use gitaur_lib::{git::service::GitService, models::diff_request::DiffRequest};
use std::fs;
use tempfile::TempDir;

fn repository() -> (TempDir, GitService) {
  let temp = tempfile::tempdir().unwrap();
  let git = GitService::default();
  for args in [
    vec!["init", "-b", "main"],
    vec!["config", "user.name", "Image Test"],
    vec!["config", "user.email", "test@example.invalid"],
    vec!["config", "commit.gpgsign", "false"],
    vec!["config", "core.autocrlf", "false"],
  ] {
    git.run(temp.path(), &args, false).unwrap();
  }
  (temp, git)
}

fn image(bytes: &[u8]) -> String {
  format!("data:image/png;base64,{}", STANDARD.encode(bytes))
}

#[test]
fn images_use_selected_commit_index_and_working_tree_versions() {
  let (temp, git) = repository();
  let repo = temp.path();
  let mut request = DiffRequest {
    path: "image.PNG".into(),
    untracked: true,
    ..Default::default()
  };
  fs::write(repo.join(&request.path), b"first\0").unwrap();
  let added = git.image_diff(repo, &request).unwrap();
  assert!(added.before.is_none());
  assert_eq!(added.after.unwrap().image.unwrap(), image(b"first\0"));
  git.run(repo, &["add", "."], false).unwrap();
  request.untracked = false;
  request.staged = true;
  assert!(git.image_diff(repo, &request).unwrap().before.is_none());
  git.run(repo, &["commit", "-m", "First image"], false).unwrap();
  let first = String::from_utf8(git.run(repo, &["rev-parse", "HEAD"], false).unwrap().stdout).unwrap();
  request.hash = Some(first.trim().into());
  assert!(git.image_diff(repo, &request).unwrap().before.is_none());
  fs::write(repo.join(&request.path), b"second\0").unwrap();
  git.run(repo, &["add", "."], false).unwrap();
  git.run(repo, &["commit", "-m", "Second image"], false).unwrap();
  let second = String::from_utf8(git.run(repo, &["rev-parse", "HEAD"], false).unwrap().stdout).unwrap();
  assert_eq!(
    git
      .commit_file(repo, first.trim(), &request.path)
      .unwrap()
      .image
      .unwrap(),
    image(b"first\0")
  );
  request.hash = Some(second.trim().into());
  let changed = git.image_diff(repo, &request).unwrap();
  assert_eq!(changed.before.unwrap().image.unwrap(), image(b"first\0"));
  assert_eq!(changed.after.unwrap().image.unwrap(), image(b"second\0"));
  request.hash = None;
  fs::write(repo.join(&request.path), b"staged\0").unwrap();
  git.run(repo, &["add", "."], false).unwrap();
  fs::write(repo.join(&request.path), b"working\0").unwrap();
  let staged = git.image_diff(repo, &request).unwrap();
  assert_eq!(staged.before.unwrap().image.unwrap(), image(b"second\0"));
  assert_eq!(staged.after.unwrap().image.unwrap(), image(b"staged\0"));
  request.staged = false;
  let working = git.image_diff(repo, &request).unwrap();
  assert_eq!(working.before.unwrap().image.unwrap(), image(b"staged\0"));
  assert_eq!(working.after.unwrap().image.unwrap(), image(b"working\0"));
  fs::remove_file(repo.join(&request.path)).unwrap();
  assert!(git.image_diff(repo, &request).unwrap().after.is_none());
  git.run(repo, &["add", "-u"], false).unwrap();
  git.run(repo, &["commit", "-m", "Delete image"], false).unwrap();
  request.hash = Some(
    String::from_utf8(git.run(repo, &["rev-parse", "HEAD"], false).unwrap().stdout)
      .unwrap()
      .trim()
      .into(),
  );
  let deleted = git.image_diff(repo, &request).unwrap();
  assert!(deleted.before.is_some());
  assert!(deleted.after.is_none());
}

#[test]
fn image_renames_limits_and_invalid_requests() {
  let (temp, git) = repository();
  let repo = temp.path();
  fs::write(repo.join("old.png"), b"old\0").unwrap();
  git.run(repo, &["add", "."], false).unwrap();
  git.run(repo, &["commit", "-m", "Image"], false).unwrap();
  git.run(repo, &["mv", "old.png", "new.png"], false).unwrap();
  let mut request = DiffRequest {
    path: "new.png".into(),
    original_path: Some("old.png".into()),
    staged: true,
    ..Default::default()
  };
  let renamed = git.image_diff(repo, &request).unwrap();
  assert_eq!(renamed.before.unwrap().image, renamed.after.unwrap().image);
  fs::write(repo.join("new.png"), vec![0; 10 * 1024 * 1024 + 1]).unwrap();
  request.staged = false;
  assert!(git
    .image_diff(repo, &request)
    .unwrap()
    .after
    .unwrap()
    .message
    .contains("10 MiB"));
  git.run(repo, &["add", "."], false).unwrap();
  git.run(repo, &["commit", "-m", "Large image"], false).unwrap();
  let hash = String::from_utf8(git.run(repo, &["rev-parse", "HEAD"], false).unwrap().stdout).unwrap();
  assert!(git
    .commit_file(repo, hash.trim(), "new.png")
    .unwrap()
    .message
    .contains("10 MiB"));
  request.path = "../outside.png".into();
  assert!(git.image_diff(repo, &request).is_err());
  request.path = "new.png".into();
  request.hash = Some("--invalid".into());
  assert!(git.image_diff(repo, &request).is_err());
  request.hash = None;
  request.original_path = Some("../outside.png".into());
  assert!(git.image_diff(repo, &request).is_err());
}
