#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct SyncOptions {
    pub apply: bool,
    pub reconstruct_rolls: bool,
    pub fresh: bool,
    pub replace: bool,
    pub roll_detect: bool,
    pub start_date: Option<String>,
}
