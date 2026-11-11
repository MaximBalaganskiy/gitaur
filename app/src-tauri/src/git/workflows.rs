use super::{parsers, service::GitService, validation};
use crate::models::{
  conflict_content::ConflictContent, message_options::MessageOptions, mutation::Mutation, worktree::Worktree,
};
use std::{
  fs,
  io::Write,
  path::{Path, PathBuf},
};

impl GitService {
  fn conflict_stages(
    &self,
    repo: &Path,
    path: &str,
  ) -> Result<Vec<crate::models::conflict_stage::ConflictStage>, String> {
    let output = self.text(repo, &["ls-files", "-u", "-z", "--", path])?;
    let mut stages = Vec::new();
    for record in output.split_terminator('\0') {
      let (header, name) = record.split_once('\t').ok_or("Invalid conflict index entry.")?;
      if name != path {
        continue;
      }
      let fields: Vec<_> = header.split_whitespace().collect();
      if fields.len() != 3 {
        return Err("Invalid conflict index entry.".into());
      }
      stages.push(crate::models::conflict_stage::ConflictStage {
        mode: fields[0].into(),
        hash: fields[1].into(),
        stage: fields[2].parse().map_err(|_| "Invalid stage.")?,
      });
    }
    Ok(stages)
  }

  pub fn resolve_reference(&self, repo: &Path, reference: &str) -> Result<String, String> {
    if reference.is_empty() || reference.starts_with('-') || reference.contains('\0') {
      return Err("Select a commit or branch.".into());
    }
    let output = self.run(
      repo,
      &[
        "rev-parse",
        "--verify",
        "--end-of-options",
        &format!("{reference}^{{commit}}"),
      ],
      false,
    )?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().into())
  }

  pub fn worktrees(&self, repo: &Path) -> Result<Vec<Worktree>, String> {
    let output = self.run(repo, &["worktree", "list", "--porcelain", "-z"], false)?;
    let text = String::from_utf8_lossy(&output.stdout);
    let mut trees = Vec::new();
    for record in text.split("\0\0").filter(|record| !record.is_empty()) {
      let fields: Vec<_> = record.split('\0').collect();
      let value = |key: &str| {
        fields
          .iter()
          .find_map(|line| line.strip_prefix(key))
          .unwrap_or("")
          .to_owned()
      };
      trees.push(Worktree {
        path: value("worktree "),
        branch: value("branch ").trim_start_matches("refs/heads/").into(),
        head: value("HEAD "),
        locked: fields.iter().any(|line| line.starts_with("locked")),
        main: trees.is_empty(),
      });
    }
    Ok(trees)
  }

  pub fn message_options(&self, repo: &Path) -> Result<MessageOptions, String> {
    let output = self.run(repo, &["log", "-50", "--format=%B", "-z", "HEAD"], true)?;
    let mut recent = Vec::new();
    for message in String::from_utf8_lossy(&output.stdout)
      .split('\0')
      .map(str::trim)
      .filter(|value| !value.is_empty())
    {
      if !recent.iter().any(|value| value == message) {
        recent.push(message.to_owned());
      }
    }
    let config = self.run(repo, &["config", "--path", "--get", "commit.template"], true)?;
    let template = if config.status.success() {
      let value = String::from_utf8_lossy(&config.stdout);
      read_text(&repo.join(value.trim())).unwrap_or_default()
    } else {
      String::new()
    };
    let merge_path = self.run(repo, &["rev-parse", "--git-path", "MERGE_MSG"], false)?;
    let suggested = if self
      .run(repo, &["rev-parse", "--verify", "MERGE_HEAD"], true)?
      .status
      .success()
    {
      read_text(&repo.join(String::from_utf8_lossy(&merge_path.stdout).trim())).unwrap_or_default()
    } else {
      String::new()
    };
    Ok(MessageOptions {
      recent,
      template,
      suggested,
    })
  }

  pub fn conflict_content(&self, repo: &Path, path: &str) -> Result<ConflictContent, String> {
    let destination = safe_working_path(repo, path)?;
    self.ensure_conflict(repo, path)?;
    let stages = self.conflict_stages(repo, path)?;
    let submodule = stages.iter().any(|stage| stage.mode == "160000");
    let mut editable = true;
    let mut all_sides = true;
    let mut stage_text = |stage: u8| -> Result<String, String> {
      let object = format!(":{stage}:{path}");
      let size = self.run(repo, &["cat-file", "-s", &object], true)?;
      if !size.status.success() {
        all_sides = false;
        return Ok("[File absent on this side]".into());
      }
      if String::from_utf8_lossy(&size.stdout)
        .trim()
        .parse::<u64>()
        .unwrap_or(u64::MAX)
        > 1024 * 1024
      {
        editable = false;
        return Ok("[Large file: choose a side or resolve externally]".into());
      }
      let output = self.run(repo, &["show", &object], false)?;
      if output.stdout.len() > 1024 * 1024 || output.stdout.contains(&0) || std::str::from_utf8(&output.stdout).is_err()
      {
        editable = false;
        return Ok("[Binary or large file]".into());
      }
      Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    };
    let base = if submodule { String::new() } else { stage_text(1)? };
    let ours = if submodule { String::new() } else { stage_text(2)? };
    let theirs = if submodule { String::new() } else { stage_text(3)? };
    let working = match read_text(&destination) {
      Ok(text) => text,
      Err(_) => {
        editable = false;
        String::new()
      }
    };
    let preview = if editable && all_sides {
      self.conflict_preview(repo, &base, &ours, &theirs)
    } else {
      None
    };
    Ok(ConflictContent {
      base,
      ours,
      theirs,
      working,
      editable,
      preview,
      kind: if submodule {
        "submodule"
      } else if stages.iter().all(|stage| stage.stage != 2) || stages.iter().all(|stage| stage.stage != 3) {
        "delete/rename"
      } else if !editable {
        "binary/large"
      } else {
        "text"
      }
      .into(),
      stages,
    })
  }

  fn ensure_conflict(&self, repo: &Path, path: &str) -> Result<(), String> {
    let output = self.run(repo, &["ls-files", "-u", "-z", "--", path], false)?;
    if output.stdout.is_empty() {
      return Err("This file no longer has an unresolved conflict. Refresh and select it again.".into());
    }
    Ok(())
  }

  pub(super) fn workflow_action(&self, repo: &Path, action: &str, payload: &Mutation) -> Result<(), String> {
    match action {
      "merge" | "checkout-detached" => {
        self.require_idle(repo)?;
        let output = self.run(repo, &["status", "--porcelain=v1", "-z"], false)?;
        if !parsers::status(&String::from_utf8_lossy(&output.stdout)).is_empty() {
          return Err("Commit or stash changes before starting this operation.".into());
        }
        let reference = self.resolve_reference(repo, payload.reference.as_deref().ok_or("Select a reference.")?)?;
        if action == "checkout-detached" {
          self.run(repo, &["switch", "--detach", &reference], false)?;
        } else {
          let output = self.run(repo, &["merge", "--no-commit", "--no-ff", "--", &reference], true)?;
          if !output.status.success() {
            let conflicts = self.run(repo, &["ls-files", "-u"], false)?;
            if conflicts.stdout.is_empty() {
              return Err(String::from_utf8_lossy(&output.stderr).trim().into());
            }
          }
        }
      }
      "merge-abort" => {
        self.run(repo, &["merge", "--abort"], false)?;
      }
      "worktree-add" => {
        let directory = payload.directory.as_deref().ok_or("Enter a worktree folder.")?;
        if !Path::new(directory).is_absolute() {
          return Err("Choose an absolute worktree folder.".into());
        }
        let name = payload
          .name
          .as_deref()
          .filter(|value| !value.starts_with('-'))
          .ok_or("Enter a new branch name.")?;
        self.run(repo, &["check-ref-format", "--branch", name], false)?;
        let reference = self.resolve_reference(repo, payload.reference.as_deref().unwrap_or("HEAD"))?;
        self.run(
          repo,
          &["worktree", "add", "-b", name, "--", directory, &reference],
          false,
        )?;
      }
      "worktree-remove" => {
        let directory = payload.directory.as_deref().ok_or("Select a worktree.")?;
        let selected = dunce::canonicalize(directory).map_err(|error| error.to_string())?;
        let current = dunce::canonicalize(repo).map_err(|error| error.to_string())?;
        let trees = self.worktrees(repo)?;
        let tree = trees
          .iter()
          .find(|tree| dunce::canonicalize(&tree.path).ok().as_ref() == Some(&selected))
          .ok_or("Unknown worktree.")?;
        if tree.main || tree.locked || selected == current {
          return Err("The main, current, or locked worktree cannot be removed here.".into());
        }
        self.run(repo, &["worktree", "remove", "--", directory], false)?;
      }
      "ignore" => {
        let paths = payload
          .paths
          .as_ref()
          .filter(|paths| !paths.is_empty())
          .ok_or("Select untracked files to ignore.")?;
        let ignore_path = safe_working_path(repo, ".gitignore")?;
        let mut contents = if ignore_path.exists() {
          read_text(&ignore_path)?
        } else {
          String::new()
        };
        for path in paths {
          validation::path(path)?;
          if path.contains(['\r', '\n']) {
            return Err("Newlines in ignore paths are unsupported.".into());
          }
          let output = self.run(repo, &["status", "--porcelain=v1", "-z", "--", path], false)?;
          if !parsers::status(&String::from_utf8_lossy(&output.stdout))
            .iter()
            .any(|file| file.path == *path && file.index == "?")
          {
            return Err(
              "Only untracked files can be ignored here. Tracked files must be removed from the index explicitly."
                .into(),
            );
          }
          let mut pattern = String::from("/");
          for ch in path.chars() {
            if "\\*?[]!# ".contains(ch) {
              pattern.push('\\');
            }
            pattern.push(ch);
          }
          if !contents.lines().any(|line| line == pattern) {
            if !contents.is_empty() && !contents.ends_with('\n') {
              contents.push('\n');
            }
            contents.push_str(&pattern);
            contents.push('\n');
          }
        }
        fs::write(ignore_path, contents).map_err(|error| error.to_string())?;
      }
      "resolve" => {
        let path = payload
          .paths
          .as_ref()
          .and_then(|paths| paths.first())
          .ok_or("Select a conflicted file.")?;
        let destination = safe_working_path(repo, path)?;
        self.ensure_conflict(repo, path)?;
        let stages = self.conflict_stages(repo, path)?;
        let rename = payload
          .directory
          .as_deref()
          .filter(|value| !value.is_empty() && *value != path);
        let renamed = rename.map(|value| safe_working_path(repo, value)).transpose()?;
        if renamed.as_ref().is_some_and(|target| target.exists()) {
          return Err("The resolution destination already exists. Choose an unused path.".into());
        }
        match payload.choice.as_deref().unwrap_or("mark") {
          "delete" => {
            if stages.iter().any(|stage| stage.mode == "160000") {
              self.run(repo, &["update-index", "--force-remove", "--", path], false)?;
            } else {
              self.run(repo, &["rm", "-f", "--", path], false)?;
            }
            return Ok(());
          }
          "ours" | "theirs" => {
            let stage = if payload.choice.as_deref() == Some("ours") {
              "2"
            } else {
              "3"
            };
            if stages.iter().any(|item| item.mode == "160000") {
              if rename.is_some() {
                return Err("Resolve the submodule before renaming it.".into());
              }
              if let Some(item) = stages.iter().find(|item| item.stage.to_string() == stage) {
                self.run(
                  repo,
                  &[
                    "update-index",
                    "--add",
                    "--cacheinfo",
                    &format!("160000,{},{}", item.hash, path),
                  ],
                  false,
                )?;
              } else {
                self.run(repo, &["update-index", "--force-remove", "--", path], false)?;
              }
              return Ok(());
            }
            let available = self
              .run(repo, &["cat-file", "-e", &format!(":{stage}:{path}")], true)?
              .status
              .success();
            if available {
              self.run(
                repo,
                &[
                  "checkout",
                  &format!("--{}", payload.choice.as_deref().unwrap()),
                  "--",
                  path,
                ],
                false,
              )?;
            } else {
              self.run(repo, &["rm", "--", path], false)?;
              return Ok(());
            }
          }
          "edit" => {
            let original = payload.original.as_ref().ok_or("Reload the conflict before saving.")?;
            if read_text(&destination)? != *original {
              return Err("The file changed outside this editor. Reopen the conflict to avoid overwriting it.".into());
            }
            let text = payload.text.as_deref().ok_or("Enter the resolved content.")?;
            check_markers(text)?;
            let mut file = fs::OpenOptions::new()
              .write(true)
              .truncate(true)
              .open(&destination)
              .map_err(|error| error.to_string())?;
            file.write_all(text.as_bytes()).map_err(|error| error.to_string())?;
          }
          "mark" => {
            if destination.exists() {
              check_markers(&read_text(&destination)?)?;
            }
          }
          "mark-binary" => {
            let content = self.conflict_content(repo, path)?;
            if content.editable || content.kind == "submodule" {
              return Err("Use the text resolver for this file.".into());
            }
          }
          "submodule" => {
            if !stages.iter().any(|item| item.mode == "160000") {
              return Err("This is not a submodule conflict.".into());
            }
            if !destination.join(".git").exists() {
              return Err(
                "Initialize the submodule before selecting a custom commit, or choose an indexed side.".into(),
              );
            }
            let hash = self.resolve_reference(&destination, payload.reference.as_deref().unwrap_or("HEAD"))?;
            self.run(
              repo,
              &["update-index", "--add", "--cacheinfo", &format!("160000,{hash},{path}")],
              false,
            )?;
            return Ok(());
          }
          _ => return Err("Unknown resolution choice.".into()),
        }
        if let (Some(target), Some(name)) = (renamed, rename) {
          fs::rename(&destination, target).map_err(|error| error.to_string())?;
          self.run(repo, &["add", "-A", "--", path, name], false)?;
        } else {
          self.run(repo, &["add", "-A", "--", path], false)?;
        }
      }
      _ => return Err("Unknown workflow operation.".into()),
    }
    Ok(())
  }
}

fn check_markers(text: &str) -> Result<(), String> {
  if text.lines().any(|line| {
    let marker = line.as_bytes().first().copied().unwrap_or_default();
    if !b"<|=>".contains(&marker) {
      return false;
    }
    let width = line.bytes().take_while(|byte| *byte == marker).count();
    width >= 7 && (width == line.len() || line.as_bytes()[width].is_ascii_whitespace())
  }) {
    return Err("Remove conflict markers before marking the file resolved.".into());
  }
  Ok(())
}

fn read_text(path: &Path) -> Result<String, String> {
  if fs::metadata(path).map_err(|error| error.to_string())?.len() > 1024 * 1024 {
    return Err("Text file exceeds the 1 MiB editor limit.".into());
  }
  let text = fs::read_to_string(path).map_err(|error| error.to_string())?;
  if text.contains('\0') {
    return Err("Binary content cannot be edited as text.".into());
  }
  Ok(text)
}

pub(super) fn safe_working_path(repo: &Path, path: &str) -> Result<PathBuf, String> {
  validation::path(path)?;
  if path
    .split(['/', '\\'])
    .any(|part| part.trim_end_matches(['.', ' ']).eq_ignore_ascii_case(".git"))
  {
    return Err("Choose a working-file path outside Git's metadata directory.".into());
  }
  let target = repo.join(path);
  let parent = dunce::canonicalize(target.parent().ok_or("Invalid path.")?).map_err(|error| error.to_string())?;
  let root = dunce::canonicalize(repo).map_err(|error| error.to_string())?;
  if !parent.starts_with(root) || fs::symlink_metadata(&target).is_ok_and(|metadata| metadata.file_type().is_symlink())
  {
    return Err("Cannot write through a link outside the working tree.".into());
  }
  Ok(target)
}
