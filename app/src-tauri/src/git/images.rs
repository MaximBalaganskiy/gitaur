use super::{service::GitService, validation};
use crate::models::{diff_request::DiffRequest, file_preview::FilePreview, image_diff::ImageDiff};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{fs::File, io::Read, path::Path};

const IMAGE_LIMIT: u64 = 10 * 1024 * 1024;

pub(super) fn image_mime(path: &str) -> Option<&'static str> {
  match Path::new(path).extension()?.to_str()?.to_ascii_lowercase().as_str() {
    "png" => Some("image/png"),
    "jpg" | "jpeg" | "jfif" => Some("image/jpeg"),
    "gif" => Some("image/gif"),
    "webp" => Some("image/webp"),
    "svg" => Some("image/svg+xml"),
    "bmp" => Some("image/bmp"),
    "ico" => Some("image/x-icon"),
    "avif" => Some("image/avif"),
    _ => None,
  }
}

fn preview(bytes: &[u8], mime: &str) -> FilePreview {
  FilePreview {
    text: String::new(),
    message: String::new(),
    image: Some(format!("data:{mime};base64,{}", STANDARD.encode(bytes))),
  }
}

fn too_large() -> FilePreview {
  FilePreview {
    text: String::new(),
    message: "This image exceeds the 10 MiB preview limit.".into(),
    image: None,
  }
}

impl GitService {
  pub fn image_diff(&self, repo: &Path, request: &DiffRequest) -> Result<ImageDiff, String> {
    validation::path(&request.path)?;
    let original = request.original_path.as_deref().unwrap_or(&request.path);
    validation::path(original)?;
    let mime = image_mime(&request.path).ok_or("Unsupported image format.")?;
    let before_mime = image_mime(original).unwrap_or(mime);
    let (before, after) = if let Some(hash) = &request.hash {
      let parents = self.parents(repo, hash)?;
      let before = match parents.first() {
        Some(parent) => self.revision_image(repo, &format!("{parent}:{original}"), before_mime)?,
        None => None,
      };
      (
        before,
        self.revision_image(repo, &format!("{hash}:{}", request.path), mime)?,
      )
    } else if request.staged {
      (
        self.revision_image(repo, &format!("HEAD:{original}"), before_mime)?,
        self.revision_image(repo, &format!(":{}", request.path), mime)?,
      )
    } else {
      let before = if request.untracked {
        None
      } else {
        self.revision_image(repo, &format!(":{original}"), before_mime)?
      };
      (before, self.working_image(repo, &request.path, mime)?)
    };
    Ok(ImageDiff { before, after })
  }

  pub(super) fn revision_image(&self, repo: &Path, revision: &str, mime: &str) -> Result<Option<FilePreview>, String> {
    let kind = self.run(repo, &["cat-file", "-t", revision], true)?;
    if !kind.status.success() || kind.stdout != b"blob\n" {
      return Ok(None);
    }
    let size = self.text(repo, &["cat-file", "-s", revision])?;
    if size.trim().parse::<u64>().map_err(|error| error.to_string())? > IMAGE_LIMIT {
      return Ok(Some(too_large()));
    }
    let bytes = self.run(repo, &["cat-file", "blob", revision], false)?.stdout;
    if bytes.len() as u64 > IMAGE_LIMIT {
      return Ok(Some(too_large()));
    }
    Ok(Some(preview(&bytes, mime)))
  }

  fn working_image(&self, repo: &Path, path: &str, mime: &str) -> Result<Option<FilePreview>, String> {
    let full = match dunce::canonicalize(repo.join(path)) {
      Ok(full) => full,
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
      Err(error) => return Err(error.to_string()),
    };
    let root = dunce::canonicalize(repo).map_err(|error| error.to_string())?;
    if !full.starts_with(root) {
      return Err("File points outside the repository.".into());
    }
    let file = File::open(full).map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() {
      return Err("This entry is not a regular file.".into());
    }
    if metadata.len() > IMAGE_LIMIT {
      return Ok(Some(too_large()));
    }
    let mut bytes = Vec::new();
    file
      .take(IMAGE_LIMIT + 1)
      .read_to_end(&mut bytes)
      .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > IMAGE_LIMIT {
      return Ok(Some(too_large()));
    }
    Ok(Some(preview(&bytes, mime)))
  }
}
