#[derive(Debug, Clone, serde::Serialize)]
pub struct LayoutOutput {
    pub meta: Meta,
    pub nodes: Vec<NodeOutput>,
    pub edges: Vec<EdgeOutput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<LayoutError>,
}

impl LayoutOutput {
    pub fn error(code: &str, message: &str) -> Self {
        Self {
            meta: Meta::error(),
            nodes: Vec::new(),
            edges: Vec::new(),
            error: Some(LayoutError {
                code: code.to_string(),
                message: message.to_string(),
            }),
        }
    }
}

pub fn fallback_error_json(code: &str, message: &str) -> String {
    let code_json = serde_json::to_string(code).unwrap_or_else(|_| "\"serialize_error\"".to_string());
    let message_json = serde_json::to_string(message).unwrap_or_else(|_| "\"fallback_error\"".to_string());
    format!(
        "{{\"meta\":{{\"ok\":false,\"elapsed_ms\":0.0,\"stage_ms\":{{}},\"warnings\":[\"fallback_error_json_used\"]}},\"nodes\":[],\"edges\":[],\"error\":{{\"code\":{},\"message\":{}}}}}",
        code_json,
        message_json
    )
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Meta {
    pub ok: bool,
    pub elapsed_ms: f64,
    pub stage_ms: serde_json::Value,
    pub warnings: Vec<String>,
}

impl Meta {
    pub fn ok() -> Self {
        Self {
            ok: true,
            elapsed_ms: 0.0,
            stage_ms: serde_json::json!({}),
            warnings: Vec::new(),
        }
    }

    pub fn error() -> Self {
        Self {
            ok: false,
            elapsed_ms: 0.0,
            stage_ms: serde_json::json!({}),
            warnings: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct LayoutError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct NodeOutput {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct EdgeOutput {
    pub v: String,
    pub w: String,
    pub points: Vec<Point>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}
