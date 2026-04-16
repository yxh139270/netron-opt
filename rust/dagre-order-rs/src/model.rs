#[derive(Debug, Clone, serde::Deserialize)]
pub struct LayoutInput {
    pub nodes: Vec<NodeInput>,
    pub edges: Vec<EdgeInput>,
    pub layout: serde_json::Value,
    pub state: serde_json::Value,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct NodeInput {
    pub id: String,
    #[serde(default)]
    pub data: serde_json::Value,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct EdgeInput {
    pub v: String,
    pub w: String,
    #[serde(default)]
    pub data: serde_json::Value,
}
