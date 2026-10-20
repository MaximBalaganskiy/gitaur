use gitaur_lib::{
  git::service::GitService,
  models::{mutation::Mutation, repository_request::RepositoryRequest},
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

fn text(git: &GitService, repo: &Path, args: &[&str]) -> String {
  String::from_utf8(git.run(repo, args, false).unwrap().stdout)
    .unwrap()
    .trim()
    .into()
}

fn action(git: &GitService, repo: &Path, action: &str, payload: Value) -> Result<bool, String> {
  git.mutate(repo, action, &serde_json::from_value::<Mutation>(payload).unwrap())
}

fn commit(git: &GitService, repo: &Path, file: &str, content: &str) -> String {
  fs::write(repo.join(file), content).unwrap();
  git.run(repo, &["add", "--", file], false).unwrap();
  git.run(repo, &["commit", "-m", content], false).unwrap();
  text(git, repo, &["rev-parse", "HEAD"])
}

fn payload(git: &GitService, repo: &Path, reference: &str) -> Value {
  json!({"reference": reference, "expected_head": text(git, repo, &["rev-parse", "HEAD"]), "expected_branch": text(git, repo, &["branch", "--show-current"])})
}

#[test]
fn create_and_clone_preserve_existing_files_and_reject_nested_or_nonempty_destinations() {
  let root = tempfile::tempdir().unwrap();
  let destination = root.path().join("new repo");
  fs::create_dir(&destination).unwrap();
  fs::write(destination.join("keep.txt"), "keep").unwrap();
  let git = GitService::default();
  let request = RepositoryRequest {
    directory: destination.to_str().unwrap().into(),
    url: None,
    branch: Some("trunk".into()),
  };
  assert!(git.create_repository(&request).is_ok());
  assert_eq!(fs::read_to_string(destination.join("keep.txt")).unwrap(), "keep");
  assert!(git.create_repository(&request).is_err());
  let nested = RepositoryRequest {
    directory: destination.join("nested").to_str().unwrap().into(),
    url: None,
    branch: None,
  };
  assert!(git.create_repository(&nested).is_err());
  git.run(&destination, &["config", "user.name", "Test"], false).unwrap();
  git
    .run(&destination, &["config", "user.email", "test@example.invalid"], false)
    .unwrap();
  git
    .run(&destination, &["config", "commit.gpgsign", "false"], false)
    .unwrap();
  commit(&git, &destination, "keep.txt", "base");
  let cloned = root.path().join("clone");
  let request = RepositoryRequest {
    directory: cloned.to_str().unwrap().into(),
    url: Some(destination.to_str().unwrap().into()),
    branch: None,
  };
  git.create_repository(&request).unwrap();
  assert_eq!(text(&git, &cloned, &["branch", "--show-current"]), "trunk");
  assert!(git.create_repository(&request).is_err());
}

#[test]
fn remote_branch_deletion_preserves_local_branches_and_rejects_stale_tips() {
  let (temp, git) = repo();
  let repo = temp.path();
  let first = commit(&git, repo, "file", "base");
  let remote = tempfile::tempdir().unwrap();
  git.run(remote.path(), &["init", "--bare"], false).unwrap();
  git
    .run(
      repo,
      &["remote", "add", "origin", remote.path().to_str().unwrap()],
      false,
    )
    .unwrap();
  git.run(repo, &["branch", "feature/topic"], false).unwrap();
  git.run(repo, &["push", "origin", "feature/topic"], false).unwrap();
  let second = commit(&git, repo, "file", "changed");
  git.run(repo, &["push", "origin", "main"], false).unwrap();
  let request = json!({"name":"origin/feature/topic", "reference":first});
  assert!(action(
    &git,
    repo,
    "branch-delete-remote",
    json!({"name":"origin/feature/topic", "reference":second})
  )
  .is_err());
  git
    .run(
      remote.path(),
      &["update-ref", "refs/heads/feature/topic", &second],
      false,
    )
    .unwrap();
  assert!(action(&git, repo, "branch-delete-remote", request.clone()).is_err());
  assert_eq!(
    text(&git, remote.path(), &["rev-parse", "refs/heads/feature/topic"]),
    second
  );
  assert_eq!(
    text(&git, repo, &["rev-parse", "refs/remotes/origin/feature/topic"]),
    first
  );
  git
    .run(
      repo,
      &[
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/feature/topic",
      ],
      false,
    )
    .unwrap();
  assert!(action(
    &git,
    repo,
    "branch-delete-remote",
    json!({"name":"origin/HEAD", "reference":first})
  )
  .is_err());
  assert!(action(
    &git,
    repo,
    "branch-delete-remote",
    json!({"name":"missing/topic", "reference":first})
  )
  .is_err());
  git
    .run(
      remote.path(),
      &["update-ref", "refs/heads/feature/topic", &first],
      false,
    )
    .unwrap();
  action(&git, repo, "branch-delete-remote", request).unwrap();
  assert!(git
    .run(
      remote.path(),
      &["show-ref", "--verify", "refs/heads/feature/topic"],
      false
    )
    .is_err());
  assert!(git
    .run(
      repo,
      &["show-ref", "--verify", "refs/remotes/origin/feature/topic"],
      false
    )
    .is_err());
  assert_eq!(text(&git, repo, &["rev-parse", "refs/heads/feature/topic"]), first);
  assert_eq!(text(&git, repo, &["rev-parse", "HEAD"]), second);
}

#[test]
fn branch_rename_delete_and_upstream_are_checked() {
  let (temp, git) = repo();
  let repo = temp.path();
  let hash = commit(&git, repo, "file", "base");
  git.run(repo, &["branch", "topic"], false).unwrap();
  action(
    &git,
    repo,
    "branch-rename",
    json!({"name":"topic","text":"renamed","reference":hash}),
  )
  .unwrap();
  assert!(
    git
      .run(repo, &["show-ref", "--verify", "refs/heads/topic"], true)
      .unwrap()
      .status
      .code()
      != Some(0)
  );
  assert!(action(
    &git,
    repo,
    "branch-delete",
    json!({"name":"main","reference":hash,"force":true})
  )
  .is_err());
  assert!(action(
    &git,
    repo,
    "branch-delete",
    json!({"name":"renamed","reference":"stale"})
  )
  .is_err());
  action(&git, repo, "branch-delete", json!({"name":"renamed","reference":hash})).unwrap();
  git.run(repo, &["remote", "add", "origin", "."], false).unwrap();
  git.run(repo, &["fetch", "origin"], false).unwrap();
  action(
    &git,
    repo,
    "branch-upstream",
    json!({"name":"main","reference":hash,"text":"refs/remotes/origin/main"}),
  )
  .unwrap();
  assert_eq!(
    text(&git, repo, &["rev-parse", "--abbrev-ref", "@{upstream}"]),
    "origin/main"
  );
  action(
    &git,
    repo,
    "branch-upstream",
    json!({"name":"main","reference":hash,"text":""}),
  )
  .unwrap();
  assert!(!git
    .run(repo, &["rev-parse", "@{upstream}"], true)
    .unwrap()
    .status
    .success());
}

#[test]
fn reset_modes_preserve_or_discard_as_requested_and_reject_stale_head() {
  let (temp, git) = repo();
  let repo = temp.path();
  let base = commit(&git, repo, "file", "base");
  let tip = commit(&git, repo, "file", "changed");
  let mut request = payload(&git, repo, &base);
  request["choice"] = json!("soft");
  action(&git, repo, "reset", request.clone()).unwrap();
  assert_eq!(text(&git, repo, &["show", ":file"]), "changed");
  assert!(action(&git, repo, "reset", request).is_err());
  let mut request = payload(&git, repo, &base);
  request["choice"] = json!("mixed");
  action(&git, repo, "reset", request).unwrap();
  assert_eq!(text(&git, repo, &["show", ":file"]), "base");
  assert_eq!(fs::read_to_string(repo.join("file")).unwrap(), "changed");
  let mut request = payload(&git, repo, &tip);
  request["choice"] = json!("hard");
  assert!(action(&git, repo, "reset", request.clone()).is_err());
  request["force"] = json!(true);
  fs::write(repo.join("untracked"), "keep").unwrap();
  assert!(action(&git, repo, "reset", request.clone()).is_err());
  fs::remove_file(repo.join("untracked")).unwrap();
  action(&git, repo, "reset", request).unwrap();
  assert_eq!(text(&git, repo, &["rev-parse", "HEAD"]), tip);
  assert!(text(&git, repo, &["status", "--porcelain"]).is_empty());
}

#[test]
fn cherry_pick_revert_conflict_continue_abort_and_skip() {
  let (temp, git) = repo();
  let repo = temp.path();
  commit(&git, repo, "file", "base");
  git.run(repo, &["switch", "-c", "topic"], false).unwrap();
  let picked = commit(&git, repo, "file", "topic");
  git.run(repo, &["switch", "main"], false).unwrap();
  action(&git, repo, "cherry-pick", payload(&git, repo, &picked)).unwrap();
  assert_eq!(fs::read_to_string(repo.join("file")).unwrap(), "topic");
  action(&git, repo, "revert", payload(&git, repo, "HEAD")).unwrap();
  assert_eq!(fs::read_to_string(repo.join("file")).unwrap(), "base");
  let before = commit(&git, repo, "file", "other");
  for control in ["operation-abort", "operation-skip", "operation-continue"] {
    action(&git, repo, "cherry-pick", payload(&git, repo, &picked)).unwrap();
    assert_eq!(git.snapshot(repo, 10).unwrap().operation, "Cherry-pick");
    assert!(action(&git, repo, "operation-continue", json!({"choice":"Rebase"})).is_err());
    if control == "operation-continue" {
      action(&git, repo, "resolve", json!({"paths":["file"],"choice":"theirs"})).unwrap();
      assert!(action(&git, repo, "commit", json!({"message":"wrong flow"})).is_err());
    }
    action(&git, repo, control, json!({"choice":"Cherry-pick"})).unwrap();
    assert!(git.snapshot(repo, 10).unwrap().operation.is_empty());
    if control != "operation-continue" {
      assert_eq!(text(&git, repo, &["rev-parse", "HEAD"]), before);
    }
  }
  assert_eq!(fs::read_to_string(repo.join("file")).unwrap(), "topic");
}

#[test]
fn rebase_conflict_can_abort_or_continue() {
  let (temp, git) = repo();
  let repo = temp.path();
  commit(&git, repo, "file", "base");
  git.run(repo, &["switch", "-c", "topic"], false).unwrap();
  let original = commit(&git, repo, "file", "topic");
  git.run(repo, &["switch", "main"], false).unwrap();
  let base = commit(&git, repo, "file", "main");
  git.run(repo, &["switch", "topic"], false).unwrap();
  action(&git, repo, "rebase", payload(&git, repo, &base)).unwrap();
  assert_eq!(git.snapshot(repo, 10).unwrap().operation, "Rebase");
  action(&git, repo, "operation-abort", json!({"choice":"Rebase"})).unwrap();
  assert_eq!(text(&git, repo, &["rev-parse", "HEAD"]), original);
  action(&git, repo, "rebase", payload(&git, repo, &base)).unwrap();
  action(&git, repo, "resolve", json!({"paths":["file"],"choice":"theirs"})).unwrap();
  action(&git, repo, "operation-continue", json!({"choice":"Rebase"})).unwrap();
  assert!(git.snapshot(repo, 10).unwrap().operation.is_empty());
  assert_eq!(text(&git, repo, &["rev-parse", "HEAD^"]), base);
}

#[test]
fn editable_rebase_applies_validated_reordering_fixups_squashes_and_drops() {
  std::env::set_var("BRANCHLIGHT_EDITOR_EXE", env!("CARGO_BIN_EXE_gitaur"));
  let (temp, git) = repo();
  let repo = temp.path();
  let base = commit(&git, repo, "base", "base");
  commit(&git, repo, "a", "A");
  commit(&git, repo, "b", "B");
  commit(&git, repo, "c", "C");
  commit(&git, repo, "d", "D");
  commit(&git, repo, "e", "E");
  let mut plan = git.rebase_plan(repo, &base).unwrap();
  plan.swap(0, 1);
  plan[1].action = "fixup".into();
  plan[2].action = "squash".into();
  plan[3].action = "drop".into();
  let mut request = payload(&git, repo, &base);
  request["plan"] = serde_json::to_value(&plan).unwrap();
  let mut invalid = request.clone();
  invalid["plan"][0]["action"] = json!("exec echo bad");
  assert!(action(&git, repo, "rebase-plan", invalid).is_err());
  action(&git, repo, "rebase-plan", request).unwrap();
  assert_eq!(text(&git, repo, &["rev-list", "--count", "HEAD"]), "3");
  assert_eq!(text(&git, repo, &["log", "-1", "--format=%B", "HEAD^"]), "B\n\nC");
  assert!(!repo.join("d").exists());
  assert!(repo.join("a").exists());
  assert!(git.snapshot(repo, 10).unwrap().operation.is_empty());
}

#[test]
fn remote_push_url_and_pruning_can_be_set_and_cleared() {
  let (temp, git) = repo();
  let repo = temp.path();
  action(&git, repo, "remote-add", json!({"name":"origin","url":"https://example.invalid/read.git","push_url":"ssh://example.invalid/write.git","prune":true})).unwrap();
  let remote = git.remotes(repo).unwrap().remove(0);
  assert!(remote.prune);
  assert_eq!(remote.push_url, "ssh://example.invalid/write.git");
  action(
    &git,
    repo,
    "remote-edit",
    json!({"name":"origin","url":"https://example.invalid/read.git","push_url":"","prune":false}),
  )
  .unwrap();
  let remote = git.remotes(repo).unwrap().remove(0);
  assert!(!remote.prune);
  assert!(remote.push_url.is_empty());
}

#[test]
fn hard_reset_preserves_ignored_files_that_would_be_overwritten() {
  let (temp, git) = repo();
  let repo = temp.path();
  let base = commit(&git, repo, ".gitignore", "output\n");
  fs::write(repo.join("output"), "committed output").unwrap();
  git.run(repo, &["add", "-f", "output"], false).unwrap();
  git.run(repo, &["commit", "-m", "Track output"], false).unwrap();
  let target = text(&git, repo, &["rev-parse", "HEAD"]);
  git.run(repo, &["reset", "--hard", &base], false).unwrap();
  fs::write(repo.join("output"), "valuable ignored output").unwrap();
  let mut request = payload(&git, repo, &target);
  request["choice"] = json!("hard");
  request["force"] = json!(true);
  assert!(action(&git, repo, "reset", request)
    .unwrap_err()
    .contains("ignored files"));
  assert_eq!(
    fs::read_to_string(repo.join("output")).unwrap(),
    "valuable ignored output"
  );
  assert_eq!(text(&git, repo, &["rev-parse", "HEAD"]), base);
}

#[test]
fn merge_replay_requires_mainline_and_dirty_history_operations_are_rejected() {
  let (temp, git) = repo();
  let repo = temp.path();
  let base = commit(&git, repo, "base", "base");
  git.run(repo, &["switch", "-c", "topic"], false).unwrap();
  commit(&git, repo, "topic", "topic");
  git.run(repo, &["switch", "main"], false).unwrap();
  commit(&git, repo, "main", "main");
  git
    .run(repo, &["merge", "--no-ff", "-m", "Merge topic", "topic"], false)
    .unwrap();
  let merge = text(&git, repo, &["rev-parse", "HEAD"]);
  assert!(git.rebase_plan(repo, &base).is_err());
  assert!(action(&git, repo, "revert", payload(&git, repo, &merge)).is_err());
  let mut request = payload(&git, repo, &merge);
  request["mainline"] = json!(1);
  action(&git, repo, "revert", request).unwrap();
  assert!(!repo.join("topic").exists());
  let mut request = payload(&git, repo, &merge);
  request["mainline"] = json!(1);
  action(&git, repo, "cherry-pick", request).unwrap();
  assert!(repo.join("topic").exists());
  fs::write(repo.join("main"), "dirty").unwrap();
  assert!(action(&git, repo, "rebase", payload(&git, repo, &base)).is_err());
  assert!(action(&git, repo, "revert", payload(&git, repo, "HEAD")).is_err());
  assert_eq!(fs::read_to_string(repo.join("main")).unwrap(), "dirty");
}

#[test]
fn branch_delete_rejects_unmerged_and_other_worktree_branches() {
  let (temp, git) = repo();
  let repo = temp.path();
  commit(&git, repo, "base", "base");
  git.run(repo, &["switch", "-c", "topic"], false).unwrap();
  let hash = commit(&git, repo, "topic", "topic");
  git.run(repo, &["switch", "main"], false).unwrap();
  let mut request = json!({"name":"topic", "reference":hash});
  assert!(action(&git, repo, "branch-delete", request.clone()).is_err());
  let other = tempfile::tempdir().unwrap();
  let directory = other.path().join("worktree");
  git
    .run(repo, &["worktree", "add", directory.to_str().unwrap(), "topic"], false)
    .unwrap();
  request["force"] = json!(true);
  assert!(action(&git, repo, "branch-delete", request.clone()).is_err());
  let mut rename = request.clone();
  rename["text"] = json!("renamed");
  assert!(action(&git, repo, "branch-rename", rename).is_err());
  git
    .run(repo, &["worktree", "remove", directory.to_str().unwrap()], false)
    .unwrap();
  action(&git, repo, "branch-delete", request).unwrap();
}

#[test]
fn edit_and_reword_pause_for_review_and_reject_stale_amends() {
  std::env::set_var("BRANCHLIGHT_EDITOR_EXE", env!("CARGO_BIN_EXE_gitaur"));
  let (temp, git) = repo();
  let repo = temp.path();
  let base = commit(&git, repo, "base", "Base");
  commit(&git, repo, "one", "One");
  commit(&git, repo, "two", "Two");
  let mut plan = git.rebase_plan(repo, &base).unwrap();
  plan[0].action = "reword".into();
  plan[1].action = "edit".into();
  let mut request = payload(&git, repo, &base);
  request["plan"] = serde_json::to_value(plan).unwrap();
  action(&git, repo, "rebase-plan", request).unwrap();
  let head = text(&git, repo, &["rev-parse", "HEAD"]);
  assert_eq!(text(&git, repo, &["show", "-s", "--format=%s"]), "One");
  assert!(action(
    &git,
    repo,
    "rebase-amend",
    json!({"expected_head":base,"message":"Bad"})
  )
  .is_err());
  action(
    &git,
    repo,
    "rebase-amend",
    json!({"expected_head":head,"message":"Reworded\n\nDescription"}),
  )
  .unwrap();
  action(&git, repo, "operation-continue", json!({"choice":"Rebase"})).unwrap();
  fs::write(repo.join("two"), "Edited two").unwrap();
  git.run(repo, &["add", "two"], false).unwrap();
  let head = text(&git, repo, &["rev-parse", "HEAD"]);
  action(
    &git,
    repo,
    "rebase-amend",
    json!({"expected_head":head,"message":"Edited"}),
  )
  .unwrap();
  action(&git, repo, "operation-continue", json!({"choice":"Rebase"})).unwrap();
  assert_eq!(text(&git, repo, &["show", "HEAD:two"]), "Edited two");
  assert_eq!(
    text(&git, repo, &["show", "-s", "--format=%B", "HEAD~1"]),
    "Reworded\n\nDescription"
  );
  assert!(action(
    &git,
    repo,
    "rebase-amend",
    json!({"expected_head":head,"message":"Bad"})
  )
  .is_err());
}
