use super::{service::GitService, workflows::safe_working_path};
use crate::models::mutation::Mutation;
use std::{fs, io::ErrorKind, path::Path};

impl GitService {
  pub fn new_file_state(&self, repo: &Path, path: &str) -> Result<String, String> {
    let target = safe_working_path(repo, path)?;
    let snapshot = self.snapshot(repo, 1)?;
    let files: Vec<_> = snapshot.files.iter().filter(|file| file.path == path).collect();
    if files.is_empty()
      || files.iter().any(|file| {
        file.conflict
          || file.original_path.is_some()
          || !(file.index == "?" || file.index == "A" || (file.index == " " && file.worktree == "A"))
      })
    {
      return Err("Only new files without conflicts or renames can be deleted here.".into());
    }
    if !snapshot.head.is_empty()
      && !self
        .run(repo, &["ls-tree", "-z", &snapshot.head, "--", path], false)?
        .stdout
        .is_empty()
    {
      return Err("This file already exists in HEAD. Reset its changes instead.".into());
    }
    let content = match fs::symlink_metadata(&target) {
      Ok(metadata) if metadata.is_file() => Some(self.text(repo, &["hash-object", "--no-filters", "--", path])?),
      Ok(_) => return Err("Select a regular new file. Folders and links cannot be deleted here.".into()),
      Err(error) if error.kind() == ErrorKind::NotFound => None,
      Err(error) => return Err(error.to_string()),
    };
    let index = self.text(repo, &["ls-files", "--stage", "-z", "--", path])?;
    serde_json::to_string(&(snapshot.head, index, content)).map_err(|error| error.to_string())
  }

  pub(super) fn delete_new_file(&self, repo: &Path, payload: &Mutation) -> Result<(), String> {
    let path = payload
      .paths
      .as_ref()
      .filter(|paths| paths.len() == 1)
      .and_then(|paths| paths.first())
      .ok_or("Select one new file.")?;
    let current = self.new_file_state(repo, path)?;
    if payload.original.as_deref() != Some(&current) {
      return Err("The file or its staged state changed. Review the file and confirm deletion again.".into());
    }
    let target = safe_working_path(repo, path)?;
    if self
      .run(repo, &["ls-files", "--error-unmatch", "--", path], true)?
      .status
      .success()
    {
      self.run(repo, &["rm", "-f", "--", path], false)?;
    } else {
      fs::remove_file(target).map_err(|error| error.to_string())?;
    }
    Ok(())
  }
}
