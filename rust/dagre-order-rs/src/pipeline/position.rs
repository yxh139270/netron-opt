use std::collections::BTreeMap;

use crate::graph::Graph;

const NODE_SEP: f64 = 80.0;
const RANK_SEP: f64 = 100.0;

pub fn run_position_pipeline(g: &mut Graph, layout: &serde_json::Value) {
    let nodesep = layout_number(layout, "nodesep", 50.0);
    let ranksep = layout_number(layout, "ranksep", 50.0);

    let mut layers: BTreeMap<i64, Vec<String>> = BTreeMap::new();
    for node in g.nodes() {
        if g.is_compound() && !g.children(Some(&node)).is_empty() {
            continue;
        }
        if let Some(rank) = node_rank(g, &node) {
            layers.entry(rank).or_default().push(node);
        }
    }
    if layers.is_empty() {
        return;
    }

    let min_rank = *layers.keys().next().unwrap_or(&0);
    let max_rank = *layers.keys().next_back().unwrap_or(&0);
    let start_rank = min_rank.min(0);

    let mut y = 0.0_f64;
    for rank in start_rank..=max_rank {
        let mut layer = layers.remove(&rank).unwrap_or_default();
        layer.sort_by(|left, right| {
            node_order(g, left)
                .cmp(&node_order(g, right))
                .then_with(|| left.cmp(right))
        });

        let max_height = layer
            .iter()
            .map(|node| node_height(g, node))
            .fold(0.0_f64, f64::max);
        let layer_center_y = y + max_height / 2.0;

        let mut cursor_x = 0.0_f64;
        let mut layer_centers = Vec::with_capacity(layer.len());
        for node in layer.iter() {
            let width = node_width(g, node);
            layer_centers.push(cursor_x + width / 2.0);
            cursor_x += width + nodesep;
        }
        let shift_x = if cursor_x > 0.0 {
            (cursor_x - nodesep) / 2.0
        } else {
            0.0
        };

        if !layer.is_empty() {
            if let Some(first) = layer.first() {
                if is_border_left(g, first) {
                    let mut left_label = g
                        .node_label(first)
                        .cloned()
                        .unwrap_or_else(|| serde_json::json!({}));
                    if !left_label.is_object() {
                        left_label = serde_json::json!({});
                    }
                    left_label["x"] = serde_json::json!(0.0);
                    left_label["y"] = serde_json::json!(layer_center_y);
                    g.set_node(first, left_label);
                }
            }

            for (index, node) in layer.iter().enumerate() {
                let x = layer_centers[index] - shift_x;
                let y = layer_center_y;
                let mut label = g
                    .node_label(node)
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({}));
                if !label.is_object() {
                    label = serde_json::json!({});
                }
                label["x"] = serde_json::json!(x);
                label["y"] = serde_json::json!(y);
                g.set_node(node, label);
            }

            if let Some(last) = layer.last() {
                if is_border_right(g, last) {
                    let mut right_label = g
                        .node_label(last)
                        .cloned()
                        .unwrap_or_else(|| serde_json::json!({}));
                    if !right_label.is_object() {
                        right_label = serde_json::json!({});
                    }
                    let left_x = layer
                        .first()
                        .and_then(|first| g.node_label(first))
                        .and_then(|label| label.get("x"))
                        .and_then(serde_json::Value::as_f64)
                        .unwrap_or(0.0);
                    right_label["x"] = serde_json::json!(left_x + shift_x * 2.0);
                    right_label["y"] = serde_json::json!(layer_center_y);
                    g.set_node(last, right_label);
                }
            }
        }

        y += max_height + ranksep;
    }

    align_multi_input_nodes(g);

    update_compound_bounds(g);

}

fn align_multi_input_nodes(g: &mut Graph) {
    let node_ids = g.nodes();
    for node_id in node_ids {
        let Some(label) = g.node_label(&node_id) else {
            continue;
        };
        if label
            .get("dummy")
            .and_then(serde_json::Value::as_str)
            .is_some()
        {
            continue;
        }

        let predecessors = g.predecessors(&node_id);
        if predecessors.len() < 2 {
            continue;
        }

        let pred_x = predecessors
            .iter()
            .filter_map(|pred| g.node_label(pred))
            .filter(|pred_label| {
                pred_label
                    .get("dummy")
                    .and_then(serde_json::Value::as_str)
                    .is_none()
            })
            .filter_map(|pred_label| pred_label.get("x").and_then(serde_json::Value::as_f64))
            .collect::<Vec<_>>();
        if pred_x.len() < 2 {
            continue;
        }

        let center = pred_x.iter().sum::<f64>() / pred_x.len() as f64;
        let mut updated = label.clone();
        if !updated.is_object() {
            continue;
        }
        updated["x"] = serde_json::json!(center);
        g.set_node(&node_id, updated);
    }
}

fn layout_number(layout: &serde_json::Value, key: &str, fallback: f64) -> f64 {
    layout
        .get(key)
        .and_then(serde_json::Value::as_f64)
        .filter(|value| *value >= 0.0)
        .unwrap_or(fallback)
}

fn node_width(g: &Graph, id: &str) -> f64 {
    g.node_label(id)
        .and_then(|label| label.get("width"))
        .and_then(serde_json::Value::as_f64)
        .filter(|value| *value >= 0.0)
        .unwrap_or(NODE_SEP)
}

fn node_height(g: &Graph, id: &str) -> f64 {
    g.node_label(id)
        .and_then(|label| label.get("height"))
        .and_then(serde_json::Value::as_f64)
        .filter(|value| *value >= 0.0)
        .unwrap_or(RANK_SEP)
}

fn node_rank(g: &Graph, id: &str) -> Option<i64> {
    g.node_label(id)
        .and_then(|label| label.get("rank"))
        .and_then(serde_json::Value::as_i64)
}

fn node_order(g: &Graph, id: &str) -> usize {
    g.node_label(id)
        .and_then(|label| label.get("order"))
        .and_then(serde_json::Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(0)
}

fn is_border_left(g: &Graph, id: &str) -> bool {
    g.node_label(id)
        .and_then(|label| label.get("borderType"))
        .and_then(serde_json::Value::as_str)
        .map(|value| value == "borderLeft")
        .unwrap_or(false)
}

fn is_border_right(g: &Graph, id: &str) -> bool {
    g.node_label(id)
        .and_then(|label| label.get("borderType"))
        .and_then(serde_json::Value::as_str)
        .map(|value| value == "borderRight")
        .unwrap_or(false)
}

pub(crate) fn update_compound_bounds(g: &mut Graph) {
    if !g.is_compound() {
        return;
    }
    let node_ids = g.nodes();
    for node_id in node_ids {
        if g
            .node_label(&node_id)
            .and_then(|label| label.get("borderLeft"))
            .is_some()
        {
            continue;
        }
        let children = g.children(Some(&node_id));
        if children.is_empty() {
            continue;
        }

        let mut min_y = f64::INFINITY;
        let mut max_y = f64::NEG_INFINITY;
        for child in &children {
            let Some(label) = g.node_label(child) else {
                continue;
            };
            let y = label.get("y").and_then(serde_json::Value::as_f64);
            let h = label.get("height").and_then(serde_json::Value::as_f64);
            if let (Some(y), Some(h)) = (y, h) {
                min_y = min_y.min(y - h / 2.0);
                max_y = max_y.max(y + h / 2.0);
            }
        }
        if !min_y.is_finite() || !max_y.is_finite() {
            continue;
        }

        let mut label = g
            .node_label(&node_id)
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        if !label.is_object() {
            label = serde_json::json!({});
        }

        let current_width = label
            .get("width")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(10.0);
        let width = (current_width * 2.0).max(20.0);
        let height = (max_y - min_y) + 20.0;
        let x = width / 2.0;
        let y = min_y + height / 2.0;

        label["width"] = serde_json::json!(width);
        label["height"] = serde_json::json!(height);
        label["x"] = serde_json::json!(x);
        label["y"] = serde_json::json!(y);
        g.set_node(&node_id, label);
    }
}

#[cfg(test)]
mod tests {
    use super::run_position_pipeline;
    use crate::graph::Graph;
    use crate::pipeline::edge::run_edge_pipeline;
    use crate::pipeline::order::order;
    use crate::pipeline::rank::run_rank_pipeline;

    #[test]
    fn assigns_coordinates_to_ranked_nodes() {
        let mut graph = Graph::new(false, false);
        graph.set_node("a", serde_json::json!({}));
        graph.set_node("b", serde_json::json!({}));
        graph.set_node("c", serde_json::json!({}));
        graph.set_edge("a", "b", serde_json::json!({"minlen": 1}));
        graph.set_edge("a", "c", serde_json::json!({"minlen": 1}));

        run_rank_pipeline(&mut graph).expect("rank pipeline should succeed");
        order(&mut graph, &serde_json::json!({}));
        run_position_pipeline(&mut graph, &serde_json::json!({}));

        for node in graph.nodes() {
            let label = graph.node_label(&node).expect("node label should exist");
            assert!(label.get("x").and_then(serde_json::Value::as_f64).is_some());
            assert!(label.get("y").and_then(serde_json::Value::as_f64).is_some());
        }
    }

    #[test]
    fn routes_edges_with_non_empty_point_lists() {
        let mut graph = Graph::new(false, false);
        graph.set_node("a", serde_json::json!({}));
        graph.set_node("b", serde_json::json!({}));
        graph.set_node("c", serde_json::json!({}));
        graph.set_edge("a", "b", serde_json::json!({"minlen": 1}));
        graph.set_edge("b", "c", serde_json::json!({"minlen": 1}));

        run_rank_pipeline(&mut graph).expect("rank pipeline should succeed");
        order(&mut graph, &serde_json::json!({}));
        run_position_pipeline(&mut graph, &serde_json::json!({}));
        run_edge_pipeline(&mut graph);

        for edge in graph.edges() {
            let label = graph.edge_label(&edge.id).expect("edge label should exist");
            let points = label
                .get("points")
                .and_then(serde_json::Value::as_array)
                .expect("points should be an array");
            assert!(!points.is_empty(), "routed edge should contain points");
        }
    }

    #[test]
    fn uses_node_size_and_layout_spacing() {
        let mut graph = Graph::new(false, false);
        graph.set_node("a", serde_json::json!({"rank": 0, "order": 0, "width": 100, "height": 20}));
        graph.set_node("b", serde_json::json!({"rank": 0, "order": 1, "width": 200, "height": 20}));
        graph.set_node("c", serde_json::json!({"rank": 1, "order": 0, "width": 80, "height": 40}));

        run_position_pipeline(&mut graph, &serde_json::json!({"nodesep": 20, "ranksep": 30}));

        let ax = graph
            .node_label("a")
            .and_then(|label| label.get("x"))
            .and_then(serde_json::Value::as_f64)
            .expect("a.x");
        let bx = graph
            .node_label("b")
            .and_then(|label| label.get("x"))
            .and_then(serde_json::Value::as_f64)
            .expect("b.x");
        let ay = graph
            .node_label("a")
            .and_then(|label| label.get("y"))
            .and_then(serde_json::Value::as_f64)
            .expect("a.y");
        let cy = graph
            .node_label("c")
            .and_then(|label| label.get("y"))
            .and_then(serde_json::Value::as_f64)
            .expect("c.y");

        assert!((ax - (-110.0)).abs() < 1e-6, "expected a.x=-110, got {ax}");
        assert!((bx - 60.0).abs() < 1e-6, "expected b.x=60, got {bx}");
        assert!((ay - 10.0).abs() < 1e-6, "expected a.y=10, got {ay}");
        assert!((cy - 70.0).abs() < 1e-6, "expected c.y=70, got {cy}");
    }

    #[test]
    fn includes_empty_rank_layers_when_assigning_y() {
        let mut graph = Graph::new(false, false);
        graph.set_node("a", serde_json::json!({"rank": 0, "order": 0, "width": 80, "height": 36}));
        graph.set_node("b", serde_json::json!({"rank": 2, "order": 0, "width": 80, "height": 36}));

        run_position_pipeline(&mut graph, &serde_json::json!({"ranksep": 10, "nodesep": 20}));

        let ay = graph
            .node_label("a")
            .and_then(|label| label.get("y"))
            .and_then(serde_json::Value::as_f64)
            .expect("a.y");
        let by = graph
            .node_label("b")
            .and_then(|label| label.get("y"))
            .and_then(serde_json::Value::as_f64)
            .expect("b.y");

        assert!((ay - 18.0).abs() < 1e-6, "expected a.y=18, got {ay}");
        assert!((by - 74.0).abs() < 1e-6, "expected b.y=74, got {by}");
    }

    #[test]
    fn compound_node_tracks_children_bounds() {
        let mut graph = Graph::new(true, false);
        graph.set_node("cluster", serde_json::json!({"width": 10, "height": 10}));
        graph.set_node("a", serde_json::json!({"rank": 0, "order": 0, "width": 96, "height": 36}));
        graph.set_node("b", serde_json::json!({"rank": 2, "order": 0, "width": 112, "height": 42}));
        graph.set_node("c", serde_json::json!({"rank": 2, "order": 1, "width": 112, "height": 42}));
        graph.set_parent("a", Some("cluster"));
        graph.set_parent("b", Some("cluster"));
        graph.set_parent("c", Some("cluster"));

        run_position_pipeline(&mut graph, &serde_json::json!({"nodesep": 20, "ranksep": 10}));

        let cluster = graph.node_label("cluster").expect("cluster label");
        let x = cluster.get("x").and_then(serde_json::Value::as_f64).expect("cluster x");
        let y = cluster.get("y").and_then(serde_json::Value::as_f64).expect("cluster y");
        let width = cluster.get("width").and_then(serde_json::Value::as_f64).expect("cluster width");
        let height = cluster.get("height").and_then(serde_json::Value::as_f64).expect("cluster height");
        assert!((x - 10.0).abs() < 1e-6, "expected cluster x=10, got {x}");
        assert!((y - 59.0).abs() < 1e-6, "expected cluster y=59, got {y}");
        assert!((width - 20.0).abs() < 1e-6, "expected cluster width=20, got {width}");
        assert!((height - 118.0).abs() < 1e-6, "expected cluster height=118, got {height}");
    }

    #[test]
    fn excludes_compound_containers_from_rank_layer_positioning() {
        let mut graph = Graph::new(true, false);
        graph.set_node("cluster", serde_json::json!({"rank": 0, "order": 0, "width": 200, "height": 20}));
        graph.set_node("a", serde_json::json!({"rank": 0, "order": 1, "width": 10, "height": 10}));
        graph.set_node("b", serde_json::json!({"rank": 0, "order": 2, "width": 10, "height": 10}));
        graph.set_node("c", serde_json::json!({"rank": 1, "order": 0, "width": 10, "height": 10}));
        graph.set_parent("a", Some("cluster"));
        graph.set_parent("c", Some("cluster"));

        run_position_pipeline(&mut graph, &serde_json::json!({"nodesep": 20, "ranksep": 10}));

        let ax = graph
            .node_label("a")
            .and_then(|label| label.get("x"))
            .and_then(serde_json::Value::as_f64)
            .expect("a.x");
        let bx = graph
            .node_label("b")
            .and_then(|label| label.get("x"))
            .and_then(serde_json::Value::as_f64)
            .expect("b.x");
        assert!((ax - (-15.0)).abs() < 1e-6, "expected a.x=-15, got {ax}");
        assert!((bx - 15.0).abs() < 1e-6, "expected b.x=15, got {bx}");
    }

    #[test]
    fn aligns_multi_input_nodes_to_predecessor_center() {
        let mut graph = Graph::new(false, false);
        graph.set_node("a", serde_json::json!({"rank": 0, "order": 0, "width": 96, "height": 36}));
        graph.set_node("b", serde_json::json!({"rank": 1, "order": 0, "width": 112, "height": 42}));
        graph.set_node("c", serde_json::json!({"rank": 1, "order": 1, "width": 112, "height": 42}));
        graph.set_node("d", serde_json::json!({"rank": 2, "order": 0, "width": 96, "height": 36}));
        graph.set_edge("a", "b", serde_json::json!({"minlen": 1}));
        graph.set_edge("a", "c", serde_json::json!({"minlen": 1}));
        graph.set_edge("b", "d", serde_json::json!({"minlen": 1}));
        graph.set_edge("c", "d", serde_json::json!({"minlen": 1}));

        run_position_pipeline(&mut graph, &serde_json::json!({"nodesep": 20, "ranksep": 10}));

        let bx = graph
            .node_label("b")
            .and_then(|label| label.get("x"))
            .and_then(serde_json::Value::as_f64)
            .expect("b.x");
        let cx = graph
            .node_label("c")
            .and_then(|label| label.get("x"))
            .and_then(serde_json::Value::as_f64)
            .expect("c.x");
        let dx = graph
            .node_label("d")
            .and_then(|label| label.get("x"))
            .and_then(serde_json::Value::as_f64)
            .expect("d.x");
        let expected = (bx + cx) / 2.0;
        assert!((dx - expected).abs() < 1e-6, "expected d.x={expected}, got {dx}");
    }
}
