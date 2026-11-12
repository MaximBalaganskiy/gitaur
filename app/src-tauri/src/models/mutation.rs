use serde::Deserialize;

#[derive(Default, Deserialize)]
pub struct Mutation {
  pub paths: Option<Vec<String>>,
  pub message: Option<String>,
  pub name: Option<String>,
  pub url: Option<String>,
  pub reference: Option<String>,
  pub directory: Option<String>,
  pub choice: Option<String>,
  pub text: Option<String>,
  pub original: Option<String>,
  pub original_worktree: Option<String>,
  pub lines: Option<Vec<usize>>,
  pub staged: Option<bool>,
  pub full_file: Option<bool>,
  pub include_untracked: Option<bool>,
  pub expected_head: Option<String>,
  pub expected_branch: Option<String>,
  pub force: Option<bool>,
  pub mainline: Option<usize>,
  pub plan: Option<Vec<super::rebase_step::RebaseStep>>,
  pub push_url: Option<String>,
  pub prune: Option<bool>,
}
