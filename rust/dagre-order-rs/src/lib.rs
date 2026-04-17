use wasm_bindgen::prelude::*;

mod model;
mod pipeline;
mod result;
pub mod graph;
pub mod util;

use graph::Graph;
use model::LayoutInput;
use pipeline::edge::run_edge_pipeline;
use pipeline::order::order as run_order_pipeline;
use pipeline::position::run_position_pipeline;
use pipeline::rank::run_rank_pipeline;
use result::{EdgeOutput, LayoutOutput, Meta, NodeOutput, Point, fallback_error_json};
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
    let mut graph = Graph::new(false, true);
    for node in &input.nodes {
        graph.set_node(&node.id, node.data.clone());
    }
    let mut edge_ids = Vec::with_capacity(input.edges.len());
    for edge in &input.edges {
        let minlen = edge_minlen(&edge.data);
        let edge_id = graph.set_edge(&edge.v, &edge.w, serde_json::json!({ "minlen": minlen }));
        edge_ids.push(edge_id);
    }
    if let Err(error) = run_rank_pipeline(&mut graph) {
        return LayoutOutput::error("rank_error", error.message());
    }
    run_order_pipeline(&mut graph, &input.state);
    run_position_pipeline(&mut graph);
    run_edge_pipeline(&mut graph);

    LayoutOutput {
        meta: Meta::ok(),
        nodes: input
            .nodes
            .into_iter()
            .map(|node| {
                let (x, y) = node_xy(&graph, &node.id);
                NodeOutput { id: node.id, x, y }
            })
            .collect(),
        edges: input
            .edges
            .into_iter()
            .zip(edge_ids)
            .map(|(edge, edge_id)| {
                let points = edge_points(&graph, &edge_id);
                EdgeOutput {
                    v: edge.v,
                    w: edge.w,
                    points,
                }
            })
            .collect(),
        error: None,
    }
}

fn node_xy(graph: &Graph, id: &str) -> (Option<f64>, Option<f64>) {
    let Some(label) = graph.node_label(id) else {
        return (None, None);
    };
    (
        label.get("x").and_then(serde_json::Value::as_f64),
        label.get("y").and_then(serde_json::Value::as_f64),
    )
}

fn edge_points(graph: &Graph, edge_id: &str) -> Vec<Point> {
    let Some(label) = graph.edge_label(edge_id) else {
        return Vec::new();
    };
    label
        .get("points")
        .cloned()
        .and_then(|value| serde_json::from_value::<Vec<Point>>(value).ok())
        .unwrap_or_default()
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
