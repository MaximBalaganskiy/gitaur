use super::{parsers, process, validation};
use crate::models::{
  branch::Branch, command_entry::CommandEntry, commit_file::CommitFile, detail::Detail, diff_request::DiffRequest,
  mutation::Mutation, remote::Remote, snapshot::Snapshot,
};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Output;
use std::sync::{Arc, Mutex};
use std::time::Instant;

#[derive(Default)]
pub struct GitService {
  logs: Mutex<HashMap<PathBuf, Vec<CommandEntry>>>,
  locks: Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>,
}

impl GitService {
  pub fn run(&self, repo: &Path, args: &[&str], allow_failure: bool) -> Result<Output, String> {
    self.run_input(repo, args, allow_failure, None)
  }

  pub(super) fn run_input(
    &self,
    repo: &Path,
    args: &[&str],
    allow_failure: bool,
    input: Option<&[u8]>,
  ) -> Result<Output, String> {
    let started = Instant::now();
    let output = process::execute_with_input(repo, args, input)?;
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let entry = CommandEntry {
      command: format!(
        "git {}",
        args
          .iter()
          .enumerate()
          .map(|(index, arg)| {
            if index > 0 && args[index - 1] == "-m" {
              "[commit message]"
            } else {
              arg
            }
          })
          .collect::<Vec<_>>()
          .join(" ")
      ),
      time: chrono::Utc::now().to_rfc3339(),
      duration: started.elapsed().as_millis(),
      exit_code: output.status.code().unwrap_or(-1),
      error: if output.status.success() {
        String::new()
      } else {
        stderr.chars().take(3000).collect()
      },
    };
    {
      let mut logs = self.logs.lock().map_err(|error| error.to_string())?;
      let entries = logs.entry(repo.to_owned()).or_default();
      entries.insert(0, entry);
      entries.truncate(100);
    }
    if !output.status.success() && !allow_failure {
      let message = if stderr.trim().is_empty() {
        String::from_utf8_lossy(&output.stdout).into_owned()
      } else {
        stderr
      };
      return Err(if message.trim().is_empty() {
        format!("Git exited with {}.", output.status)
      } else {
        message.trim().to_owned()
      });
    }
    Ok(output)
  }

  pub(super) fn text(&self, repo: &Path, args: &[&str]) -> Result<String, String> {
    Ok(String::from_utf8_lossy(&self.run(repo, args, false)?.stdout).into_owned())
  }

  pub fn log(&self, repo: &Path) -> Result<Vec<CommandEntry>, String> {
    Ok(
      self
        .logs
        .lock()
        .map_err(|error| error.to_string())?
        .get(repo)
        .cloned()
        .unwrap_or_default(),
    )
  }

  pub fn open(&self, directory: &Path) -> Result<PathBuf, String> {
    if !directory.is_absolute() {
      return Err("Choose an absolute repository path.".into());
    }
    let root = self.text(directory, &["rev-parse", "--show-toplevel"])?;
    dunce::canonicalize(root.trim()).map_err(|error| error.to_string())
  }

  pub fn remotes(&self, repo: &Path) -> Result<Vec<Remote>, String> {
    let output = self.run(repo, &["config", "--null", "--get-regexp", r"^remote\..*\.url$"], true)?;
    if !output.status.success() && output.status.code() != Some(1) {
      return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }
    let mut remotes = std::collections::BTreeMap::new();
    let text = String::from_utf8_lossy(&output.stdout);
    for record in text.split('\0') {
      if let Some((key, url)) = record.split_once('\n') {
        if let Some(name) = key.strip_prefix("remote.").and_then(|key| key.strip_suffix(".url")) {
          remotes.entry(name.to_owned()).or_insert_with(|| url.to_owned());
        }
      }
    }
    remotes
      .into_iter()
      .map(|(name, url)| {
        let push = self.run(repo, &["config", "--get", &format!("remote.{name}.pushurl")], true)?;
        let prune = self.run(
          repo,
          &["config", "--type=bool", "--get", &format!("remote.{name}.prune")],
          true,
        )?;
        Ok(Remote {
          name,
          url,
          push_url: String::from_utf8_lossy(&push.stdout).trim().into(),
          prune: String::from_utf8_lossy(&prune.stdout).trim() == "true",
        })
      })
      .collect()
  }

  pub fn snapshot(&self, repo: &Path, limit: usize) -> Result<Snapshot, String> {
    let limit = limit.clamp(1, 100_000);
    let (status, refs, head, symbolic) = std::thread::scope(|scope| {
      let status = scope.spawn(|| self.text(repo, &["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
      let refs = scope.spawn(|| {
        self.text(
          repo,
          &[
            "for-each-ref",
            "--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(upstream:track)%00%(*objectname)",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
          ],
        )
      });
      let head = scope.spawn(|| self.run(repo, &["rev-parse", "--verify", "HEAD"], true));
      let symbolic = scope.spawn(|| self.run(repo, &["symbolic-ref", "--quiet", "--short", "HEAD"], true));
      (
        status.join().unwrap(),
        refs.join().unwrap(),
        head.join().unwrap(),
        symbolic.join().unwrap(),
      )
    });
    let status = status?;
    let refs = refs?;
    let head = head?;
    let symbolic = symbolic?;
    let branches: Vec<Branch> = refs
      .lines()
      .filter_map(|line| {
        let fields: Vec<_> = line.trim_end_matches('\r').split('\0').collect();
        if fields.len() < 5 {
          return None;
        }
        let (prefix, kind) = if fields[0].starts_with("refs/heads/") {
          ("refs/heads/", "local")
        } else if fields[0].starts_with("refs/remotes/") {
          ("refs/remotes/", "remote")
        } else {
          ("refs/tags/", "tag")
        };
        Some(Branch {
          full_name: fields[0].into(),
          name: fields[0].trim_start_matches(prefix).into(),
          hash: if fields[4].is_empty() { fields[1] } else { fields[4] }.into(),
          upstream: fields[2].into(),
          tracking: fields[3].into(),
          kind: kind.into(),
        })
      })
      .collect();
    let mut commits = Vec::new();
    if !branches.is_empty() || head.status.success() {
      let count = format!("--max-count={}", limit + 1);
      let mut args = vec!["log", "--all"];
      if head.status.success() {
        args.push("HEAD");
      }
      args.extend([
        "--date-order",
        &count,
        "-z",
        "--format=%H%x00%P%x00%an%x00%aI%x00%s%x00%D",
      ]);
      commits = parsers::log(&self.text(repo, &args)?);
    }
    let has_more = commits.len() > limit;
    commits.truncate(limit);
    let operation = self.operation(repo)?;
    Ok(Snapshot {
      path: repo.to_string_lossy().into_owned(),
      name: repo.file_name().unwrap_or_default().to_string_lossy().into_owned(),
      branch: if symbolic.status.success() {
        String::from_utf8_lossy(&symbolic.stdout).trim().into()
      } else {
        "Detached HEAD".into()
      },
      head: if head.status.success() {
        String::from_utf8_lossy(&head.stdout).trim().into()
      } else {
        String::new()
      },
      files: parsers::status(&status),
      branches,
      commits,
      has_more,
      operation,
    })
  }

  pub(super) fn parents(&self, repo: &Path, hash: &str) -> Result<Vec<String>, String> {
    validation::hash(hash)?;
    Ok(
      self
        .text(repo, &["show", "-s", "--format=%P", hash])?
        .split_whitespace()
        .map(str::to_owned)
        .collect(),
    )
  }

  pub fn detail(&self, repo: &Path, hash: &str) -> Result<Detail, String> {
    validation::hash(hash)?;
    let parents = self.parents(repo, hash)?;
    let mut args = vec![
      "diff-tree",
      "--root",
      "--no-commit-id",
      "--name-status",
      "-r",
      "-z",
      "--no-renames",
    ];
    if let Some(parent) = parents.first() {
      args.push(parent);
    }
    args.push(hash);
    let names = self.text(repo, &args)?;
    let files = names
      .split('\0')
      .collect::<Vec<_>>()
      .as_chunks::<2>()
      .0
      .iter()
      .filter(|fields| !fields[0].is_empty())
      .map(|fields| CommitFile {
        status: fields[0].into(),
        path: fields[1].into(),
      })
      .collect();
    let refs = self.text(
      repo,
      &[
        "for-each-ref",
        "--contains",
        hash,
        "--sort=refname",
        "--format=%(refname)%00%(symref)",
        "refs/heads",
        "refs/remotes",
      ],
    )?;
    let mut local_branches = Vec::new();
    let mut remote_branches = Vec::new();
    for line in refs.lines() {
      let Some((reference, symbolic)) = line.trim_end_matches('\r').split_once('\0') else {
        continue;
      };
      if !symbolic.is_empty() {
        continue;
      }
      if let Some(name) = reference.strip_prefix("refs/heads/") {
        local_branches.push(name.to_owned());
      } else if let Some(name) = reference.strip_prefix("refs/remotes/") {
        remote_branches.push(name.to_owned());
      }
    }
    Ok(Detail {
      message: self.text(repo, &["show", "-s", "--format=%B", hash])?.trim_end().into(),
      files,
      local_branches,
      remote_branches,
    })
  }

  pub fn diff(&self, repo: &Path, request: &DiffRequest) -> Result<String, String> {
    validation::path(&request.path)?;
    if let Some(original_path) = &request.original_path {
      validation::path(original_path)?;
    }
    if let Some(hash) = &request.hash {
      let parents = self.parents(repo, hash)?;
      let mut args = if let Some(parent) = parents.first() {
        vec!["diff", parent, hash]
      } else {
        vec!["show", "--format=", hash]
      };
      if request.full_file {
        args.push("--unified=2147483647");
      }
      args.extend([
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--",
        &request.path,
      ]);
      return self.text(repo, &args);
    }
    if request.untracked {
      let full = dunce::canonicalize(repo.join(&request.path)).map_err(|error| error.to_string())?;
      if !full.starts_with(repo) {
        return Err("File points outside the repository.".into());
      }
      let metadata = fs::metadata(&full).map_err(|error| error.to_string())?;
      if !metadata.is_file() {
        return Ok("This entry is not a regular file.".into());
      }
      if metadata.len() > 1024 * 1024 {
        return Ok("This file exceeds the 1 MB preview limit.".into());
      }
      let data = fs::read(full).map_err(|error| error.to_string())?;
      if data.contains(&0) {
        return Ok("Binary file — no text preview.".into());
      }
      let content = String::from_utf8_lossy(&data);
      let lines: Vec<_> = content.split_terminator('\n').collect();
      return Ok(format!(
        "--- /dev/null\n+++ b/{}\n@@ -0,0 +1,{} @@\n{}",
        request.path,
        lines.len(),
        lines
          .iter()
          .map(|line| format!("+{line}"))
          .collect::<Vec<_>>()
          .join("\n")
      ));
    }
    let mut args = vec![
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--src-prefix=a/",
      "--dst-prefix=b/",
    ];
    if request.staged {
      args.push("--cached");
    }
    if request.full_file {
      args.push("--unified=2147483647");
    }
    args.extend(["--", &request.path]);
    if let Some(original_path) = &request.original_path {
      args.push(original_path);
    }
    self.text(repo, &args)
  }

  pub fn mutate(&self, repo: &Path, action: &str, payload: &Mutation) -> Result<bool, String> {
    let lock = self
      .locks
      .lock()
      .map_err(|error| error.to_string())?
      .entry(repo.to_owned())
      .or_default()
      .clone();
    let _guard = lock
      .try_lock()
      .map_err(|_| "Another Git operation is running for this repository.")?;
    match action {
      "reflog-recover" | "tag-create" | "tag-delete" | "tag-push" | "tag-delete-remote" | "submodule-add"
      | "submodule-update" | "submodule-sync" | "submodule-remove" | "lfs-install" | "lfs-track" | "lfs-untrack"
      | "lfs-pull" | "lfs-fetch" | "lfs-push" => {
        self.repository_tool_action(repo, action, payload)?;
      }
      "branch-rename"
      | "branch-delete"
      | "branch-delete-remote"
      | "branch-upstream"
      | "reset"
      | "cherry-pick"
      | "revert"
      | "rebase"
      | "rebase-plan"
      | "rebase-amend"
      | "operation-continue"
      | "operation-skip"
      | "operation-abort" => {
        self.history_action(repo, action, payload)?;
      }
      "publish" | "stash-save" | "stash-apply" | "stash-pop" | "stash-drop" | "amend" | "undo-commit"
      | "partial-stage" | "partial-reset" | "reset-file" => {
        self.daily_action(repo, action, payload)?;
      }
      "remote-remove" => {
        let name = payload
          .name
          .as_deref()
          .filter(|name| !name.is_empty() && !name.starts_with('-'))
          .ok_or("Select a remote.")?;
        self.run(repo, &["check-ref-format", &format!("refs/remotes/{name}/HEAD")], false)?;
        self.run(repo, &["remote", "remove", "--", name], false)?;
      }
      "remote-add" | "remote-edit" => {
        let name = payload
          .name
          .as_deref()
          .filter(|name| !name.is_empty() && !name.starts_with('-'))
          .ok_or("Enter a remote name.")?;
        self.run(repo, &["check-ref-format", &format!("refs/remotes/{name}/HEAD")], false)?;
        let url = payload
          .url
          .as_deref()
          .filter(|url| !url.trim().is_empty() && !url.contains(['\0', '\r', '\n']))
          .ok_or("Enter a remote URL or local repository path.")?;
        let args = if action == "remote-add" {
          vec!["remote", "add", "--", name, url.trim()]
        } else {
          vec!["remote", "set-url", "--", name, url.trim()]
        };
        if payload
          .push_url
          .as_deref()
          .is_some_and(|url| url.contains(['\0', '\r', '\n']))
        {
          return Err("Enter a valid push URL.".into());
        }
        self.run(repo, &args, false)?;
        if let Some(push_url) = &payload.push_url {
          let key = format!("remote.{name}.pushurl");
          if push_url.trim().is_empty() {
            let output = self.run(repo, &["config", "--unset-all", &key], true)?;
            if !output.status.success() && output.status.code() != Some(5) {
              return Err(String::from_utf8_lossy(&output.stderr).into());
            }
          } else {
            self.run(repo, &["config", "--replace-all", &key, push_url.trim()], false)?;
          }
        }
        if let Some(prune) = payload.prune {
          self.run(
            repo,
            &[
              "config",
              &format!("remote.{name}.prune"),
              if prune { "true" } else { "false" },
            ],
            false,
          )?;
        }
      }
      "remote-fetch" => {
        let name = payload.name.as_deref().ok_or("Select a remote.")?;
        if !self.remotes(repo)?.iter().any(|remote| remote.name == name) {
          return Err("Select an existing remote.".into());
        }
        self.run(repo, &["fetch", "--", name], false)?;
      }
      "stage" | "unstage" => {
        let paths = payload
          .paths
          .as_ref()
          .filter(|paths| !paths.is_empty())
          .ok_or("Select files first.")?;
        for path in paths {
          validation::path(path)?;
        }
        let mut args = if action == "stage" {
          vec!["add", "--"]
        } else if self
          .run(repo, &["rev-parse", "--verify", "HEAD"], true)?
          .status
          .success()
        {
          vec!["restore", "--staged", "--"]
        } else {
          vec!["rm", "--cached", "-f", "--"]
        };
        args.extend(paths.iter().map(String::as_str));
        self.run(repo, &args, false)?;
      }
      "merge" | "merge-abort" | "resolve" | "ignore" | "worktree-add" | "worktree-remove" | "checkout-detached" => {
        self.workflow_action(repo, action, payload)?;
      }
      "commit" => {
        let operation = self.operation(repo)?;
        if !operation.is_empty() && operation != "Merge" {
          return Err("Use Continue to finish the current operation.".into());
        }
        let message = payload
          .message
          .as_ref()
          .filter(|message| !message.trim().is_empty())
          .ok_or("Enter a commit message.")?;
        let staged = self.run(repo, &["diff", "--cached", "--quiet"], true)?;
        match staged.status.code() {
          Some(0)
            if self
              .run(repo, &["rev-parse", "--verify", "MERGE_HEAD"], true)?
              .status
              .success() => {}
          Some(0) => return Err("Stage changes before committing.".into()),
          Some(1) => {}
          _ => return Err("Could not inspect staged changes.".into()),
        }
        self.run(repo, &["commit", "-m", message], false)?;
      }
      "checkout" | "branch" => {
        self.require_idle(repo)?;
        let name = payload
          .name
          .as_ref()
          .filter(|name| !name.is_empty() && !name.starts_with('-'))
          .ok_or("Invalid branch name.")?;
        self.run(repo, &["check-ref-format", "--branch", name], false)?;
        if !parsers::status(&self.text(repo, &["status", "--porcelain=v1", "-z"])?).is_empty() {
          return Err("Commit or stash your changes before switching branches.".into());
        }
        if action == "checkout" {
          if let Some(reference) = payload.reference.as_deref() {
            if !reference.starts_with("refs/remotes/") || reference.ends_with("/HEAD") {
              return Err("Select a remote branch to check out.".into());
            }
            self.run(repo, &["show-ref", "--verify", reference], false)?;
            let branches = self.text(
              repo,
              &[
                "for-each-ref",
                "--format=%(refname:lstrip=2)%00%(upstream)%00%(upstream:remotename)",
                "refs/heads/",
              ],
            )?;
            let tracking = branches.lines().find_map(|line| {
              let mut fields = line.split('\0');
              let local = fields.next()?;
              let upstream = fields.next()?;
              let remote = fields.next()?;
              (upstream == reference).then_some((local, remote))
            });
            if let Some((local, remote)) = tracking {
              self.run(repo, &["fetch", "--", remote], false)?;
              self.run(repo, &["switch", "--no-guess", "--", local], false)?;
            } else {
              self.run(repo, &["switch", "--track", "--", reference], false)?;
            }
            return Ok(true);
          }
        }
        let reference = payload
          .reference
          .as_deref()
          .map(|reference| self.resolve_reference(repo, reference))
          .transpose()?;
        let mut args = if action == "branch" {
          vec!["switch", "-c", name]
        } else {
          vec!["switch", name]
        };
        if action == "branch" {
          if let Some(reference) = &reference {
            args.push(reference);
          }
        }
        self.run(repo, &args, false)?;
      }
      "fetch" => {
        self.run(repo, &["fetch", "--all"], false)?;
      }
      "pull" => {
        self.run(repo, &["pull", "--ff-only"], false)?;
      }
      "push" => {
        let branch = self.text(repo, &["symbolic-ref", "--quiet", "HEAD"])?;
        let upstream = self.text(
          repo,
          &[
            "for-each-ref",
            "--format=%(upstream:remotename)%00%(upstream:remoteref)",
            branch.trim(),
          ],
        )?;
        let (remote, reference) = upstream
          .trim()
          .split_once('\0')
          .ok_or("Publish this branch first to configure its upstream.")?;
        if remote.is_empty() || reference.is_empty() || remote.starts_with('-') || !reference.starts_with("refs/heads/")
        {
          return Err("Publish this branch first to configure its upstream.".into());
        }
        self.run(repo, &["push", "--", remote, &format!("HEAD:{reference}")], false)?;
      }
      _ => return Err("Unsupported Git operation.".into()),
    }
    Ok(true)
  }
}
