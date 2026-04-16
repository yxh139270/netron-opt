use crate::graph::Graph;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Relationship {
    In,
    Out,
}

pub fn build_layer_graph(g: &Graph, rank: i64, relationship: Relationship) -> Graph {
    let mut layer_graph = Graph::new(false, false);

    let mut movable = g
        .nodes()
        .into_iter()
        .filter(|id| node_rank(g, id) == Some(rank))
        .collect::<Vec<_>>();
    movable.sort();

    for node in &movable {
        layer_graph.set_node(node, serde_json::json!({}));
    }

    for edge in g.edges() {
        let weight = edge_weight(g, &edge.id);
        match relationship {
            Relationship::In => {
                if node_rank(g, &edge.w) == Some(rank) {
                    add_or_accumulate_edge(&mut layer_graph, &edge.v, &edge.w, weight);
                }
            }
            Relationship::Out => {
                if node_rank(g, &edge.v) == Some(rank) {
                    add_or_accumulate_edge(&mut layer_graph, &edge.w, &edge.v, weight);
                }
            }
        }
    }

    layer_graph
}

pub fn init_order(g: &mut Graph) -> Vec<Vec<String>> {
    let nodes = g.nodes();
    let mut max_rank = -1_i64;
    for node in &nodes {
        if let Some(rank) = node_rank(g, node) {
            max_rank = max_rank.max(rank);
        }
    }
    if max_rank < 0 {
        return Vec::new();
    }

    let mut layers = vec![Vec::new(); (max_rank + 1) as usize];
    let mut visited = std::collections::HashSet::new();

    let mut starts = nodes
        .iter()
        .filter_map(|node| node_rank(g, node).map(|rank| (node.clone(), rank)))
        .collect::<Vec<_>>();
    starts.sort_by(|left, right| left.1.cmp(&right.1).then(left.0.cmp(&right.0)));

    let mut queue: std::collections::VecDeque<String> =
        starts.into_iter().map(|entry| entry.0).collect();

    while let Some(v) = queue.pop_front() {
        if !visited.insert(v.clone()) {
            continue;
        }
        if let Some(rank) = node_rank(g, &v) {
            let rank_usize = rank as usize;
            if !layers[rank_usize].contains(&v) {
                layers[rank_usize].push(v.clone());
            }
        }
        for succ in g.successors(&v) {
            queue.push_back(succ);
        }
    }

    layers
}

pub fn order(g: &mut Graph, _state: &serde_json::Value) {
    let mut layering = init_order(g);
    assign_order(g, &layering);

    let max_rank = layering.len().saturating_sub(1) as i64;
    if max_rank <= 0 {
        return;
    }

    let mut best_layering = layering.clone();
    let mut best_crossings = cross_count(g, &best_layering);
    let mut rounds_since_best = 0;

    for iter in 0..16 {
        let downward = iter % 2 == 0;
        let bias_right = iter % 4 >= 2;

        if downward {
            for rank in 1..=max_rank {
                let layer_graph = build_layer_graph(g, rank, Relationship::In);
                reorder_rank(g, rank, &layer_graph, bias_right);
            }
        } else {
            for rank in (0..max_rank).rev() {
                let layer_graph = build_layer_graph(g, rank, Relationship::Out);
                reorder_rank(g, rank, &layer_graph, bias_right);
            }
        }

        layering = build_layer_matrix(g);
        let crossings = cross_count(g, &layering);
        if crossings < best_crossings {
            best_crossings = crossings;
            best_layering = layering.clone();
            rounds_since_best = 0;
        } else {
            rounds_since_best += 1;
            if rounds_since_best >= 4 {
                break;
            }
        }
    }

    assign_order(g, &best_layering);
}

fn add_or_accumulate_edge(g: &mut Graph, v: &str, w: &str, weight: f64) {
    let edge_id = format!("{}->{}", v, w);
    let current = g
        .edge_label(&edge_id)
        .and_then(|label| label.get("weight"))
        .and_then(serde_json::Value::as_f64)
        .unwrap_or(0.0);
    g.set_edge(v, w, serde_json::json!({ "weight": current + weight }));
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

fn edge_weight(g: &Graph, edge_id: &str) -> f64 {
    g.edge_label(edge_id)
        .and_then(|label| label.get("weight"))
        .and_then(serde_json::Value::as_f64)
        .filter(|weight| *weight > 0.0)
        .unwrap_or(1.0)
}

fn assign_order(g: &mut Graph, layering: &[Vec<String>]) {
    for layer in layering {
        for (order, node) in layer.iter().enumerate() {
            let mut label = g
                .node_label(node)
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            if !label.is_object() {
                label = serde_json::json!({});
            }
            label["order"] = serde_json::json!(order);
            g.set_node(node, label);
        }
    }
}

fn reorder_rank(g: &mut Graph, rank: i64, layer_graph: &Graph, bias_right: bool) {
    let mut nodes = g
        .nodes()
        .into_iter()
        .filter(|id| node_rank(g, id) == Some(rank))
        .map(|id| {
            let order = node_order(g, &id);
            (id, order)
        })
        .collect::<Vec<_>>();

    if nodes.len() <= 1 {
        return;
    }

    nodes.sort_by_key(|entry| entry.1);

    let mut sortable = Vec::new();
    let mut unsortable = Vec::new();
    for (id, order) in &nodes {
        if let Some((barycenter, weight)) = barycenter_for_node(layer_graph, id, g) {
            sortable.push((id.clone(), *order, barycenter, weight));
        } else {
            unsortable.push((id.clone(), *order));
        }
    }

    sortable.sort_by(|left, right| {
        left.2
            .partial_cmp(&right.2)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                if bias_right {
                    right.1.cmp(&left.1)
                } else {
                    left.1.cmp(&right.1)
                }
            })
    });

    unsortable.sort_by_key(|entry| std::cmp::Reverse(entry.1));
    let mut merged = Vec::with_capacity(nodes.len());
    let mut index = 0_usize;

    consume_unsortable(&mut merged, &mut unsortable, &mut index);
    for entry in &sortable {
        merged.push(entry.0.clone());
        index += 1;
        consume_unsortable(&mut merged, &mut unsortable, &mut index);
    }

    if merged.len() == nodes.len() {
        for (new_order, node) in merged.into_iter().enumerate() {
            let mut label = g
                .node_label(&node)
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            if !label.is_object() {
                label = serde_json::json!({});
            }
            label["order"] = serde_json::json!(new_order);
            g.set_node(&node, label);
        }
    }
}

fn consume_unsortable(
    merged: &mut Vec<String>,
    unsortable: &mut Vec<(String, usize)>,
    index: &mut usize,
) {
    while let Some(last) = unsortable.last() {
        if last.1 > *index {
            break;
        }
        let node = unsortable
            .pop()
            .map(|entry| entry.0)
            .expect("unsortable should have entry");
        merged.push(node);
        *index += 1;
    }
}

fn barycenter_for_node(layer_graph: &Graph, node: &str, original: &Graph) -> Option<(f64, f64)> {
    let mut sum = 0.0_f64;
    let mut total_weight = 0.0_f64;
    for edge in layer_graph.edges() {
        if edge.w != node {
            continue;
        }
        let weight = edge_weight(layer_graph, &edge.id);
        let order = node_order(original, &edge.v) as f64;
        sum += order * weight;
        total_weight += weight;
    }
    if total_weight > 0.0 {
        Some((sum / total_weight, total_weight))
    } else {
        None
    }
}

fn build_layer_matrix(g: &Graph) -> Vec<Vec<String>> {
    let mut max_rank = -1_i64;
    for node in g.nodes() {
        if let Some(rank) = node_rank(g, &node) {
            max_rank = max_rank.max(rank);
        }
    }
    if max_rank < 0 {
        return Vec::new();
    }

    let mut layers = vec![Vec::new(); (max_rank + 1) as usize];
    for node in g.nodes() {
        if let Some(rank) = node_rank(g, &node) {
            layers[rank as usize].push(node);
        }
    }
    for layer in &mut layers {
        layer.sort_by_key(|node| node_order(g, node));
    }
    layers
}

fn cross_count(g: &Graph, layering: &[Vec<String>]) -> f64 {
    let mut total = 0.0_f64;
    let mut node_pos = std::collections::HashMap::new();
    for (rank, layer) in layering.iter().enumerate() {
        for (order, node) in layer.iter().enumerate() {
            node_pos.insert(node.as_str(), (rank as i64, order as f64));
        }
    }

    let edges = g.edges();
    for layer_index in 1..layering.len() {
        let boundary = (layer_index - 1) as i64;
        let mut segments = Vec::new();

        for edge in &edges {
            let Some((rv, pv)) = node_pos.get(edge.v.as_str()).copied() else {
                continue;
            };
            let Some((rw, pw)) = node_pos.get(edge.w.as_str()).copied() else {
                continue;
            };

            let (r0, p0, r1, p1) = if rv <= rw {
                (rv, pv, rw, pw)
            } else {
                (rw, pw, rv, pv)
            };
            if r0 == r1 || boundary < r0 || boundary >= r1 {
                continue;
            }

            let span = (r1 - r0) as f64;
            let top_t = (boundary - r0) as f64 / span;
            let bottom_t = (boundary + 1 - r0) as f64 / span;
            let x_top = p0 + (p1 - p0) * top_t;
            let x_bottom = p0 + (p1 - p0) * bottom_t;
            segments.push((x_top, x_bottom, edge_weight(g, &edge.id)));
        }

        if segments.len() < 2 {
            continue;
        }

        total += weighted_crossings(&segments);
    }
    total
}

fn weighted_crossings(segments: &[(f64, f64, f64)]) -> f64 {
    let mut ordered = segments.to_vec();
    ordered.sort_by(|a, b| {
        a.0.total_cmp(&b.0)
            .then_with(|| a.1.total_cmp(&b.1))
    });

    let mut x2_values = ordered.iter().map(|item| item.1).collect::<Vec<_>>();
    x2_values.sort_by(|a, b| a.total_cmp(b));
    x2_values.dedup_by(|a, b| a.total_cmp(b) == std::cmp::Ordering::Equal);

    let mut bit = vec![0.0_f64; x2_values.len() + 1];
    let mut seen_weight = 0.0_f64;
    let mut total = 0.0_f64;

    for (_x1, x2, weight) in &ordered {
        let pos = x2_values
            .binary_search_by(|value| value.total_cmp(x2))
            .expect("x2 must exist")
            + 1;
        let prefix = fenwick_sum(&bit, pos);
        total += (seen_weight - prefix) * *weight;
        fenwick_add(&mut bit, pos, *weight);
        seen_weight += *weight;
    }
    total
}

fn fenwick_add(bit: &mut [f64], mut index: usize, value: f64) {
    while index < bit.len() {
        bit[index] += value;
        index += index & index.wrapping_neg();
    }
}

fn fenwick_sum(bit: &[f64], mut index: usize) -> f64 {
    let mut sum = 0.0_f64;
    while index > 0 {
        sum += bit[index];
        index -= index & index.wrapping_neg();
    }
    sum
}

#[cfg(test)]
mod tests {
    use super::{Relationship, build_layer_graph, init_order, order};
    use crate::graph::Graph;

    fn edge_ids(g: &Graph) -> Vec<String> {
        g.edges().into_iter().map(|edge| edge.id).collect()
    }

    #[test]
    fn ordering_build_layer_graph_collects_incident_edges() {
        let mut graph = Graph::new(false, false);
        graph.set_node("a", serde_json::json!({"rank": 0}));
        graph.set_node("b", serde_json::json!({"rank": 0}));
        graph.set_node("c", serde_json::json!({"rank": 1}));
        graph.set_node("d", serde_json::json!({"rank": 2}));
        graph.set_edge("a", "c", serde_json::json!({"weight": 1}));
        graph.set_edge("b", "c", serde_json::json!({"weight": 1}));
        graph.set_edge("c", "d", serde_json::json!({"weight": 1}));

        let down = build_layer_graph(&graph, 1, Relationship::In);
        assert_eq!(down.node_count(), 3);
        assert_eq!(edge_ids(&down), vec!["a->c", "b->c"]);

        let up = build_layer_graph(&graph, 1, Relationship::Out);
        assert_eq!(up.node_count(), 2);
        assert_eq!(edge_ids(&up), vec!["d->c"]);
    }

    #[test]
    fn ordering_reduces_crossings_vs_initial_order() {
        let mut graph = Graph::new(false, false);
        graph.set_node("a", serde_json::json!({"rank": 0}));
        graph.set_node("b", serde_json::json!({"rank": 0}));
        graph.set_node("c", serde_json::json!({"rank": 1}));
        graph.set_node("d", serde_json::json!({"rank": 1}));

        graph.set_edge("a", "c", serde_json::json!({"weight": 1}));
        graph.set_edge("a", "d", serde_json::json!({"weight": 1}));
        graph.set_edge("b", "c", serde_json::json!({"weight": 1}));

        let initial_layering = init_order(&mut graph);
        let initial_crossings = super::cross_count(&graph, &initial_layering);
        assert!(initial_crossings > 0.0);

        order(&mut graph, &serde_json::json!({}));
        let final_layering = super::build_layer_matrix(&graph);
        let final_crossings = super::cross_count(&graph, &final_layering);
        assert!(final_crossings <= initial_crossings);
    }

    #[test]
    fn crossing_count_includes_long_edges() {
        let mut graph = Graph::new(false, false);
        graph.set_node("a", serde_json::json!({"rank": 0, "order": 0}));
        graph.set_node("b", serde_json::json!({"rank": 0, "order": 1}));
        graph.set_node("e", serde_json::json!({"rank": 1, "order": 0}));
        graph.set_node("c", serde_json::json!({"rank": 2, "order": 0}));
        graph.set_node("d", serde_json::json!({"rank": 2, "order": 1}));
        graph.set_edge("a", "d", serde_json::json!({"weight": 1, "minlen": 2}));
        graph.set_edge("b", "e", serde_json::json!({"weight": 1, "minlen": 1}));

        let layering = vec![
            vec!["a".to_string(), "b".to_string()],
            vec!["e".to_string()],
            vec!["c".to_string(), "d".to_string()],
        ];
        let crossings = super::cross_count(&graph, &layering);
        assert!(crossings > 0.0);
    }
}
