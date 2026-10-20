use super::{parsers, sequence_editor, service::GitService};
use crate::models::{mutation::Mutation, rebase_step::RebaseStep};
use std::{collections::HashSet, fs, path::Path, process::Output};

impl GitService {
  pub(super) fn operation(&self, repo: &Path) -> Result<String, String> {
    let directory = self.text(repo, &["rev-parse", "--absolute-git-dir"])?;
    let directory = Path::new(directory.trim());
    for (file, name) in [
      ("rebase-merge", "Rebase"),
      ("rebase-apply", "Rebase"),
      ("MERGE_HEAD", "Merge"),
      ("CHERRY_PICK_HEAD", "Cherry-pick"),
      ("REVERT_HEAD", "Revert"),
    ] {
      if directory.join(file).exists() {
        return Ok(name.into());
      }
    }
    // A failed hook can leave a sequencer without CHERRY_PICK_HEAD/REVERT_HEAD.
    if let Ok(todo) = fs::read_to_string(directory.join("sequencer/todo")) {
      if todo.starts_with("pick ") {
        return Ok("Cherry-pick".into());
      }
      if todo.starts_with("revert ") {
        return Ok("Revert".into());
      }
    }
    Ok(String::new())
  }

  pub(super) fn validate_branch(&self, repo: &Path, name: &str) -> Result<(), String> {
    if name.is_empty() || name.starts_with('-') || name.contains(['\0', '\n', '\r']) || name.contains("@{") {
      return Err("Enter a valid branch name.".into());
    }
    self.run(repo, &["check-ref-format", &format!("refs/heads/{name}")], false)?;
    Ok(())
  }

  fn history_head(&self, repo: &Path, payload: &Mutation) -> Result<String, String> {
    self.require_idle(repo)?;
    let head = self.resolve_reference(repo, "HEAD")?;
    let branch = self.text(repo, &["symbolic-ref", "--quiet", "--short", "HEAD"])?;
    if payload.expected_head.as_deref() != Some(&head) || payload.expected_branch.as_deref() != Some(branch.trim()) {
      return Err("The current branch or HEAD changed. Reopen this operation and review it again.".into());
    }
    Ok(head)
  }

  fn require_clean(&self, repo: &Path) -> Result<(), String> {
    if !self.text(repo, &["status", "--porcelain=v1", "-z"])?.is_empty() {
      return Err("Commit or stash your changes before this operation.".into());
    }
    Ok(())
  }

  fn replay_result(&self, repo: &Path, output: Output) -> Result<(), String> {
    if output.status.success() {
      return Ok(());
    }
    if !self.operation(repo)?.is_empty() && !self.text(repo, &["ls-files", "--unmerged"])?.is_empty() {
      return Ok(());
    }
    Err(
      format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
      )
      .trim()
      .into(),
    )
  }

  pub fn rebase_plan(&self, repo: &Path, reference: &str) -> Result<Vec<RebaseStep>, String> {
    self.require_idle(repo)?;
    let base = self.resolve_reference(repo, reference)?;
    let range = format!("{base}..HEAD");
    let output = self.text(
      repo,
      &[
        "log",
        "--reverse",
        "--topo-order",
        "--format=%H%x00%P%x00%s",
        &range,
        "--",
      ],
    )?;
    let mut steps = Vec::new();
    for line in output.lines() {
      let fields: Vec<_> = line.splitn(3, '\0').collect();
      if fields.len() != 3 {
        return Err("Could not read the rebase plan.".into());
      }
      if fields[1].split_whitespace().count() > 1 {
        return Err("Editable rebase supports linear history. Use Rebase to preserve merge commits.".into());
      }
      steps.push(RebaseStep {
        hash: fields[0].into(),
        subject: fields[2].into(),
        action: "pick".into(),
      });
    }
    if steps.len() > 1000 {
      return Err("Choose a more recent base: editable plans are limited to 1,000 commits.".into());
    }
    Ok(steps)
  }

  fn apply_plan(&self, repo: &Path, base: &str, plan: &[RebaseStep]) -> Result<(), String> {
    let original = self.rebase_plan(repo, base)?;
    let expected: HashSet<_> = original.iter().map(|step| step.hash.as_str()).collect();
    let actual: HashSet<_> = plan.iter().map(|step| step.hash.as_str()).collect();
    if actual != expected || actual.len() != plan.len() || plan.is_empty() {
      return Err("The rebase plan changed or contains duplicate/unknown commits. Reload it.".into());
    }
    let mut picked = false;
    let mut todo = String::new();
    for step in plan {
      match step.action.as_str() {
        "pick" | "edit" | "reword" => picked = true,
        "drop" => {}
        "squash" | "fixup" if picked => {}
        _ => {
          return Err(
            "Each squash/fixup needs a preceding retained commit; choose pick, edit, reword, drop, squash or fixup."
              .into(),
          )
        }
      }
      // Reword pauses in the app, where the user can review and amend the full message.
      let action = if step.action == "reword" { "edit" } else { &step.action };
      todo.push_str(&format!("{action} {}\n", step.hash));
    }
    let directory = self.text(repo, &["rev-parse", "--absolute-git-dir"])?;
    let plan_path = Path::new(directory.trim()).join("gitaur-rebase-plan");
    // Create exclusively; never follow or overwrite an existing file/symlink in the Git directory.
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
      .write(true)
      .create_new(true)
      .open(&plan_path)
      .map_err(|error| error.to_string())?;
    file.write_all(todo.as_bytes()).map_err(|error| error.to_string())?;
    drop(file);
    let executable = std::env::var_os("GITAUR_EDITOR_EXE")
      .or_else(|| std::env::var_os("BRANCHLIGHT_EDITOR_EXE"))
      .map(std::path::PathBuf::from)
      .map(Ok)
      .unwrap_or_else(std::env::current_exe)
      .map_err(|error| error.to_string())?;
    let editor = format!("sequence.editor={}", sequence_editor::command(&executable, &plan_path));
    let result = self.run(
      repo,
      &[
        "-c",
        "core.editor=true",
        "-c",
        &editor,
        "rebase",
        "--interactive",
        "--no-autosquash",
        "--no-autostash",
        "--no-update-refs",
        base,
      ],
      true,
    );
    let _ = fs::remove_file(&plan_path);
    self.replay_result(repo, result?)
  }

  pub(super) fn history_action(&self, repo: &Path, action: &str, payload: &Mutation) -> Result<(), String> {
    if action == "rebase-amend" {
      if self.operation(repo)? != "Rebase" {
        return Err("No rebase is in progress.".into());
      }
      let directory = self.text(repo, &["rev-parse", "--absolute-git-dir"])?;
      if !Path::new(directory.trim()).join("rebase-merge/amend").is_file() {
        return Err("This rebase is not paused at an edit/reword step. Resolve conflicts and continue first.".into());
      }
      let head = self.resolve_reference(repo, "HEAD")?;
      if payload.expected_head.as_deref() != Some(&head) {
        return Err("HEAD changed. Reopen the paused commit.".into());
      }
      let message = payload
        .message
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or("Enter a commit message.")?;
      self.run(repo, &["commit", "--amend", "-m", message], false)?;
      return Ok(());
    }
    if action.starts_with("operation-") {
      let operation = self.operation(repo)?;
      if payload.choice.as_deref() != Some(&operation) {
        return Err("The operation changed. Refresh before continuing.".into());
      }
      let command = match operation.as_str() {
        "Rebase" => "rebase",
        "Cherry-pick" => "cherry-pick",
        "Revert" => "revert",
        "Merge" if action == "operation-abort" => "merge",
        _ => return Err("No supported operation is in progress.".into()),
      };
      let flag = match action {
        "operation-continue" => "--continue",
        "operation-skip" => "--skip",
        "operation-abort" => "--abort",
        _ => return Err("Unknown operation control.".into()),
      };
      return self.replay_result(repo, self.run(repo, &["-c", "core.editor=true", command, flag], true)?);
    }
    if action.starts_with("branch-") {
      self.require_idle(repo)?;
      if action == "branch-delete-remote" {
        let name = payload.name.as_deref().ok_or("Select a remote branch.")?;
        let remote = self
          .remotes(repo)?
          .into_iter()
          .filter(|remote| name.starts_with(&format!("{}/", remote.name)))
          .max_by_key(|remote| remote.name.len())
          .ok_or("Select a branch belonging to an existing remote.")?;
        let branch = &name[remote.name.len() + 1..];
        self.validate_branch(repo, branch)?;
        let tracking = format!("refs/remotes/{name}");
        if branch == "HEAD"
          || self
            .run(repo, &["symbolic-ref", "--quiet", &tracking], true)?
            .status
            .success()
        {
          return Err("Select a remote branch, not a symbolic reference.".into());
        }
        let hash = self.resolve_reference(repo, &tracking)?;
        if payload.reference.as_deref() != Some(&hash) {
          return Err("The branch tip changed. Reopen this dialog.".into());
        }
        let reference = format!("refs/heads/{branch}");
        self.run(
          repo,
          &[
            "push",
            &format!("--force-with-lease={reference}:{hash}"),
            "--",
            &remote.name,
            &format!(":{reference}"),
          ],
          false,
        )?;
        return Ok(());
      }
      let name = payload.name.as_deref().ok_or("Select a local branch.")?;
      self.validate_branch(repo, name)?;
      let reference = format!("refs/heads/{name}");
      let hash = self.resolve_reference(repo, &reference)?;
      if payload.reference.as_deref() != Some(&hash) {
        return Err("The branch tip changed. Reopen this dialog.".into());
      }
      match action {
        "branch-rename" => {
          let new_name = payload.text.as_deref().ok_or("Enter a new branch name.")?;
          self.validate_branch(repo, new_name)?;
          if self
            .worktrees(repo)?
            .iter()
            .any(|tree| tree.branch == name && Path::new(&tree.path) != repo)
          {
            return Err("This branch is checked out in another worktree. Rename it from that worktree.".into());
          }
          self.run(repo, &["branch", "-m", "--", name, new_name], false)?;
        }
        "branch-delete" => {
          let flag = if payload.force == Some(true) { "-D" } else { "-d" };
          self.run(repo, &["branch", flag, "--", name], false)?;
        }
        "branch-upstream" => {
          if let Some(upstream) = payload.text.as_deref().filter(|value| !value.is_empty()) {
            if !upstream.starts_with("refs/remotes/") {
              return Err("Choose a remote-tracking branch.".into());
            }
            self.resolve_reference(repo, upstream)?;
            self.run(
              repo,
              &["branch", &format!("--set-upstream-to={upstream}"), "--", name],
              false,
            )?;
          } else {
            self.run(repo, &["branch", "--unset-upstream", "--", name], false)?;
          }
        }
        _ => return Err("Unknown branch operation.".into()),
      }
      return Ok(());
    }
    self.history_head(repo, payload)?;
    let target = self.resolve_reference(repo, payload.reference.as_deref().ok_or("Select a commit or branch.")?)?;
    match action {
      "reset" => {
        let flag = match payload.choice.as_deref() {
          Some("soft") => "--soft",
          Some("mixed") => "--mixed",
          Some("hard") if payload.force == Some(true) => "--hard",
          _ => return Err("Choose a reset mode and confirm discarding changes for Hard reset.".into()),
        };
        let files = parsers::status(&self.text(repo, &["status", "--porcelain=v1", "-z", "--untracked-files=all"])?);
        if flag == "--hard" && files.iter().any(|file| file.index == "?") {
          return Err("Stash untracked files first; a hard reset could overwrite them.".into());
        }
        if flag == "--hard" {
          let ignored = self.text(repo, &["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])?;
          let target_files = self.text(repo, &["ls-tree", "-r", "--name-only", "-z", &target])?;
          let normalize = |path: &str| {
            if cfg!(windows) {
              path.to_lowercase()
            } else {
              path.to_owned()
            }
          };
          let targets: Vec<_> = target_files.split_terminator('\0').map(normalize).collect();
          for path in ignored.split_terminator('\0').map(normalize) {
            if targets.iter().any(|target| {
              target == &path || target.starts_with(&format!("{path}/")) || path.starts_with(&format!("{target}/"))
            }) {
              return Err("Move ignored files that overlap the target commit before a hard reset.".into());
            }
          }
        }
        self.run(repo, &["reset", flag, &target, "--"], false)?;
      }
      "cherry-pick" | "revert" => {
        self.require_clean(repo)?;
        let parents = self.text(repo, &["show", "-s", "--format=%P", &target])?;
        let count = parents.split_whitespace().count();
        let mainline = payload.mainline.unwrap_or(0);
        if count > 1 && !(1..=count).contains(&mainline) {
          return Err("Choose the mainline parent for this merge commit.".into());
        }
        let parent = mainline.to_string();
        let mut args = vec!["-c", "core.editor=true", action, "--no-edit"];
        if count > 1 {
          args.extend(["--mainline", &parent]);
        }
        args.push(&target);
        self.replay_result(repo, self.run(repo, &args, true)?)?;
      }
      "rebase" | "rebase-plan" => {
        self.require_clean(repo)?;
        if action == "rebase-plan" {
          self.apply_plan(
            repo,
            &target,
            payload.plan.as_deref().ok_or("Load a rebase plan first.")?,
          )?;
        } else {
          self.replay_result(
            repo,
            self.run(
              repo,
              &[
                "-c",
                "core.editor=true",
                "rebase",
                "--rebase-merges",
                "--no-autostash",
                "--no-update-refs",
                &target,
              ],
              true,
            )?,
          )?;
        }
      }
      _ => return Err("Unknown history operation.".into()),
    }
    Ok(())
  }
}
