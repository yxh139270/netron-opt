use wasm_bindgen::prelude::*;

#[derive(serde::Serialize)]
struct Meta {
    ok: bool,
    elapsed_ms: f64,
    stage_ms: serde_json::Value,
    warnings: Vec<String>,
}

#[wasm_bindgen]
pub fn layout(input_json: &str) -> String {
    let _ = input_json;
    let meta = Meta {
        ok: true,
        elapsed_ms: 0.0,
        stage_ms: serde_json::json!({}),
        warnings: Vec::new()
    };
    let output = serde_json::json!({
        "meta": meta,
        "nodes": [],
        "edges": []
    });
    output.to_string()
}
