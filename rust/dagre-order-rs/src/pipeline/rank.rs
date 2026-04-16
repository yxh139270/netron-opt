use std::collections::{HashMap, HashSet};

use crate::graph::Graph;
use crate::pipeline::normalize::normalize_graph;
use crate::util::edge_minlen;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RankError {
    Overflow,
    UnsatisfiedConstraints,
}

impl RankError {
    pub fn message(&self) -> &'static str {
        match self {
            RankError::Overflow => "rank_overflow",
            RankError::UnsatisfiedConstraints => "rank_unsatisfied_constraints",
        }
    }
}

pub fn run_rank_pipeline(g: &mut Graph) -> Result<(), RankError> {
    let mut ranks = assign_ranks(g)?;
    normalize_graph(&mut ranks);
    write_ranks(g, &ranks);
    Ok(())
}

fn assign_ranks(g: &Graph) -> Result<HashMap<String, i64>, RankError> {
    let edges = g.edges();
    let mut nodes: HashSet<String> = g.nodes().into_iter().collect();
    for edge in &edges {
        nodes.insert(edge.v.clone());
        nodes.insert(edge.w.clone());
    }

    let mut ranks: HashMap<String, i64> = HashMap::new();
    for node in &nodes {
        let seed_rank = g
            .node_label(node)
            .and_then(|label| label.get("rank"))
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0);
        ranks.insert(node.clone(), seed_rank);
    }

    let rounds = nodes.len().max(1);
    for _ in 0..rounds {
        let mut changed = false;
        for edge in &edges {
            let minlen = edge_minlen(g.edge_label(&edge.id).expect("edge label should exist"));
            let v_rank = *ranks.get(&edge.v).unwrap_or(&0);
            let Some(candidate) = v_rank.checked_add(minlen) else {
                return Err(RankError::Overflow);
            };
            let w_entry = ranks.entry(edge.w.clone()).or_insert(0);
            if candidate > *w_entry {
                *w_entry = candidate;
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }

    for edge in &edges {
        let minlen = edge_minlen(g.edge_label(&edge.id).expect("edge label should exist"));
        let v_rank = *ranks.get(&edge.v).unwrap_or(&0);
        let w_rank = *ranks.get(&edge.w).unwrap_or(&0);
        let Some(diff) = w_rank.checked_sub(v_rank) else {
            return Err(RankError::Overflow);
        };
        if diff < minlen {
            return Err(RankError::UnsatisfiedConstraints);
        }
    }

    Ok(ranks)
}

fn write_ranks(g: &mut Graph, ranks: &HashMap<String, i64>) {
    for (node, rank) in ranks {
        let mut label = g
            .node_label(node)
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        if !label.is_object() {
            label = serde_json::json!({});
        }
        label["rank"] = serde_json::json!(*rank);
        g.set_node(node, label);
    }
}

#[cfg(test)]
fn node_rank(g: &Graph, id: &str) -> i64 {
    g.node_label(id)
        .and_then(|label| label.get("rank"))
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use crate::util::edge_minlen;
    use crate::graph::Graph;

    use super::{node_rank, run_rank_pipeline};

    #[test]
    fn rank_pipeline_preserves_minlen_constraints() {
        let mut graph = Graph::new(false, false);
        graph.set_node("a", serde_json::json!({}));
        graph.set_node("b", serde_json::json!({}));
        graph.set_node("c", serde_json::json!({}));
        graph.set_edge("a", "b", serde_json::json!({"minlen": 2}));
        graph.set_edge("b", "c", serde_json::json!({"minlen": 1}));
        graph.set_edge("a", "c", serde_json::json!({"minlen": 4}));

        run_rank_pipeline(&mut graph).expect("rank pipeline should succeed");

        for edge in graph.edges() {
            let edge_label = graph.edge_label(&edge.id).expect("edge label should exist");
            let minlen = edge_minlen(edge_label);
            let v_rank = node_rank(&graph, &edge.v);
            let w_rank = node_rank(&graph, &edge.w);
            assert!(
                w_rank - v_rank >= minlen,
                "edge {}->{} violated minlen: {} - {} < {}",
                edge.v,
                edge.w,
                w_rank,
                v_rank,
                minlen
            );
        }
    }

    #[test]
    fn rank_pipeline_normalizes_lowest_rank_to_zero() {
        let mut graph = Graph::new(false, false);
        graph.set_node("a", serde_json::json!({"rank": -4}));
        graph.set_node("b", serde_json::json!({"rank": -1}));
        graph.set_edge("a", "b", serde_json::json!({"minlen": 1}));

        run_rank_pipeline(&mut graph).expect("rank pipeline should succeed");

        let a_rank = node_rank(&graph, "a");
        let b_rank = node_rank(&graph, "b");
        assert_eq!(a_rank, 0);
        assert!(b_rank >= a_rank + 1);
    }

    #[test]
    fn rank_pipeline_reports_unsatisfied_cycle_constraints() {
        let mut graph = Graph::new(false, false);
        graph.set_node("a", serde_json::json!({}));
        graph.set_node("b", serde_json::json!({}));
        graph.set_edge("a", "b", serde_json::json!({"minlen": 1}));
        graph.set_edge("b", "a", serde_json::json!({"minlen": 1}));

        let result = run_rank_pipeline(&mut graph);
        assert!(matches!(result, Err(super::RankError::UnsatisfiedConstraints)));
    }
}
