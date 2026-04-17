use std::collections::BTreeMap;

use crate::graph::Graph;

const NODE_SEP: f64 = 80.0;
const RANK_SEP: f64 = 100.0;

pub fn run_position_pipeline(g: &mut Graph) {
    let mut layers: BTreeMap<i64, Vec<String>> = BTreeMap::new();
    for node in g.nodes() {
        if let Some(rank) = node_rank(g, &node) {
            layers.entry(rank).or_default().push(node);
        }
    }

    for (rank, layer) in &mut layers {
        layer.sort_by(|left, right| {
            node_order(g, left)
                .cmp(&node_order(g, right))
                .then_with(|| left.cmp(right))
        });

        let center = (layer.len().saturating_sub(1)) as f64 / 2.0;
        for (index, node) in layer.iter().enumerate() {
            let x = (index as f64 - center) * NODE_SEP;
            let y = *rank as f64 * RANK_SEP;
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
    }
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
        run_position_pipeline(&mut graph);

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
        run_position_pipeline(&mut graph);
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
}
