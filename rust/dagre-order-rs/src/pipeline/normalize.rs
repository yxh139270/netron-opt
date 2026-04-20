use std::collections::HashMap;

use crate::graph::Graph;

pub fn normalize_graph(ranks: &mut HashMap<String, i64>) {
    let Some(min_rank) = ranks.values().copied().min() else {
        return;
    };
    if min_rank == 0 {
        return;
    }
    for rank in ranks.values_mut() {
        if let Some(value) = rank.checked_sub(min_rank) {
            *rank = value;
        }
    }
}

#[derive(Debug, Clone)]
pub struct DummyChain {
    pub original_edge_id: String,
    pub original_v: String,
    pub original_w: String,
    pub original_label: serde_json::Value,
    pub segment_edge_ids: Vec<String>,
    pub dummy_nodes: Vec<String>,
}

pub fn normalize_long_edges(g: &mut Graph) -> Vec<DummyChain> {
    let mut chains = Vec::new();
    let mut dummy_counter = 0_usize;
    let edges = g.edges();

    for edge in edges {
        let Some((v_rank, w_rank)) = edge_ranks(g, &edge.v, &edge.w) else {
            continue;
        };
        if w_rank <= v_rank + 1 {
            continue;
        }

        let original_label = g
            .edge_label(&edge.id)
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        let weight = original_label
            .get("weight")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(1);
        let label_rank = original_label
            .get("labelRank")
            .and_then(serde_json::Value::as_i64);

        if !g.remove_edge(&edge.id) {
            continue;
        }

        let mut segment_edge_ids = Vec::new();
        let mut dummy_nodes = Vec::new();
        let mut prev = edge.v.clone();

        for rank in (v_rank + 1)..w_rank {
            let dummy = next_dummy_id(g, "_d", &mut dummy_counter);
            let mut node_label = serde_json::json!({
                "width": 0,
                "height": 0,
                "rank": rank,
                "dummy": "edge"
            });
            if label_rank == Some(rank) {
                node_label["width"] = serde_json::json!(
                    original_label
                        .get("width")
                        .and_then(serde_json::Value::as_f64)
                        .unwrap_or(0.0)
                );
                node_label["height"] = serde_json::json!(
                    original_label
                        .get("height")
                        .and_then(serde_json::Value::as_f64)
                        .unwrap_or(0.0)
                );
                node_label["dummy"] = serde_json::json!("edge-label");
                if let Some(labelpos) = original_label
                    .get("labelpos")
                    .and_then(serde_json::Value::as_str)
                {
                    node_label["labelpos"] = serde_json::json!(labelpos);
                }
            }
            g.set_node(&dummy, node_label);
            let seg = g.set_edge(
                &prev,
                &dummy,
                serde_json::json!({
                    "weight": weight,
                    "minlen": 1
                }),
            );
            segment_edge_ids.push(seg);
            dummy_nodes.push(dummy.clone());
            prev = dummy;
        }

        let tail = g.set_edge(
            &prev,
            &edge.w,
            serde_json::json!({
                "weight": weight,
                "minlen": 1
            }),
        );
        segment_edge_ids.push(tail);

        chains.push(DummyChain {
            original_edge_id: edge.id,
            original_v: edge.v,
            original_w: edge.w,
            original_label,
            segment_edge_ids,
            dummy_nodes,
        });
    }

    chains
}

pub fn denormalize_long_edges(g: &mut Graph, chains: Vec<DummyChain>) {
    for chain in chains {
        // 在移除 dummy 节点之前，收集它们的坐标作为 edge points
        let mut points = Vec::new();
        for node_id in &chain.dummy_nodes {
            if let Some(label) = g.node_label(node_id) {
                let x = label.get("x").and_then(serde_json::Value::as_f64).unwrap_or(0.0);
                let y = label.get("y").and_then(serde_json::Value::as_f64).unwrap_or(0.0);
                points.push(serde_json::json!({"x": x, "y": y}));
            }
        }

        for edge_id in &chain.segment_edge_ids {
            let _ = g.remove_edge(edge_id);
        }
        for node_id in &chain.dummy_nodes {
            let _ = g.remove_node(node_id);
        }

        let mut restored_label = chain.original_label;
        if !restored_label.is_object() {
            restored_label = serde_json::json!({});
        }
        if !points.is_empty() {
            restored_label["points"] = serde_json::Value::Array(points);
        }

        if edge_key_from_id(&chain.original_edge_id).is_some() && g.is_multigraph() {
            let key = edge_key_from_id(&chain.original_edge_id).unwrap_or_default();
            let restored = g.set_edge_with_key(
                &chain.original_v,
                &chain.original_w,
                Some(key),
                restored_label,
            );
            if restored != chain.original_edge_id {
                let _ = g.remove_edge(&restored);
                let _ = g.set_edge(&chain.original_v, &chain.original_w, serde_json::json!({}));
            }
        } else {
            let _ = g.set_edge(&chain.original_v, &chain.original_w, restored_label);
        }
    }
}

fn edge_key_from_id(edge_id: &str) -> Option<&str> {
    edge_id.split_once('#').map(|(_, key)| key)
}

fn edge_ranks(g: &Graph, v: &str, w: &str) -> Option<(i64, i64)> {
    let v_rank = g
        .node_label(v)
        .and_then(|label| label.get("rank"))
        .and_then(serde_json::Value::as_i64)?;
    let w_rank = g
        .node_label(w)
        .and_then(|label| label.get("rank"))
        .and_then(serde_json::Value::as_i64)?;
    Some((v_rank, w_rank))
}

fn next_dummy_id(g: &Graph, prefix: &str, counter: &mut usize) -> String {
    loop {
        let id = format!("{}{}", prefix, *counter);
        *counter += 1;
        if g.node_label(&id).is_none() {
            return id;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use crate::graph::Graph;

    use super::{normalize_graph, normalize_long_edges};

    #[test]
    fn normalize_graph_shifts_lowest_rank_to_zero() {
        let mut ranks = HashMap::from([
            ("a".to_string(), -2),
            ("b".to_string(), 0),
            ("c".to_string(), 3),
        ]);

        normalize_graph(&mut ranks);

        let min_rank = ranks.values().copied().min().expect("non-empty");
        assert_eq!(min_rank, 0);
        assert_eq!(ranks.get("a"), Some(&0));
        assert_eq!(ranks.get("b"), Some(&2));
        assert_eq!(ranks.get("c"), Some(&5));
    }

    #[test]
    fn normalize_long_edges_injects_edge_label_dummy_at_label_rank() {
        let mut graph = Graph::new(false, false);
        graph.set_node("a", serde_json::json!({"rank": 0, "width": 80, "height": 20}));
        graph.set_node("b", serde_json::json!({"rank": 4, "width": 80, "height": 20}));
        graph.set_edge(
            "a",
            "b",
            serde_json::json!({
                "minlen": 4,
                "weight": 1,
                "width": 77,
                "height": 14,
                "labelRank": 2,
                "labelpos": "r"
            }),
        );

        let _chains = normalize_long_edges(&mut graph);

        let mut found = false;
        for node_id in graph.nodes() {
            let Some(label) = graph.node_label(&node_id) else {
                continue;
            };
            if label
                .get("dummy")
                .and_then(serde_json::Value::as_str)
                .map(|v| v == "edge-label")
                .unwrap_or(false)
            {
                let rank = label
                    .get("rank")
                    .and_then(serde_json::Value::as_i64)
                    .expect("edge-label rank");
                let width = label
                    .get("width")
                    .and_then(serde_json::Value::as_f64)
                    .expect("edge-label width");
                let height = label
                    .get("height")
                    .and_then(serde_json::Value::as_f64)
                    .expect("edge-label height");
                let labelpos = label
                    .get("labelpos")
                    .and_then(serde_json::Value::as_str)
                    .expect("edge-label labelpos");
                assert_eq!(rank, 2, "expected edge-label rank=2, got {rank}");
                assert!((width - 77.0).abs() < 1e-6, "expected width=77, got {width}");
                assert!((height - 14.0).abs() < 1e-6, "expected height=14, got {height}");
                assert_eq!(labelpos, "r");
                found = true;
            }
        }

        assert!(found, "expected at least one edge-label dummy");
    }

    #[test]
    fn normalize_long_edges_skips_edge_label_dummy_without_label_rank() {
        let mut graph = Graph::new(false, false);
        graph.set_node("a", serde_json::json!({"rank": 0, "width": 80, "height": 20}));
        graph.set_node("b", serde_json::json!({"rank": 4, "width": 80, "height": 20}));
        graph.set_edge(
            "a",
            "b",
            serde_json::json!({
                "minlen": 4,
                "weight": 1,
                "width": 77,
                "height": 14,
                "labelpos": "r"
            }),
        );

        let _chains = normalize_long_edges(&mut graph);

        let mut edge_label_dummy_count = 0;
        for node_id in graph.nodes() {
            let Some(label) = graph.node_label(&node_id) else {
                continue;
            };
            if label
                .get("dummy")
                .and_then(serde_json::Value::as_str)
                .map(|v| v == "edge-label")
                .unwrap_or(false)
            {
                edge_label_dummy_count += 1;
            }
        }

        assert_eq!(
            edge_label_dummy_count, 0,
            "expected no edge-label dummy without labelRank"
        );
    }
}
