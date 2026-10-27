use serde::Deserialize;

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffRequest {
  pub path: String,
  pub original_path: Option<String>,
  pub hash: Option<String>,
  #[serde(default)]
  pub staged: bool,
  #[serde(default)]
  pub untracked: bool,
  #[serde(default)]
  pub full_file: bool,
}
