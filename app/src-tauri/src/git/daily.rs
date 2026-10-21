use super::{service::GitService, validation};
use crate::models::{mutation::Mutation, stash::Stash};
use std::path::Path;

impl GitService {
  pub fn stashes(&self, repo: &Path) -> Result<Vec<Stash>, String> {
    let output = self.run(
      repo,
      &["stash", "list", "--format=%H%x00%gd%x00%gs%x00%cI", "-z"],
      false,
    )?;
    let text = String::from_utf8_lossy(&output.stdout);
    Ok(
      text
        .split_terminator('\0')
        .collect::<Vec<_>>()
        .as_chunks::<4>()
        .0
        .iter()
        .map(|fields| Stash {
          hash: fields[0].into(),
          reference: fields[1].into(),
          message: fields[2].into(),
          date: fields[3].into(),
        })
        .collect(),
    )
  }

  pub fn stash_diff(&self, repo: &Path, hash: &str) -> Result<String, String> {
    self.stash_reference(repo, hash)?;
    let output = self.run(
      repo,
      &[
        "stash",
        "show",
        "--patch",
        "--include-untracked",
        "--no-ext-diff",
        "--no-textconv",
        hash,
      ],
      false,
    )?;
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
  }

  fn stash_reference(&self, repo: &Path, hash: &str) -> Result<String, String> {
    validation::hash(hash)?;
    self
      .stashes(repo)?
      .into_iter()
      .find(|stash| stash.hash == hash)
      .map(|stash| stash.reference)
      .ok_or("This stash no longer exists. Refresh the list.".into())
  }

  pub(super) fn require_idle(&self, repo: &Path) -> Result<(), String> {
    if !self.operation(repo)?.is_empty() {
      return Err("Finish or abort the current Git operation first.".into());
    }
    Ok(())
  }

  fn check_head(&self, repo: &Path, payload: &Mutation) -> Result<String, String> {
    self.require_idle(repo)?;
    let head = self.resolve_reference(repo, "HEAD")?;
    if payload.reference.as_deref() != Some(&head) {
      return Err("HEAD changed. Refresh and review the commit again.".into());
    }
    Ok(head)
  }

  pub(super) fn daily_action(&self, repo: &Path, action: &str, payload: &Mutation) -> Result<(), String> {
    match action {
      "publish" => {
        let remote = payload.name.as_deref().ok_or("Choose a remote.")?;
        if !self.remotes(repo)?.iter().any(|item| item.name == remote) || remote.starts_with('-') {
          return Err("Choose an existing remote.".into());
        }
        let branch = payload
          .text
          .as_deref()
          .filter(|name| !name.starts_with('-'))
          .ok_or("Enter a remote branch name.")?;
        self.run(repo, &["check-ref-format", "--branch", branch], false)?;
        let current = self.run(repo, &["symbolic-ref", "--quiet", "--short", "HEAD"], false)?;
        if payload.reference.as_deref() != Some(String::from_utf8_lossy(&current.stdout).trim()) {
          return Err("The current branch changed. Reopen Publish branch.".into());
        }
        let target = format!("HEAD:refs/heads/{branch}");
        self.run(repo, &["push", "--set-upstream", "--", remote, &target], false)?;
      }
      "stash-save" => {
        self.require_idle(repo)?;
        if !self
          .snapshot(repo, 1)?
          .files
          .iter()
          .any(|file| file.index != "?" || payload.include_untracked.unwrap_or(false))
        {
          return Err("No changes to stash. Select Include untracked files to save new files.".into());
        }
        // Stash creates its own pathspecs when cleaning untracked files. No user paths are passed here.
        let mut args = vec!["--no-literal-pathspecs", "stash", "push"];
        if payload.include_untracked.unwrap_or(false) {
          args.push("--include-untracked");
        }
        if let Some(message) = payload.message.as_deref().filter(|value| !value.trim().is_empty()) {
          args.extend(["-m", message]);
        }
        self.run(repo, &args, false)?;
      }
      "stash-apply" | "stash-pop" | "stash-drop" => {
        let hash = payload.reference.as_deref().ok_or("Choose a stash.")?;
        let reference = self.stash_reference(repo, hash)?;
        if action == "stash-drop" {
          self.run(repo, &["stash", "drop", &reference], false)?;
        } else {
          self.require_idle(repo)?;
          if !self
            .run(repo, &["status", "--porcelain=v1", "-z"], false)?
            .stdout
            .is_empty()
          {
            return Err("Commit or stash current changes before applying a stash.".into());
          }
          // Apply the immutable object first. A failed apply leaves the stash available for recovery.
          self.run(repo, &["stash", "apply", "--index", hash], false)?;
          if action == "stash-pop" {
            let reference = self.stash_reference(repo, hash)?;
            self.run(repo, &["stash", "drop", &reference], false)?;
          }
        }
      }
      "amend" => {
        self.check_head(repo, payload)?;
        let message = payload
          .message
          .as_deref()
          .filter(|message| !message.trim().is_empty())
          .ok_or("Enter a commit message.")?;
        self.run(repo, &["commit", "--amend", "-m", message], false)?;
      }
      "undo-commit" => {
        let head = self.check_head(repo, payload)?;
        let output = self.run(repo, &["rev-list", "--parents", "-1", &head], false)?;
        let text = String::from_utf8_lossy(&output.stdout);
        let parents: Vec<_> = text.split_whitespace().skip(1).collect();
        if parents.len() != 1 {
          return Err("Undo is supported for a normal commit with one parent. Root and merge commits need an explicit reset workflow.".into());
        }
        self.run(repo, &["reset", "--soft", parents[0]], false)?;
      }
      "partial-stage" => self.apply_partial(repo, payload, false)?,
      "partial-reset" => self.apply_partial(repo, payload, true)?,
      "reset-file" => self.reset_file(repo, payload)?,
      _ => return Err("Unsupported daily operation.".into()),
    }
    Ok(())
  }
}
