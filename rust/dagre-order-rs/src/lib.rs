use wasm_bindgen::prelude::*;

mod model;
mod pipeline;
mod result;
pub mod graph;
pub mod util;

use graph::Graph;
use model::LayoutInput;
use pipeline::border::{add_border_segments, is_border_dummy, remove_border_nodes};
use pipeline::edge::run_edge_pipeline;
use pipeline::normalize::{denormalize_long_edges, normalize_long_edges};
use pipeline::order::order_with_metrics as run_order_pipeline;
use pipeline::position::{run_position_pipeline, update_compound_bounds};
use pipeline::rank::run_rank_pipeline;
use result::{EdgeOutput, LayoutOutput, Meta, NodeOutput, Point, fallback_error_json};
use util::{edge_minlen_with_label_spacing, now_ms};

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
    let effective_layout = apply_make_space_for_edge_labels(&input.layout);
    let debug_stages = effective_layout
        .get("debugStages")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let mut stage_snapshots = Vec::new();
    let _ = (effective_layout.is_object(), input.state.is_object());
    let mut graph = Graph::new(true, true);
    for node in &input.nodes {
        graph.set_node(&node.id, node.data.clone());
    }
    for node in &input.nodes {
        if let Some(parent) = node
            .data
            .get("parent")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
        {
            graph.set_parent(&node.id, Some(parent));
        }
    }
    let mut edge_ids = Vec::with_capacity(input.edges.len());
    let rankdir = effective_layout
        .get("rankdir")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("tb");
    let rankdir_upper = rankdir.to_uppercase();
    for edge in &input.edges {
        let mut minlen = edge_minlen_with_label_spacing(&edge.data);
        if graph.parent(&edge.v) != graph.parent(&edge.w) {
            minlen += 2;
        }
        // 保留 edge 的 width/height/labeloffset/labelpos，并应用 makeSpaceForEdgeLabels 逻辑
        let mut width = edge.data.get("width").and_then(serde_json::Value::as_f64).unwrap_or(0.0);
        let mut height = edge.data.get("height").and_then(serde_json::Value::as_f64).unwrap_or(0.0);
        let labeloffset = edge.data.get("labeloffset").and_then(serde_json::Value::as_f64).unwrap_or(10.0);
        let labelpos = edge.data.get("labelpos").and_then(serde_json::Value::as_str).unwrap_or("r");
        let weight = edge.data.get("weight").and_then(serde_json::Value::as_i64).unwrap_or(1);
        // makeSpaceForEdgeLabels: 当 labelpos 不是 'c' 时，调整 edge 尺寸
        if labelpos != "c" {
            if rankdir_upper == "TB" || rankdir_upper == "BT" {
                width += labeloffset;
            } else {
                height += labeloffset;
            }
        }
        let edge_id = graph.set_edge(&edge.v, &edge.w, serde_json::json!({
            "minlen": minlen,
            "weight": weight,
            "width": width,
            "height": height,
            "labeloffset": labeloffset,
            "labelpos": labelpos
        }));
        edge_ids.push(edge_id);
    }
    stage_ms.insert(
        "graph_build_ms".to_string(),
        serde_json::json!(now_ms() - graph_build_start),
    );
    if debug_stages {
        stage_snapshots.push(collect_stage_snapshot(&graph, "graph-built"));
    }

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
    if debug_stages {
        stage_snapshots.push(collect_stage_snapshot(&graph, "rank"));
    }

    let dummy_chains = normalize_long_edges(&mut graph);
    if debug_stages {
        stage_snapshots.push(collect_stage_snapshot(&graph, "normalize"));
    }

    add_border_segments(&mut graph);
    if debug_stages {
        stage_snapshots.push(collect_stage_snapshot(&graph, "add_border_segments"));
    }

    let order_start = now_ms();
    let order_metrics = run_order_pipeline(&mut graph, &effective_layout);
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
    if debug_stages {
        stage_snapshots.push(collect_stage_snapshot(&graph, "order"));
    }

    let position_start = now_ms();
    run_position_pipeline(&mut graph, &effective_layout);
    stage_ms.insert(
        "position_ms".to_string(),
        serde_json::json!(now_ms() - position_start),
    );
    if debug_stages {
        stage_snapshots.push(collect_stage_snapshot(&graph, "position"));
    }

    let debug_border_pre_remove = if debug_enabled(&effective_layout) {
        Some(collect_border_dummy_info(&graph))
    } else {
        None
    };

    remove_border_nodes(&mut graph);
    if debug_stages {
        stage_snapshots.push(collect_stage_snapshot(&graph, "remove_border_nodes"));
    }

    denormalize_long_edges(&mut graph, dummy_chains);
    if debug_stages {
        stage_snapshots.push(collect_stage_snapshot(&graph, "denormalize"));
    }

    update_compound_bounds(&mut graph);
    if debug_stages {
        stage_snapshots.push(collect_stage_snapshot(&graph, "update_compound_bounds"));
    }

    apply_compound_parent_spacing(&mut graph, &effective_layout);
    if debug_stages {
        stage_snapshots.push(collect_stage_snapshot(&graph, "apply_compound_parent_spacing"));
    }
    align_multi_input_nodes_to_predecessor_center(&mut graph);
    if debug_stages {
        stage_snapshots.push(collect_stage_snapshot(&graph, "align_multi_input_nodes_to_predecessor_center"));
    }

    let edge_start = now_ms();
    run_edge_pipeline(&mut graph);
    stage_ms.insert(
        "edge_ms".to_string(),
        serde_json::json!(now_ms() - edge_start),
    );
    if debug_stages {
        stage_snapshots.push(collect_stage_snapshot(&graph, "edge"));
    }

    let collect_output_start = now_ms();

    translate_graph(&mut graph);
    if debug_stages {
        stage_snapshots.push(collect_stage_snapshot(&graph, "translate_graph"));
    }

    let nodes = input
        .nodes
        .into_iter()
        .filter(|node| {
            !graph
                .node_label(&node.id)
                .map(is_border_dummy)
                .unwrap_or(false)
        })
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
        debug: if debug_enabled(&effective_layout) {
            Some(collect_debug_info(
                &graph,
                debug_border_pre_remove,
                if debug_stages {
                    Some(serde_json::Value::Array(stage_snapshots))
                } else {
                    None
                },
            ))
        } else {
            None
        },
        error: None,
    }
}

fn debug_enabled(layout: &serde_json::Value) -> bool {
    layout
        .get("debugBorder")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
        || layout
            .get("debugStages")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
}

fn collect_debug_info(
    graph: &Graph,
    border_pre_remove: Option<serde_json::Value>,
    stage_snapshots: Option<serde_json::Value>,
) -> serde_json::Value {
    let nodes = graph
        .nodes()
        .into_iter()
        .filter_map(|id| {
            let label = graph.node_label(&id)?;
            let x = label.get("x").and_then(serde_json::Value::as_f64);
            let y = label.get("y").and_then(serde_json::Value::as_f64);
            let rank = label.get("rank").and_then(serde_json::Value::as_i64);
            let order = label.get("order").and_then(serde_json::Value::as_i64);
            let width = label.get("width").and_then(serde_json::Value::as_f64);
            let height = label.get("height").and_then(serde_json::Value::as_f64);
            let border_type = label.get("borderType").and_then(serde_json::Value::as_str);
            let dummy = label.get("dummy").and_then(serde_json::Value::as_str);
            let border_left = label
                .get("borderLeft")
                .and_then(serde_json::Value::as_array)
                .map(|array| array.iter().filter_map(serde_json::Value::as_str).collect::<Vec<_>>());
            let border_right = label
                .get("borderRight")
                .and_then(serde_json::Value::as_array)
                .map(|array| array.iter().filter_map(serde_json::Value::as_str).collect::<Vec<_>>());
            Some(serde_json::json!({
                "id": id,
                "x": x,
                "y": y,
                "width": width,
                "height": height,
                "rank": rank,
                "order": order,
                "dummy": dummy,
                "borderType": border_type,
                "borderLeft": border_left,
                "borderRight": border_right,
                "borderTop": label.get("borderTop"),
                "borderBottom": label.get("borderBottom")
            }))
        })
        .collect::<Vec<_>>();

    serde_json::json!({
        "nodes": nodes,
        "borderDummyPreRemove": border_pre_remove,
        "stageSnapshots": stage_snapshots
    })
}

fn collect_stage_snapshot(graph: &Graph, stage: &str) -> serde_json::Value {
    let nodes = graph
        .nodes()
        .into_iter()
        .filter_map(|id| {
            let label = graph.node_label(&id)?;
            Some(serde_json::json!({
                "id": id,
                "x": label.get("x").and_then(serde_json::Value::as_f64),
                "y": label.get("y").and_then(serde_json::Value::as_f64),
                "rank": label.get("rank").and_then(serde_json::Value::as_i64),
                "order": label.get("order").and_then(serde_json::Value::as_i64),
                "dummy": label.get("dummy").and_then(serde_json::Value::as_str),
                "borderType": label.get("borderType").and_then(serde_json::Value::as_str),
                "parent": graph.parent(&id)
            }))
        })
        .collect::<Vec<_>>();
    let edges = graph
        .edges()
        .into_iter()
        .map(|edge| {
            let label = graph.edge_label(&edge.id);
            let points_len = label
                .and_then(|value| value.get("points"))
                .and_then(serde_json::Value::as_array)
                .map(|array| array.len())
                .unwrap_or(0);
            serde_json::json!({
                "v": edge.v,
                "w": edge.w,
                "minlen": label
                    .and_then(|value| value.get("minlen"))
                    .and_then(serde_json::Value::as_i64),
                "pointsLength": points_len
            })
        })
        .collect::<Vec<_>>();
    serde_json::json!({ "stage": stage, "nodes": nodes, "edges": edges })
}

fn collect_border_dummy_info(graph: &Graph) -> serde_json::Value {
    let nodes = graph
        .nodes()
        .into_iter()
        .filter_map(|id| {
            let label = graph.node_label(&id)?;
            if !is_border_dummy(label) {
                return None;
            }
            Some(serde_json::json!({
                "id": id,
                "x": label.get("x").and_then(serde_json::Value::as_f64),
                "y": label.get("y").and_then(serde_json::Value::as_f64),
                "rank": label.get("rank").and_then(serde_json::Value::as_i64),
                "order": label.get("order").and_then(serde_json::Value::as_i64),
                "borderType": label.get("borderType").and_then(serde_json::Value::as_str)
            }))
        })
        .collect::<Vec<_>>();
    serde_json::json!({ "nodes": nodes })
}

fn align_multi_input_nodes_to_predecessor_center(graph: &mut Graph) {
    let node_ids = graph.nodes();
    for node_id in node_ids {
        let Some(node_label) = graph.node_label(&node_id) else {
            continue;
        };
        if node_label
            .get("dummy")
            .and_then(serde_json::Value::as_str)
            .is_some()
        {
            continue;
        }

        let predecessors = graph.predecessors(&node_id);
        if predecessors.len() < 2 {
            continue;
        }

        let pred_x = predecessors
            .iter()
            .filter_map(|pred| graph.node_label(pred))
            .filter(|label| {
                label
                    .get("dummy")
                    .and_then(serde_json::Value::as_str)
                    .is_none()
            })
            .filter_map(|label| label.get("x").and_then(serde_json::Value::as_f64))
            .collect::<Vec<_>>();
        if pred_x.len() < 2 {
            continue;
        }

        let mut updated = node_label.clone();
        if !updated.is_object() {
            continue;
        }
        let center = pred_x.iter().sum::<f64>() / pred_x.len() as f64;
        updated["x"] = serde_json::json!(center);
        graph.set_node(&node_id, updated);
    }
}

fn apply_compound_parent_spacing(graph: &mut Graph, layout: &serde_json::Value) {
    if !graph.is_compound() {
        return;
    }

    let y_offset = layout
        .get("ranksep")
        .and_then(serde_json::Value::as_f64)
        .unwrap_or(0.0);
    if y_offset <= 0.0 {
        return;
    }

    let node_ids = graph.nodes();
    for node_id in &node_ids {
        if graph.parent(node_id).is_none() {
            continue;
        }
        let mut label = graph
            .node_label(node_id)
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        if !label.is_object() {
            continue;
        }
        if label
            .get("dummy")
            .and_then(serde_json::Value::as_str)
            .is_some()
        {
            continue;
        }
        if let Some(y) = label.get("y").and_then(serde_json::Value::as_f64) {
            label["y"] = serde_json::json!(y + y_offset);
            graph.set_node(node_id, label);
        }
    }

    for node_id in node_ids {
        let children = graph.children(Some(&node_id));
        if children.is_empty() {
            continue;
        }

        let mut min_top = f64::INFINITY;
        let mut max_bottom = f64::NEG_INFINITY;
        for child in children {
            let Some(label) = graph.node_label(&child) else {
                continue;
            };
            if label
                .get("dummy")
                .and_then(serde_json::Value::as_str)
                .is_some()
            {
                continue;
            }
            let Some(y) = label.get("y").and_then(serde_json::Value::as_f64) else {
                continue;
            };
            let h = label
                .get("height")
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(0.0);
            min_top = min_top.min(y - h / 2.0);
            max_bottom = max_bottom.max(y + h / 2.0);
        }
        if !min_top.is_finite() || !max_bottom.is_finite() {
            continue;
        }

        let mut label = graph
            .node_label(&node_id)
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        if !label.is_object() {
            continue;
        }
        let height = (max_bottom - min_top) + y_offset * 2.0;
        label["height"] = serde_json::json!(height);
        label["y"] = serde_json::json!((min_top + max_bottom) / 2.0);
        graph.set_node(&node_id, label);
    }
}

fn apply_make_space_for_edge_labels(layout: &serde_json::Value) -> serde_json::Value {
    let mut next = layout.clone();
    if let Some(object) = next.as_object_mut() {
        let ranksep = object
            .get("ranksep")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(50.0);
        object.insert("ranksep".to_string(), serde_json::json!(ranksep / 2.0));
    }
    next
}

fn translate_graph(graph: &mut Graph) {
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;

    for node in graph.nodes() {
        let Some(label) = graph.node_label(&node) else {
            continue;
        };
        let x = label.get("x").and_then(serde_json::Value::as_f64);
        let y = label.get("y").and_then(serde_json::Value::as_f64);
        let w = label.get("width").and_then(serde_json::Value::as_f64).unwrap_or(0.0);
        let h = label.get("height").and_then(serde_json::Value::as_f64).unwrap_or(0.0);
        if let (Some(x), Some(y)) = (x, y) {
            min_x = min_x.min(x - w / 2.0);
            min_y = min_y.min(y - h / 2.0);
        }
    }

    if !min_x.is_finite() || !min_y.is_finite() {
        return;
    }

    for node in graph.nodes() {
        let mut label = graph
            .node_label(&node)
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        if !label.is_object() {
            continue;
        }
        if let Some(x) = label.get("x").and_then(serde_json::Value::as_f64) {
            label["x"] = serde_json::json!(x - min_x);
        }
        if let Some(y) = label.get("y").and_then(serde_json::Value::as_f64) {
            label["y"] = serde_json::json!(y - min_y);
        }
        graph.set_node(&node, label);
    }

    for edge in graph.edges() {
        let mut label = graph
            .edge_label(&edge.id)
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        if !label.is_object() {
            continue;
        }
        if let Some(points) = label.get_mut("points").and_then(serde_json::Value::as_array_mut) {
            for point in points {
                if let Some(x) = point.get("x").and_then(serde_json::Value::as_f64) {
                    point["x"] = serde_json::json!(x - min_x);
                }
                if let Some(y) = point.get("y").and_then(serde_json::Value::as_f64) {
                    point["y"] = serde_json::json!(y - min_y);
                }
            }
        }
        graph.set_edge_label(&edge.id, label);
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
    use super::{apply_make_space_for_edge_labels, layout};

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

    #[test]
    fn make_space_for_edge_labels_halves_ranksep() {
        let layout = serde_json::json!({ "ranksep": 20, "nodesep": 20 });
        let adjusted = apply_make_space_for_edge_labels(&layout);
        assert_eq!(adjusted["ranksep"], serde_json::json!(10.0));
        assert_eq!(adjusted["nodesep"], serde_json::json!(20));
    }

    #[test]
    fn parent_relationship_changes_compound_geometry() {
        let with_parent = layout(
            r#"{
                "nodes":[
                    {"id":"cluster","data":{"v":"cluster","width":10,"height":10}},
                    {"id":"a","data":{"v":"a","width":96,"height":36,"parent":"cluster"}},
                    {"id":"b","data":{"v":"b","width":112,"height":42,"parent":"cluster"}},
                    {"id":"c","data":{"v":"c","width":112,"height":42,"parent":"cluster"}},
                    {"id":"d","data":{"v":"d","width":96,"height":36}}
                ],
                "edges":[
                    {"v":"a","w":"b","data":{"minlen":1}},
                    {"v":"a","w":"c","data":{"minlen":1}},
                    {"v":"b","w":"d","data":{"minlen":1}},
                    {"v":"c","w":"d","data":{"minlen":1}}
                ],
                "layout":{"rankdir":"TB","nodesep":20,"ranksep":20},
                "state":{}
            }"#,
        );
        let without_parent = layout(
            r#"{
                "nodes":[
                    {"id":"cluster","data":{"v":"cluster","width":10,"height":10}},
                    {"id":"a","data":{"v":"a","width":96,"height":36}},
                    {"id":"b","data":{"v":"b","width":112,"height":42}},
                    {"id":"c","data":{"v":"c","width":112,"height":42}},
                    {"id":"d","data":{"v":"d","width":96,"height":36}}
                ],
                "edges":[
                    {"v":"a","w":"b","data":{"minlen":1}},
                    {"v":"a","w":"c","data":{"minlen":1}},
                    {"v":"b","w":"d","data":{"minlen":1}},
                    {"v":"c","w":"d","data":{"minlen":1}}
                ],
                "layout":{"rankdir":"TB","nodesep":20,"ranksep":20},
                "state":{}
            }"#,
        );
        let with_parent_json: serde_json::Value = serde_json::from_str(&with_parent).expect("with_parent json");
        let without_parent_json: serde_json::Value = serde_json::from_str(&without_parent).expect("without_parent json");

        let get_cluster_y = |value: &serde_json::Value| {
            value
                .get("nodes")
                .and_then(serde_json::Value::as_array)
                .and_then(|nodes| {
                    nodes.iter().find(|node| {
                        node.get("id")
                            .and_then(serde_json::Value::as_str)
                            .map(|id| id == "cluster")
                            .unwrap_or(false)
                    })
                })
                .and_then(|node| node.get("y"))
                .and_then(serde_json::Value::as_f64)
                .expect("cluster y")
        };

        let y_with_parent = get_cluster_y(&with_parent_json);
        let y_without_parent = get_cluster_y(&without_parent_json);
        assert!(
            (y_with_parent - y_without_parent).abs() > 1e-6,
            "expected parent relation to affect cluster y, got {y_with_parent} and {y_without_parent}"
        );
    }

    #[test]
    fn cross_parent_edges_push_sink_rank_deeper() {
        let output = layout(
            r#"{
                "nodes":[
                    {"id":"cluster","data":{"v":"cluster","width":10,"height":10}},
                    {"id":"a","data":{"v":"a","width":96,"height":36,"parent":"cluster"}},
                    {"id":"b","data":{"v":"b","width":112,"height":42,"parent":"cluster"}},
                    {"id":"c","data":{"v":"c","width":112,"height":42,"parent":"cluster"}},
                    {"id":"d","data":{"v":"d","width":96,"height":36}}
                ],
                "edges":[
                    {"v":"a","w":"b","data":{"minlen":1}},
                    {"v":"a","w":"c","data":{"minlen":1}},
                    {"v":"b","w":"d","data":{"minlen":1}},
                    {"v":"c","w":"d","data":{"minlen":1}}
                ],
                "layout":{"rankdir":"TB","nodesep":20,"ranksep":20},
                "state":{}
            }"#,
        );
        let parsed: serde_json::Value = serde_json::from_str(&output).expect("valid json");
        let d_y = parsed
            .get("nodes")
            .and_then(serde_json::Value::as_array)
            .and_then(|nodes| {
                nodes.iter().find(|node| {
                    node.get("id")
                        .and_then(serde_json::Value::as_str)
                        .map(|id| id == "d")
                        .unwrap_or(false)
                })
            })
            .and_then(|node| node.get("y"))
            .and_then(serde_json::Value::as_f64)
            .expect("d.y");

        assert!(d_y >= 150.0, "expected d.y >= 150 for cross-parent edges, got {d_y}");
    }

    #[test]
    fn compound_children_shift_down_for_parent_dummy_spacing() {
        let output = layout(
            r#"{
                "nodes":[
                    {"id":"cluster","data":{"v":"cluster","width":10,"height":10}},
                    {"id":"a","data":{"v":"a","width":96,"height":36,"parent":"cluster"}},
                    {"id":"b","data":{"v":"b","width":112,"height":42,"parent":"cluster"}},
                    {"id":"c","data":{"v":"c","width":112,"height":42,"parent":"cluster"}},
                    {"id":"d","data":{"v":"d","width":96,"height":36}}
                ],
                "edges":[
                    {"v":"a","w":"b","data":{"minlen":1}},
                    {"v":"a","w":"c","data":{"minlen":1}},
                    {"v":"b","w":"d","data":{"minlen":1}},
                    {"v":"c","w":"d","data":{"minlen":1}}
                ],
                "layout":{"rankdir":"TB","nodesep":20,"ranksep":20},
                "state":{}
            }"#,
        );
        let parsed: serde_json::Value = serde_json::from_str(&output).expect("valid json");
        let a_y = parsed
            .get("nodes")
            .and_then(serde_json::Value::as_array)
            .and_then(|nodes| {
                nodes.iter().find(|node| {
                    node.get("id")
                        .and_then(serde_json::Value::as_str)
                        .map(|id| id == "a")
                        .unwrap_or(false)
                })
            })
            .and_then(|node| node.get("y"))
            .and_then(serde_json::Value::as_f64)
            .expect("a.y");

        assert!(a_y >= 27.0, "expected a.y >= 27 with compound spacing, got {a_y}");
    }

    #[test]
    fn compound_unconstrained_sibling_keeps_same_rank_band_as_constrained_sibling() {
        let output = layout(
            r#"{
                "nodes":[
                    {"id":"cluster","data":{"v":"cluster","width":10,"height":10}},
                    {"id":"a","data":{"v":"a","width":80,"height":30,"parent":"cluster"}},
                    {"id":"b","data":{"v":"b","width":80,"height":30,"parent":"cluster"}},
                    {"id":"c","data":{"v":"c","width":80,"height":30,"parent":"cluster"}},
                    {"id":"d","data":{"v":"d","width":80,"height":30}},
                    {"id":"e","data":{"v":"e","width":80,"height":30}},
                    {"id":"f","data":{"v":"f","width":80,"height":30}}
                ],
                "edges":[
                    {"v":"a","w":"b","data":{"minlen":1}}
                ],
                "layout":{"rankdir":"TB","nodesep":20,"ranksep":20},
                "state":{}
            }"#,
        );
        let parsed: serde_json::Value = serde_json::from_str(&output).expect("valid json");

        let node_y = |id: &str| {
            parsed
                .get("nodes")
                .and_then(serde_json::Value::as_array)
                .and_then(|nodes| {
                    nodes.iter().find(|node| {
                        node.get("id")
                            .and_then(serde_json::Value::as_str)
                            .map(|value| value == id)
                            .unwrap_or(false)
                    })
                })
                .and_then(|node| node.get("y"))
                .and_then(serde_json::Value::as_f64)
                .expect("node y")
        };

        let b_y = node_y("b");
        let c_y = node_y("c");

        let cluster_y = node_y("cluster");
        let d_y = node_y("d");

        assert!((b_y - c_y).abs() <= 1e-6, "expected b/c in same rank band, got b={b_y}, c={c_y}");
        assert!(d_y < cluster_y, "expected external node d above cluster center, got d={d_y}, cluster={cluster_y}");
    }

    #[test]
    fn border_backfill_keeps_compound_node_valid_after_finalize() {
        let output = layout(
            r#"{
                "nodes":[
                    {"id":"cluster","data":{"v":"cluster","width":10,"height":10}},
                    {"id":"a","data":{"v":"a","width":96,"height":36,"parent":"cluster"}},
                    {"id":"b","data":{"v":"b","width":112,"height":42,"parent":"cluster"}},
                    {"id":"c","data":{"v":"c","width":112,"height":42,"parent":"cluster"}},
                    {"id":"d","data":{"v":"d","width":96,"height":36}}
                ],
                "edges":[
                    {"v":"a","w":"b","data":{"minlen":1}},
                    {"v":"a","w":"c","data":{"minlen":1}},
                    {"v":"b","w":"d","data":{"minlen":1}},
                    {"v":"c","w":"d","data":{"minlen":1}}
                ],
                "layout":{"rankdir":"TB","nodesep":20,"ranksep":20},
                "state":{}
            }"#,
        );
        let parsed: serde_json::Value = serde_json::from_str(&output).expect("valid json");
        let cluster = parsed
            .get("nodes")
            .and_then(serde_json::Value::as_array)
            .and_then(|nodes| {
                nodes.iter().find(|node| {
                    node.get("id")
                        .and_then(serde_json::Value::as_str)
                        .map(|id| id == "cluster")
                        .unwrap_or(false)
                })
            })
            .expect("cluster node");

        let cluster_x = cluster
            .get("x")
            .and_then(serde_json::Value::as_f64)
            .expect("cluster x");
        let cluster_y = cluster
            .get("y")
            .and_then(serde_json::Value::as_f64)
            .expect("cluster y");

        assert!(cluster_x.is_finite() && cluster_x >= 0.0, "cluster.x should be non-negative finite, got {cluster_x}");
        assert!(cluster_y.is_finite() && cluster_y >= 0.0, "cluster.y should be non-negative finite, got {cluster_y}");
    }

    #[test]
    fn debug_border_dummies_share_vertical_x_constraints() {
        let output = layout(
            r#"{
                "nodes":[
                    {"id":"cluster","data":{"v":"cluster","width":10,"height":10}},
                    {"id":"a","data":{"v":"a","width":96,"height":36,"parent":"cluster"}},
                    {"id":"b","data":{"v":"b","width":112,"height":42,"parent":"cluster"}},
                    {"id":"c","data":{"v":"c","width":112,"height":42,"parent":"cluster"}},
                    {"id":"d","data":{"v":"d","width":96,"height":36}}
                ],
                "edges":[
                    {"v":"a","w":"b","data":{"minlen":1}},
                    {"v":"a","w":"c","data":{"minlen":1}},
                    {"v":"b","w":"d","data":{"minlen":1}},
                    {"v":"c","w":"d","data":{"minlen":1}}
                ],
                "layout":{"rankdir":"TB","nodesep":20,"ranksep":20,"debugBorder":true},
                "state":{}
            }"#,
        );
        let parsed: serde_json::Value = serde_json::from_str(&output).expect("valid json");
        let pre = parsed
            .get("debug")
            .and_then(|v| v.get("borderDummyPreRemove"))
            .and_then(|v| v.get("nodes"))
            .and_then(serde_json::Value::as_array)
            .expect("debug pre-remove nodes");

        let left: Vec<f64> = pre
            .iter()
            .filter(|node| {
                node.get("borderType")
                    .and_then(serde_json::Value::as_str)
                    .map(|v| v == "borderLeft")
                    .unwrap_or(false)
            })
            .filter_map(|node| node.get("x").and_then(serde_json::Value::as_f64))
            .collect();
        let right: Vec<f64> = pre
            .iter()
            .filter(|node| {
                node.get("borderType")
                    .and_then(serde_json::Value::as_str)
                    .map(|v| v == "borderRight")
                    .unwrap_or(false)
            })
            .filter_map(|node| node.get("x").and_then(serde_json::Value::as_f64))
            .collect();

        assert!(left.len() >= 2, "need >=2 left border points");
        assert!(right.len() >= 2, "need >=2 right border points");
        assert!(left.iter().all(|x| x.is_finite()), "left border x must be finite: {left:?}");
        assert!(right.iter().all(|x| x.is_finite()), "right border x must be finite: {right:?}");
    }

}
