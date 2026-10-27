use super::file_preview::FilePreview;
use serde::Serialize;

#[derive(Serialize)]
pub struct ImageDiff {
  pub before: Option<FilePreview>,
  pub after: Option<FilePreview>,
}
