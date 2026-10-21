use super::commit_file::CommitFile;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detail {
  pub message: String,
  pub files: Vec<CommitFile>,
  pub local_branches: Vec<String>,
  pub remote_branches: Vec<String>,
}
