use gitaur_lib::{
  git::service::GitService,
  models::{diff_request::DiffRequest, mutation::Mutation},
};
use serde_json::{json, Value};
use std::{fs, path::Path};
use tempfile::TempDir;

fn repo() -> (TempDir, GitService) {
  let temp = tempfile::tempdir().unwrap();
  let git = GitService::default();
  for args in [
    vec!["init", "-b", "main"],
    vec!["config", "user.name", "Test"],
    vec!["config", "user.email", "test@example.invalid"],
    vec!["config", "commit.gpgsign", "false"],
    vec!["config", "core.autocrlf", "false"],
  ] {
    git.run(temp.path(), &args, false).unwrap();
  }
  (temp, git)
}

fn action(git: &GitService, repo: &Path, name: &str, payload: Value) {
  git
    .mutate(repo, name, &serde_json::from_value::<Mutation>(payload).unwrap())
    .unwrap();
}

fn commit(git: &GitService, repo: &Path, text: &str, message: &str) {
  fs::write(repo.join("file.txt"), text).unwrap();
  action(git, repo, "stage", json!({"paths":["file.txt"]}));
  action(git, repo, "commit", json!({"message":message}));
}

fn content(git: &GitService, repo: &Path, reference: &str) -> String {
  String::from_utf8(git.run(repo, &["show", reference], false).unwrap().stdout).unwrap()
}

fn diff(git: &GitService, repo: &Path, staged: bool) -> String {
  git
    .diff(
      repo,
      &DiffRequest {
        path: "file.txt".into(),
        staged,
        ..Default::default()
      },
    )
    .unwrap()
}

fn partial(git: &GitService, repo: &Path, staged: bool, texts: &[&str]) {
  let original = diff(git, repo, staged);
  let lines: Vec<_> = original
    .lines()
    .enumerate()
    .filter(|(_, line)| texts.contains(line))
    .map(|(index, _)| index)
    .collect();
  assert_eq!(lines.len(), texts.len());
  action(
    git,
    repo,
    "partial-stage",
    json!({"paths":["file.txt"], "original":original, "staged":staged,"lines":lines}),
  );
}

#[test]
fn delete_new_file_handles_untracked_staged_and_intent_to_add_files_without_head() {
  for unborn in [false, true] {
    for stage in ["untracked", "staged", "intent", "missing"] {
      let (temp, git) = repo();
      let repo = temp.path();
      if !unborn {
        commit(&git, repo, "base\n", "Base");
      }
      fs::create_dir(repo.join("folder")).unwrap();
      let path = "folder/[new].bin";
      fs::write(repo.join(path), [0, 255, 1, 2]).unwrap();
      match stage {
        "staged" | "missing" => action(&git, repo, "stage", json!({"paths":[path]})),
        "intent" => {
          git.run(repo, &["add", "-N", "--", path], false).unwrap();
        }
        _ => {}
      }
      if stage == "staged" {
        fs::write(repo.join(path), [0, 254, 1, 2]).unwrap();
      } else if stage == "missing" {
        fs::remove_file(repo.join(path)).unwrap();
      }
      fs::write(repo.join("other.txt"), "keep staged\n").unwrap();
      action(&git, repo, "stage", json!({"paths":["other.txt"]}));
      fs::write(repo.join("other.txt"), "keep working\n").unwrap();
      fs::write(repo.join("folder/keep.txt"), "keep untracked\n").unwrap();
      let original = git.new_file_state(repo, path).unwrap();
      action(&git, repo, "delete-file", json!({"paths":[path],"original":original}));
      assert!(!repo.join(path).exists());
      assert!(git
        .run(repo, &["ls-files", "--", path], false)
        .unwrap()
        .stdout
        .is_empty());
      assert_eq!(content(&git, repo, ":other.txt"), "keep staged\n");
      assert_eq!(fs::read_to_string(repo.join("other.txt")).unwrap(), "keep working\n");
      assert_eq!(
        fs::read_to_string(repo.join("folder/keep.txt")).unwrap(),
        "keep untracked\n"
      );
      assert!(repo.join("folder").is_dir());
    }
  }
}

#[test]
fn delete_new_file_rejects_changed_content_index_and_committed_files() {
  let (temp, git) = repo();
  let repo = temp.path();
  commit(&git, repo, "base\n", "Base");
  fs::write(repo.join("new.bin"), [0, 255]).unwrap();
  let original = git.new_file_state(repo, "new.bin").unwrap();
  let request = json!({"paths":["new.bin"],"original":original});
  fs::write(repo.join("new.bin"), [0, 254]).unwrap();
  let error = git
    .mutate(repo, "delete-file", &serde_json::from_value(request.clone()).unwrap())
    .unwrap_err();
  assert!(error.contains("changed"));
  assert_eq!(fs::read(repo.join("new.bin")).unwrap(), [0, 254]);
  fs::write(repo.join("new.bin"), [0, 255]).unwrap();
  action(&git, repo, "stage", json!({"paths":["new.bin"]}));
  let error = git
    .mutate(repo, "delete-file", &serde_json::from_value(request).unwrap())
    .unwrap_err();
  assert!(error.contains("changed"));
  assert_eq!(git.run(repo, &["show", ":new.bin"], false).unwrap().stdout, [0, 255]);
  let original = git.new_file_state(repo, "new.bin").unwrap();
  action(&git, repo, "commit", json!({"message":"Commit new file"}));
  let request = json!({"paths":["new.bin"],"original":original});
  assert!(git
    .mutate(repo, "delete-file", &serde_json::from_value(request).unwrap())
    .is_err());
  assert!(repo.join("new.bin").exists());
}

#[test]
fn delete_new_file_rejects_tracked_files_renames_folders_and_invalid_paths() {
  let (temp, git) = repo();
  let repo = temp.path();
  commit(&git, repo, "base\n", "Base");
  fs::write(repo.join("file.txt"), "working edit\n").unwrap();
  assert!(git.new_file_state(repo, "file.txt").is_err());
  fs::create_dir(repo.join("folder")).unwrap();
  fs::write(repo.join("folder/new.txt"), "keep\n").unwrap();
  for path in [
    "folder",
    "../outside",
    ".git/config",
    "folder/../../outside",
    "/outside",
  ] {
    assert!(git.new_file_state(repo, path).is_err());
  }
  git.run(repo, &["mv", "--", "file.txt", "renamed.txt"], false).unwrap();
  assert!(git.new_file_state(repo, "renamed.txt").is_err());
  assert_eq!(fs::read_to_string(repo.join("renamed.txt")).unwrap(), "working edit\n");
  assert_eq!(fs::read_to_string(repo.join("folder/new.txt")).unwrap(), "keep\n");
  // A new file at the path of a staged deletion is still part of a tracked-file reset.
  fs::write(repo.join("file.txt"), "replacement\n").unwrap();
  assert!(git.new_file_state(repo, "file.txt").is_err());
}

#[cfg(unix)]
#[test]
fn delete_new_file_rejects_links_and_paths_through_links() {
  use std::os::unix::fs::symlink;
  let (temp, git) = repo();
  let outside = tempfile::tempdir().unwrap();
  fs::write(outside.path().join("keep.txt"), "keep\n").unwrap();
  symlink(outside.path(), temp.path().join("linked")).unwrap();
  assert!(git.new_file_state(temp.path(), "linked/keep.txt").is_err());
  assert!(git.new_file_state(temp.path(), "linked").is_err());
  assert_eq!(fs::read_to_string(outside.path().join("keep.txt")).unwrap(), "keep\n");
}

#[test]
fn reset_hunks_and_lines_preserves_index_and_other_working_changes() {
  let (temp, git) = repo();
  let repo = temp.path();
  let base: String = (1..=30).map(|index| format!("line {index}\n")).collect();
  commit(&git, repo, &base, "Base");
  let indexed = base.replace("line 15\n", "staged 15\n");
  fs::write(repo.join("file.txt"), &indexed).unwrap();
  action(&git, repo, "stage", json!({"paths":["file.txt"]}));
  let working = indexed
    .replace("line 2\n", "changed 2\n")
    .replace("line 28\n", "changed 28\n");
  fs::write(repo.join("file.txt"), &working).unwrap();
  let original = diff(&git, repo, false);
  let lines: Vec<_> = original
    .lines()
    .enumerate()
    .filter(|(_, line)| ["-line 2", "+changed 2"].contains(line))
    .map(|(index, _)| index)
    .collect();
  action(
    &git,
    repo,
    "partial-reset",
    json!({"paths":["file.txt"],"original":original,"lines":lines}),
  );
  assert_eq!(
    fs::read_to_string(repo.join("file.txt")).unwrap(),
    indexed.replace("line 28\n", "changed 28\n")
  );
  assert_eq!(content(&git, repo, ":file.txt"), indexed);
  assert_eq!(content(&git, repo, "HEAD:file.txt"), base);
  let original = diff(&git, repo, false);
  let line = original.lines().position(|line| line == "+changed 28").unwrap();
  action(
    &git,
    repo,
    "partial-reset",
    json!({"paths":["file.txt"],"original":original,"lines":[line]}),
  );
  assert_eq!(
    fs::read_to_string(repo.join("file.txt")).unwrap(),
    indexed.replace("line 28\n", "")
  );
  action(
    &git,
    repo,
    "reset-file",
    json!({"paths":["file.txt"],"original":diff(&git, repo, false)}),
  );
  assert_eq!(fs::read_to_string(repo.join("file.txt")).unwrap(), indexed);
  assert_eq!(content(&git, repo, ":file.txt"), indexed);
  fs::remove_file(repo.join("file.txt")).unwrap();
  action(
    &git,
    repo,
    "reset-file",
    json!({"paths":["file.txt"],"original":diff(&git, repo, false)}),
  );
  assert_eq!(fs::read_to_string(repo.join("file.txt")).unwrap(), indexed);
}

#[test]
fn reset_rejects_stale_diffs_and_untracked_files() {
  let (temp, git) = repo();
  let repo = temp.path();
  commit(&git, repo, "base\n", "Base");
  fs::write(repo.join("file.txt"), "reviewed\n").unwrap();
  let original = diff(&git, repo, false);
  fs::write(repo.join("file.txt"), "external edit\n").unwrap();
  for name in ["reset-file", "partial-reset"] {
    let payload = serde_json::from_value(json!({"paths":["file.txt"],"original":original,"lines":[4,5]})).unwrap();
    assert!(git.mutate(repo, name, &payload).unwrap_err().contains("diff changed"));
    assert_eq!(fs::read_to_string(repo.join("file.txt")).unwrap(), "external edit\n");
  }
  let payload = serde_json::from_value(json!({"paths":["file.txt"],"staged":true})).unwrap();
  assert!(git
    .mutate(repo, "partial-reset", &payload)
    .unwrap_err()
    .contains("Unstage"));
  fs::write(repo.join("untracked.txt"), "keep\n").unwrap();
  let payload = serde_json::from_value(json!({"paths":["untracked.txt"]})).unwrap();
  assert!(git.mutate(repo, "reset-file", &payload).is_err());
  assert_eq!(fs::read_to_string(repo.join("untracked.txt")).unwrap(), "keep\n");
}

#[test]
fn reset_staged_file_restores_head_and_preserves_other_files() {
  let (temp, git) = repo();
  let repo = temp.path();
  commit(&git, repo, "base\n", "Base");
  let head = git.resolve_reference(repo, "HEAD").unwrap();
  fs::write(repo.join("other.txt"), "keep staged\n").unwrap();
  action(&git, repo, "stage", json!({"paths":["other.txt"]}));
  fs::write(repo.join("other.txt"), "keep working\n").unwrap();
  for deleted in [false, true] {
    if deleted {
      fs::remove_file(repo.join("file.txt")).unwrap();
    } else {
      fs::write(repo.join("file.txt"), "staged\n").unwrap();
    }
    action(&git, repo, "stage", json!({"paths":["file.txt"]}));
    if !deleted {
      fs::write(repo.join("file.txt"), "working\n").unwrap();
    }
    action(
      &git,
      repo,
      "reset-file",
      json!({
        "paths":["file.txt"], "staged":true, "expected_head":head,
        "original":diff(&git, repo, true), "original_worktree":diff(&git, repo, false)
      }),
    );
    assert_eq!(content(&git, repo, ":file.txt"), "base\n");
    assert_eq!(fs::read_to_string(repo.join("file.txt")).unwrap(), "base\n");
    assert_eq!(content(&git, repo, ":other.txt"), "keep staged\n");
    assert_eq!(fs::read_to_string(repo.join("other.txt")).unwrap(), "keep working\n");
    assert_eq!(git.resolve_reference(repo, "HEAD").unwrap(), head);
  }
}

#[test]
fn reset_staged_file_rejects_changed_head_index_worktree_and_untracked_replacement() {
  let (temp, git) = repo();
  let repo = temp.path();
  commit(&git, repo, "base\n", "Base");
  let head = git.resolve_reference(repo, "HEAD").unwrap();
  fs::write(repo.join("file.txt"), "staged\n").unwrap();
  action(&git, repo, "stage", json!({"paths":["file.txt"]}));
  let mut payload = json!({
    "paths":["file.txt"], "staged":true, "expected_head":head,
    "original":diff(&git, repo, true), "original_worktree":diff(&git, repo, false)
  });
  fs::write(repo.join("file.txt"), "external edit\n").unwrap();
  let error = git
    .mutate(repo, "reset-file", &serde_json::from_value(payload.clone()).unwrap())
    .unwrap_err();
  assert!(error.contains("working diff changed"));
  assert_eq!(content(&git, repo, ":file.txt"), "staged\n");
  assert_eq!(fs::read_to_string(repo.join("file.txt")).unwrap(), "external edit\n");
  action(&git, repo, "stage", json!({"paths":["file.txt"]}));
  let error = git
    .mutate(repo, "reset-file", &serde_json::from_value(payload.clone()).unwrap())
    .unwrap_err();
  assert!(error.contains("diff changed"));
  action(&git, repo, "commit", json!({"message":"New HEAD"}));
  fs::write(repo.join("file.txt"), "another staged edit\n").unwrap();
  action(&git, repo, "stage", json!({"paths":["file.txt"]}));
  let error = git
    .mutate(repo, "reset-file", &serde_json::from_value(payload.clone()).unwrap())
    .unwrap_err();
  assert!(error.contains("HEAD changed"));
  fs::remove_file(repo.join("file.txt")).unwrap();
  action(&git, repo, "stage", json!({"paths":["file.txt"]}));
  payload["expected_head"] = json!(git.resolve_reference(repo, "HEAD").unwrap());
  payload["original"] = json!(diff(&git, repo, true));
  payload["original_worktree"] = json!(diff(&git, repo, false));
  fs::write(repo.join("file.txt"), "untracked replacement\n").unwrap();
  let error = git
    .mutate(repo, "reset-file", &serde_json::from_value(payload).unwrap())
    .unwrap_err();
  assert!(error.contains("untracked file"));
  assert_eq!(
    fs::read_to_string(repo.join("file.txt")).unwrap(),
    "untracked replacement\n"
  );
}

#[test]
fn publish_sets_upstream_and_normal_push_works() {
  let (temp, git) = repo();
  let repo = temp.path();
  commit(&git, repo, "base\n", "Base");
  let remote = tempfile::tempdir().unwrap();
  git.run(remote.path(), &["init", "--bare"], false).unwrap();
  git
    .run(
      repo,
      &["remote", "add", "origin", remote.path().to_str().unwrap()],
      false,
    )
    .unwrap();
  action(
    &git,
    repo,
    "publish",
    json!({"name":"origin","text":"feature/published","reference":"main"}),
  );
  assert_eq!(
    String::from_utf8(
      git
        .run(repo, &["rev-parse", "--abbrev-ref", "@{upstream}"], false)
        .unwrap()
        .stdout
    )
    .unwrap()
    .trim(),
    "origin/feature/published"
  );
  commit(&git, repo, "next\n", "Next");
  action(&git, repo, "push", json!({}));
  assert_eq!(
    git.resolve_reference(remote.path(), "feature/published").unwrap(),
    git.resolve_reference(repo, "HEAD").unwrap()
  );
}

#[test]
fn stash_roundtrip_preserves_index_untracked_files_and_drop_targets() {
  let (temp, git) = repo();
  let repo = temp.path();
  commit(&git, repo, "base\n", "Base");
  fs::write(repo.join("file.txt"), "staged\n").unwrap();
  action(&git, repo, "stage", json!({"paths":["file.txt"]}));
  fs::write(repo.join("file.txt"), "unstaged\n").unwrap();
  fs::write(repo.join("extra.txt"), "untracked\n").unwrap();
  action(
    &git,
    repo,
    "stash-save",
    json!({"message":"My stash", "include_untracked":true}),
  );
  let stash = git.stashes(repo).unwrap().remove(0);
  assert!(stash.message.contains("My stash"));
  assert!(git.stash_diff(repo, &stash.hash).unwrap().contains("extra.txt"));
  assert!(git.snapshot(repo, 1).unwrap().files.is_empty());
  action(&git, repo, "stash-apply", json!({"reference":stash.hash}));
  assert_eq!(content(&git, repo, ":file.txt"), "staged\n");
  assert_eq!(fs::read_to_string(repo.join("file.txt")).unwrap(), "unstaged\n");
  assert!(repo.join("extra.txt").exists());
  assert_eq!(git.stashes(repo).unwrap().len(), 1);
  action(
    &git,
    repo,
    "stash-save",
    json!({"message":"Newer stash", "include_untracked":true}),
  );
  assert_eq!(git.stashes(repo).unwrap().len(), 2);
  action(&git, repo, "stash-drop", json!({"reference":stash.hash}));
  let newer = git.stashes(repo).unwrap().remove(0);
  assert!(newer.message.contains("Newer stash"));
  action(&git, repo, "stash-pop", json!({"reference":newer.hash}));
  assert!(git.stashes(repo).unwrap().is_empty());
  assert_eq!(content(&git, repo, ":file.txt"), "staged\n");
}

#[test]
fn stash_pop_conflicts_keep_the_saved_stash() {
  let (temp, git) = repo();
  let repo = temp.path();
  commit(&git, repo, "base\n", "Base");
  fs::write(repo.join("file.txt"), "stashed\n").unwrap();
  action(&git, repo, "stash-save", json!({"message":"Keep me"}));
  let stash = git.stashes(repo).unwrap().remove(0);
  commit(&git, repo, "conflicting\n", "Conflicting");
  let result = git.mutate(
    repo,
    "stash-pop",
    &serde_json::from_value(json!({"reference":stash.hash})).unwrap(),
  );
  assert!(result.is_err());
  assert_eq!(git.stashes(repo).unwrap()[0].hash, stash.hash);
}

#[test]
fn amend_and_soft_undo_preserve_working_edits_and_reject_stale_head() {
  let (temp, git) = repo();
  let repo = temp.path();
  commit(&git, repo, "base\n", "Base");
  let base = git.resolve_reference(repo, "HEAD").unwrap();
  commit(&git, repo, "second\n", "Second");
  let head = git.resolve_reference(repo, "HEAD").unwrap();
  fs::write(repo.join("file.txt"), "unstaged edit\n").unwrap();
  action(
    &git,
    repo,
    "amend",
    json!({"reference":head,"message":"Corrected message"}),
  );
  assert_eq!(content(&git, repo, "HEAD:file.txt"), "second\n");
  assert_eq!(fs::read_to_string(repo.join("file.txt")).unwrap(), "unstaged edit\n");
  assert!(git
    .mutate(
      repo,
      "undo-commit",
      &serde_json::from_value(json!({"reference":head})).unwrap()
    )
    .is_err());
  let amended = git.resolve_reference(repo, "HEAD").unwrap();
  action(&git, repo, "undo-commit", json!({"reference":amended}));
  assert_eq!(git.resolve_reference(repo, "HEAD").unwrap(), base);
  assert_eq!(content(&git, repo, ":file.txt"), "second\n");
  assert_eq!(fs::read_to_string(repo.join("file.txt")).unwrap(), "unstaged edit\n");
}

#[test]
fn full_file_diffs_keep_context_and_partial_staging_safe() {
  let (temp, git) = repo();
  let repo = temp.path();
  let original = (1..=80).map(|n| format!("line {n}\n")).collect::<String>();
  commit(&git, repo, &original, "Base");
  let working = original
    .replace("line 40\n", "changed 40\n")
    .replace("line 70\n", "changed 70\n");
  fs::write(repo.join("file.txt"), &working).unwrap();
  assert!(!diff(&git, repo, false).contains(" line 1\n"));
  let request = DiffRequest {
    path: "file.txt".into(),
    full_file: true,
    ..Default::default()
  };
  let expanded = git.diff(repo, &request).unwrap();
  assert!(expanded.contains(" line 1\n"));
  assert!(expanded.contains(" line 80\n"));
  let selected: Vec<_> = expanded
    .lines()
    .enumerate()
    .filter(|(_, line)| ["-line 40", "+changed 40"].contains(line))
    .map(|(index, _)| index)
    .collect();
  assert_eq!(selected.len(), 2);
  action(
    &git,
    repo,
    "partial-stage",
    json!({
      "paths":["file.txt"], "original":expanded, "lines":selected, "full_file":true
    }),
  );
  assert_eq!(
    content(&git, repo, ":file.txt"),
    original.replace("line 40\n", "changed 40\n")
  );
  let staged = git
    .diff(
      repo,
      &DiffRequest {
        staged: true,
        ..request
      },
    )
    .unwrap();
  assert!(staged.contains(" line 80\n"));
  let selected: Vec<_> = staged
    .lines()
    .enumerate()
    .filter(|(_, line)| ["-line 40", "+changed 40"].contains(line))
    .map(|(index, _)| index)
    .collect();
  action(
    &git,
    repo,
    "partial-stage",
    json!({
      "paths":["file.txt"], "original":staged, "lines":selected, "staged":true, "full_file":true
    }),
  );
  assert_eq!(content(&git, repo, ":file.txt"), original);
  fs::write(repo.join("file.txt"), "external change\n").unwrap();
  let result = git.mutate(
    repo,
    "partial-stage",
    &serde_json::from_value(json!({
      "paths":["file.txt"], "original":expanded, "lines":[5], "full_file":true
    }))
    .unwrap(),
  );
  assert!(result.unwrap_err().contains("diff changed"));
  commit(&git, repo, &working, "Changed middle");
  let hash = git.resolve_reference(repo, "HEAD").unwrap();
  fs::write(repo.join("file.txt"), "unrelated working copy\n").unwrap();
  let historical = git
    .diff(
      repo,
      &DiffRequest {
        path: "file.txt".into(),
        hash: Some(hash),
        full_file: true,
        ..Default::default()
      },
    )
    .unwrap();
  assert!(historical.contains(" line 1\n"));
  assert!(historical.contains(" line 80\n"));
  assert!(historical.contains("+changed 40\n"));
  assert!(!historical.contains("unrelated working copy"));
}

#[test]
fn partial_stage_and_unstage_preserve_other_changes_across_hunks() {
  let (temp, git) = repo();
  let repo = temp.path();
  git.run(repo, &["config", "diff.noprefix", "true"], false).unwrap();
  let original = (1..=24).map(|n| format!("line {n}\n")).collect::<String>();
  commit(&git, repo, &original, "Base");
  let working = original
    .replace("line 2\n", "changed 2\n")
    .replace("line 22\n", "changed 22\n");
  fs::write(repo.join("file.txt"), &working).unwrap();
  partial(&git, repo, false, &["-line 2", "+changed 2"]);
  assert_eq!(
    content(&git, repo, ":file.txt"),
    original.replace("line 2\n", "changed 2\n")
  );
  partial(&git, repo, false, &["+changed 22"]);
  assert_eq!(
    content(&git, repo, ":file.txt"),
    original
      .replace("line 2\n", "changed 2\n")
      .replace("line 22\n", "line 22\nchanged 22\n")
  );
  partial(&git, repo, true, &["+changed 22"]);
  partial(&git, repo, true, &["-line 2", "+changed 2"]);
  assert_eq!(content(&git, repo, ":file.txt"), original);
  assert_eq!(fs::read_to_string(repo.join("file.txt")).unwrap(), working);
  let old_diff = diff(&git, repo, false);
  fs::write(repo.join("file.txt"), "external edit\n").unwrap();
  let result = git.mutate(
    repo,
    "partial-stage",
    &serde_json::from_value(json!({"paths":["file.txt"],"original":old_diff,"lines":[5]})).unwrap(),
  );
  assert!(result.unwrap_err().contains("diff changed"));
  assert_eq!(content(&git, repo, ":file.txt"), original);
}

#[test]
fn partial_hunks_handle_insertions_deletions_and_missing_final_newlines() {
  for (before, after) in [
    ("", "new\n"),
    ("old\n", ""),
    ("old", "new"),
    ("old\n", "old\nnew"),
    ("old", "old\nnew\n"),
    ("one\r\ntwo\r\n", "one\r\nchanged\r\n"),
  ] {
    let (temp, git) = repo();
    let repo = temp.path();
    commit(&git, repo, before, "Base");
    fs::write(repo.join("file.txt"), after).unwrap();
    for staged in [false, true] {
      let original = diff(&git, repo, staged);
      let indices: Vec<_> = original
        .split_terminator('\n')
        .enumerate()
        .filter(|(_, line)| {
          (line.starts_with('+') && !line.starts_with("+++")) || (line.starts_with('-') && !line.starts_with("---"))
        })
        .map(|(index, _)| index)
        .collect();
      action(
        &git,
        repo,
        "partial-stage",
        json!({"paths":["file.txt"],"original":original,"lines":indices,"staged":staged}),
      );
      assert_eq!(content(&git, repo, ":file.txt"), if staged { before } else { after });
      assert_eq!(fs::read_to_string(repo.join("file.txt")).unwrap(), after);
    }
  }
}
