use wasm_bindgen::prelude::*;

mod model;
mod pipeline;
mod result;
pub mod graph;
pub mod util;

use graph::Graph;
use model::LayoutInput;
use pipeline::edge::run_edge_pipeline;
use pipeline::order::order_with_metrics as run_order_pipeline;
use pipeline::position::run_position_pipeline;
use pipeline::rank::run_rank_pipeline;
use result::{EdgeOutput, LayoutOutput, Meta, NodeOutput, Point, fallback_error_json};
use util::{edge_minlen, now_ms};

#[wasm_bindgen]
pub fn layout(input_json: &str) -> String {
    match serde_json::from_str::<LayoutInput>(input_json) {
        Ok(input) => serialize_success(run_layout(input)),
        Err(_err) => serialize_error("parse_error", "invalid_input_json"),
    }
}

fn run_layout(input: LayoutInput) -> LayoutOutput {
    let total_start = now_ms();
    let mut stage_ms = serde_json::Map::new();

    let graph_build_start = now_ms();
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
    stage_ms.insert(
        "graph_build_ms".to_string(),
        serde_json::json!(now_ms() - graph_build_start),
    );

    let rank_start = now_ms();
    let rank_result = run_rank_pipeline(&mut graph);
    stage_ms.insert(
        "rank_ms".to_string(),
        serde_json::json!(now_ms() - rank_start),
    );
    if let Err(error) = rank_result {
        let mut output = LayoutOutput::error("rank_error", error.message());
        output.meta.elapsed_ms = now_ms() - total_start;
        output.meta.stage_ms = serde_json::Value::Object(stage_ms);
        return output;
    }

    let order_start = now_ms();
    let order_metrics = run_order_pipeline(&mut graph, &input.layout);
    stage_ms.insert(
        "order_ms".to_string(),
        serde_json::json!(now_ms() - order_start),
    );
    stage_ms.insert("order_init_ms".to_string(), serde_json::json!(order_metrics.init_ms));
    stage_ms.insert(
        "order_layer_graph_ms".to_string(),
        serde_json::json!(order_metrics.layer_graph_ms),
    );
    stage_ms.insert(
        "order_reorder_rank_ms".to_string(),
        serde_json::json!(order_metrics.reorder_rank_ms),
    );
    stage_ms.insert(
        "order_cross_count_ms".to_string(),
        serde_json::json!(order_metrics.cross_count_ms),
    );

    let position_start = now_ms();
    run_position_pipeline(&mut graph);
    stage_ms.insert(
        "position_ms".to_string(),
        serde_json::json!(now_ms() - position_start),
    );

    let edge_start = now_ms();
    run_edge_pipeline(&mut graph);
    stage_ms.insert(
        "edge_ms".to_string(),
        serde_json::json!(now_ms() - edge_start),
    );

    let collect_output_start = now_ms();

    let nodes = input
        .nodes
        .into_iter()
        .map(|node| {
            let (x, y) = node_xy(&graph, &node.id);
            NodeOutput { id: node.id, x, y }
        })
        .collect();

    let edges = input
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
        .collect();

    stage_ms.insert(
        "collect_output_ms".to_string(),
        serde_json::json!(now_ms() - collect_output_start),
    );

    LayoutOutput {
        meta: Meta {
            ok: true,
            elapsed_ms: now_ms() - total_start,
            stage_ms: serde_json::Value::Object(stage_ms),
            warnings: Vec::new(),
        },
        nodes,
        edges,
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
        assert!(parsed["meta"]["elapsed_ms"].as_f64().is_some());
        assert!(parsed["meta"]["stage_ms"]["graph_build_ms"].as_f64().is_some());
        assert!(parsed["meta"]["stage_ms"]["rank_ms"].as_f64().is_some());
        assert!(parsed["meta"]["stage_ms"]["order_ms"].as_f64().is_some());
        assert!(parsed["meta"]["stage_ms"]["order_init_ms"].as_f64().is_some());
        assert!(parsed["meta"]["stage_ms"]["order_layer_graph_ms"].as_f64().is_some());
        assert!(parsed["meta"]["stage_ms"]["order_reorder_rank_ms"].as_f64().is_some());
        assert!(parsed["meta"]["stage_ms"]["order_cross_count_ms"].as_f64().is_some());
        assert!(parsed["meta"]["stage_ms"]["position_ms"].as_f64().is_some());
        assert!(parsed["meta"]["stage_ms"]["edge_ms"].as_f64().is_some());
        assert!(parsed["meta"]["stage_ms"]["collect_output_ms"].as_f64().is_some());
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
