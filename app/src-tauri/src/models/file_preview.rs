use serde::Serialize;

#[derive(Serialize)]
pub struct FilePreview {
  pub text: String,
  pub message: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub image: Option<String>,
}
