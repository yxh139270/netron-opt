use wasm_bindgen::prelude::*;

mod model;
mod pipeline;
mod result;
pub mod graph;
pub mod util;

use graph::Graph;
use model::LayoutInput;
use pipeline::order::order as run_order_pipeline;
use pipeline::rank::run_rank_pipeline;
use result::{EdgeOutput, LayoutOutput, Meta, NodeOutput, fallback_error_json};
use util::edge_minlen;

#[wasm_bindgen]
pub fn layout(input_json: &str) -> String {
    match serde_json::from_str::<LayoutInput>(input_json) {
        Ok(input) => serialize_success(run_layout(input)),
        Err(_err) => serialize_error("parse_error", "invalid_input_json"),
    }
}

fn run_layout(input: LayoutInput) -> LayoutOutput {
    let _ = (input.layout.is_object(), input.state.is_object());
    let mut graph = Graph::new(false, false);
    for node in &input.nodes {
        graph.set_node(&node.id, node.data.clone());
    }
    for edge in &input.edges {
        let minlen = edge_minlen(&edge.data);
        graph.set_edge(&edge.v, &edge.w, serde_json::json!({ "minlen": minlen }));
    }
    if let Err(error) = run_rank_pipeline(&mut graph) {
        return LayoutOutput::error("rank_error", error.message());
    }
    run_order_pipeline(&mut graph, &input.state);

    LayoutOutput {
        meta: Meta::ok(),
        nodes: input
            .nodes
            .into_iter()
            .map(|node| NodeOutput { id: node.id })
            .collect(),
        edges: input
            .edges
            .into_iter()
            .map(|edge| EdgeOutput {
                v: edge.v,
                w: edge.w,
            })
            .collect(),
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
