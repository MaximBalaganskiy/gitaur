use super::{service::GitService, validation};
use crate::models::mutation::Mutation;
use std::{collections::HashSet, path::Path};

impl GitService {
  pub(super) fn apply_partial(&self, repo: &Path, payload: &Mutation, reset: bool) -> Result<(), String> {
    let path = payload
      .paths
      .as_ref()
      .filter(|paths| paths.len() == 1)
      .and_then(|paths| paths.first())
      .ok_or("Select one file.")?;
    validation::path(path)?;
    let staged = payload.staged.unwrap_or(false);
    if reset && staged {
      return Err("Unstage changes before resetting them.".into());
    }
    let snapshot = self.snapshot(repo, 1)?;
    let file = snapshot
      .files
      .iter()
      .find(|file| file.path == *path)
      .ok_or("The file changed. Refresh the diff.")?;
    let status = if staged { &file.index } else { &file.worktree };
    if file.conflict || status != "M" || file.original_path.is_some() {
      return Err(
        "Select a modified text file. Added, deleted, renamed and conflicted files must be staged as whole files."
          .into(),
      );
    }
    let mut args = vec![
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--src-prefix=a/",
      "--dst-prefix=b/",
    ];
    if staged {
      args.push("--cached");
    }
    if payload.full_file.unwrap_or(false) {
      args.push("--unified=2147483647");
    }
    args.extend(["--", path]);
    let current = String::from_utf8(self.run(repo, &args, false)?.stdout)
      .map_err(|_| "Partial staging requires UTF-8 text. Stage this file as a whole.")?;
    if payload.original.as_deref() != Some(&current) {
      return Err(
        "The diff changed since it was displayed. Review the refreshed diff and select the changes again.".into(),
      );
    }
    let selection = payload
      .lines
      .as_ref()
      .filter(|lines| !lines.is_empty())
      .ok_or("Select changed lines or a hunk.")?;
    let patch = selected_patch(&current, selection, staged || reset)?;
    let args = if reset {
      vec!["apply", "--unidiff-zero", "--whitespace=nowarn", "-"]
    } else {
      vec!["apply", "--cached", "--unidiff-zero", "--whitespace=nowarn", "-"]
    };
    self.run_input(repo, &args, false, Some(patch.as_bytes()))?;
    Ok(())
  }

  pub(super) fn reset_file(&self, repo: &Path, payload: &Mutation) -> Result<(), String> {
    let path = payload
      .paths
      .as_ref()
      .filter(|paths| paths.len() == 1)
      .and_then(|paths| paths.first())
      .ok_or("Select one file.")?;
    validation::path(path)?;
    if payload.staged.unwrap_or(false) {
      return Err("Unstage changes before resetting them.".into());
    }
    let snapshot = self.snapshot(repo, 1)?;
    let file = snapshot
      .files
      .iter()
      .find(|file| file.path == *path)
      .ok_or("The file changed. Refresh the diff.")?;
    if file.conflict || file.index == "?" || file.original_path.is_some() || !file.unstaged {
      return Err("Select an unstaged tracked file without conflicts or renames.".into());
    }
    let current = self.diff(
      repo,
      &crate::models::diff_request::DiffRequest {
        path: path.clone(),
        full_file: payload.full_file.unwrap_or(false),
        ..Default::default()
      },
    )?;
    if payload.original.as_deref() != Some(&current) {
      return Err("The diff changed since it was displayed. Review the refreshed diff and try again.".into());
    }
    self.run(
      repo,
      &["--literal-pathspecs", "restore", "--worktree", "--", path],
      false,
    )?;
    Ok(())
  }
}

fn selected_patch(diff: &str, selection: &[usize], reverse: bool) -> Result<String, String> {
  let lines: Vec<_> = diff.split_terminator('\n').collect();
  if lines.iter().any(|line| {
    line.starts_with("old mode ")
      || line.starts_with("new mode ")
      || line.starts_with("Binary ")
      || line.starts_with("GIT binary")
      || line.ends_with(" 120000")
      || line.ends_with(" 160000")
  }) {
    return Err("Mode changes, links, submodules and binary files must be staged as whole files.".into());
  }
  let selected: HashSet<_> = selection.iter().copied().collect();
  let mut accepted = HashSet::new();
  let mut patch = String::new();
  let mut delta = 0_i64;
  let mut cursor = 0;
  while cursor < lines.len() && !lines[cursor].starts_with("@@ ") {
    let line = lines[cursor];
    if line.starts_with("diff --git ") || line.starts_with("--- ") || line.starts_with("+++ ") {
      patch.push_str(line);
      patch.push('\n');
    }
    cursor += 1;
  }
  while cursor < lines.len() {
    let header: Vec<_> = lines[cursor].split_whitespace().collect();
    if header.len() < 4 || header[0] != "@@" {
      return Err("Unsupported diff format.".into());
    }
    let range = header[if reverse { 2 } else { 1 }];
    let old_start: i64 = range[1..]
      .split(',')
      .next()
      .unwrap_or("")
      .parse()
      .map_err(|_| "Invalid hunk range.")?;
    cursor += 1;
    let mut body = String::new();
    let mut old_count = 0;
    let mut new_count = 0;
    let mut changes = 0;
    let mut retained = false;
    while cursor < lines.len() && !lines[cursor].starts_with("@@ ") {
      let line = lines[cursor];
      if line.starts_with("\\ No newline") {
        if retained {
          body.push_str(line);
          body.push('\n');
        }
        cursor += 1;
        continue;
      }
      let mut kind = line.chars().next().ok_or("Invalid empty diff line.")?;
      if reverse {
        kind = match kind {
          '+' => '-',
          '-' => '+',
          other => other,
        };
      }
      if ![' ', '+', '-'].contains(&kind) {
        return Err("Unsupported diff content.".into());
      }
      let chosen = selected.contains(&cursor) && kind != ' ';
      if chosen {
        accepted.insert(cursor);
        changes += 1;
      }
      retained = kind != '+' || chosen;
      if kind == '-' && !chosen {
        kind = ' ';
      }
      if retained {
        old_count += i64::from(kind != '+');
        new_count += i64::from(kind != '-');
        body.push(kind);
        body.push_str(&line[1..]);
        body.push('\n');
      }
      cursor += 1;
    }
    if changes > 0 {
      let new_start = old_start
        + delta
        + if old_count == 0 {
          1
        } else if new_count == 0 {
          -1
        } else {
          0
        };
      patch.push_str(&format!(
        "@@ -{old_start},{old_count} +{new_start},{new_count} @@\n{body}"
      ));
      delta += new_count - old_count;
    }
  }
  if accepted != selected {
    return Err("Select only added or removed lines from the current diff.".into());
  }
  Ok(patch)
}
