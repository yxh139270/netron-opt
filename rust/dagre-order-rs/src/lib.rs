use wasm_bindgen::prelude::*;

mod model;
mod result;

use model::LayoutInput;
use result::{LayoutOutput, Meta, fallback_error_json};

#[wasm_bindgen]
pub fn layout(input_json: &str) -> String {
    match serde_json::from_str::<LayoutInput>(input_json) {
        Ok(input) => serialize_success(run_layout(input)),
        Err(_err) => serialize_error("parse_error", "invalid_input_json"),
    }
}

fn run_layout(input: LayoutInput) -> LayoutOutput {
    let _ = (input.layout.is_object(), input.state.is_object());
    for node in &input.nodes {
        let _ = (&node.id, &node.data);
    }
    for edge in &input.edges {
        let _ = (&edge.v, &edge.w, &edge.data);
    }
    LayoutOutput {
        meta: Meta::ok(),
        nodes: Vec::new(),
        edges: Vec::new(),
        error: None,
    }
}

fn serialize_success(output: LayoutOutput) -> String {
    serde_json::to_string(&output)
        .unwrap_or_else(|_| fallback_error_json("serialize_error", "failed_to_serialize_output"))
}

fn serialize_error(code: &str, message: &str) -> String {
    let output = LayoutOutput::error(code, message);
    serde_json::to_string(&output)
        .unwrap_or_else(|_| fallback_error_json("serialize_error", "failed_to_serialize_error"))
}

#[cfg(test)]
mod tests {
    use super::layout;

    #[test]
    fn layout_accepts_minimal_payload() {
        let input = r#"{"nodes":[],"edges":[],"layout":{},"state":{}}"#;
        let output = layout(input);
        let parsed: serde_json::Value = serde_json::from_str(&output).expect("output should be valid JSON");
        assert_eq!(parsed["meta"]["ok"], true);
        assert!(parsed.get("error").is_none());
    }

    #[test]
    fn layout_returns_parse_error_for_invalid_json() {
        let output = layout("not json");
        let parsed: serde_json::Value = serde_json::from_str(&output).expect("output should be valid JSON");
        assert_eq!(parsed["meta"]["ok"], false);
        assert_eq!(parsed["error"]["code"], "parse_error");
        assert_eq!(parsed["error"]["message"], "invalid_input_json");
    }

    #[test]
    fn layout_returns_parse_error_for_missing_required_fields() {
        let output = layout("{}");
        let parsed: serde_json::Value = serde_json::from_str(&output).expect("output should be valid JSON");
        assert_eq!(parsed["meta"]["ok"], false);
        assert_eq!(parsed["error"]["code"], "parse_error");
        assert_eq!(parsed["error"]["message"], "invalid_input_json");
    }
}
