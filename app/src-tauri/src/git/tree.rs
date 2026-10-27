use super::{service::GitService, validation};
use crate::models::{file_preview::FilePreview, tree_entry::TreeEntry};
use std::path::Path;

impl GitService {
  pub fn commit_tree(&self, repo: &Path, hash: &str) -> Result<Vec<TreeEntry>, String> {
    validation::hash(hash)?;
    let output = self.run(repo, &["ls-tree", "-r", "-l", "-z", "--full-tree", hash], false)?;
    parse_entries(&output.stdout)
  }

  pub fn commit_file(&self, repo: &Path, hash: &str, path: &str) -> Result<FilePreview, String> {
    validation::hash(hash)?;
    validation::path(path)?;
    let output = self.run(repo, &["ls-tree", "-l", "-z", "--full-tree", hash, "--", path], false)?;
    let entry = parse_entries(&output.stdout)?
      .into_iter()
      .find(|entry| entry.path == path)
      .ok_or("File not found in this commit.")?;
    if entry.kind == "blob" {
      if let Some(mime) = super::images::image_mime(path) {
        return self
          .revision_image(repo, &entry.object_id, mime)?
          .ok_or("Image not found.".into());
      }
    }
    let message = if entry.kind == "commit" {
      format!("Submodule at commit {}", entry.object_id)
    } else if entry.kind != "blob" {
      "Select a file to preview its contents.".into()
    } else if entry.size.unwrap_or(0) > 2 * 1024 * 1024 {
      "This file exceeds the 2 MiB text preview limit.".into()
    } else {
      String::new()
    };
    if !message.is_empty() {
      return Ok(FilePreview {
        text: String::new(),
        message,
        image: None,
      });
    }
    let bytes = self.run(repo, &["cat-file", "blob", &entry.object_id], false)?.stdout;
    if bytes.contains(&0) || std::str::from_utf8(&bytes).is_err() {
      return Ok(FilePreview {
        text: String::new(),
        message: "Binary or non-UTF-8 file — no text preview available.".into(),
        image: None,
      });
    }
    Ok(FilePreview {
      text: String::from_utf8(bytes).map_err(|error| error.to_string())?,
      message: String::new(),
      image: None,
    })
  }
}

fn parse_entries(bytes: &[u8]) -> Result<Vec<TreeEntry>, String> {
  let text = std::str::from_utf8(bytes).map_err(|_| "The tree contains a non-UTF-8 filename.")?;
  text
    .split('\0')
    .filter(|record| !record.is_empty())
    .map(|record| {
      let (metadata, path) = record.split_once('\t').ok_or("Invalid Git tree entry.")?;
      let fields: Vec<_> = metadata.split_whitespace().collect();
      if fields.len() != 4 {
        return Err("Invalid Git tree metadata.".into());
      }
      Ok(TreeEntry {
        path: path.into(),
        kind: fields[1].into(),
        object_id: fields[2].into(),
        size: fields[3].parse().ok(),
      })
    })
    .collect()
}
