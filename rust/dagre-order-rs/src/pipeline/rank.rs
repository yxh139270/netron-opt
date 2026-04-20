use std::collections::{HashMap, HashSet, VecDeque};

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
    let mut nesting_state = NestingState::default();
    if g.is_compound() {
        nesting_graph_run(g, &mut nesting_state);
    }

    let non_compound = g.as_non_compound_graph();
    let mut ranks = assign_ranks(&non_compound)?;
    write_ranks(g, &ranks);

    // JS 流程: injectEdgeLabelProxies → removeEmptyRanks → nestingGraph_cleanup → removeEdgeLabelProxies
    inject_edge_label_proxies(g);
    // 非 compound 时 node_rank_factor=0，表示所有空 rank 都可移除（模拟 JS 的 undefined % n !== 0 → true）
    remove_empty_ranks(g, nesting_state.node_rank_factor);
    if g.is_compound() {
        nesting_graph_cleanup(g, &nesting_state);
    }
    remove_edge_label_proxies(g);

    ranks = collect_ranks(g);
    normalize_graph(&mut ranks);
    write_ranks(g, &ranks);
    Ok(())
}

fn inject_edge_label_proxies(g: &mut Graph) {
    let mut counter = 0_usize;
    let edges = g.edges();
    let mut proxies = Vec::new();
    let mut checked = 0;
    let mut skipped_no_size = 0;
    for edge in &edges {
        let Some(label) = g.edge_label(&edge.id) else {
            continue;
        };
        let width = label.get("width").and_then(serde_json::Value::as_f64).unwrap_or(0.0);
        let height = label.get("height").and_then(serde_json::Value::as_f64).unwrap_or(0.0);
        checked += 1;
        if width == 0.0 && height == 0.0 {
            skipped_no_size += 1;
            continue;
        }
        let v_rank = g
            .node_label(&edge.v)
            .and_then(|l| l.get("rank"))
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0);
        let w_rank = g
            .node_label(&edge.w)
            .and_then(|l| l.get("rank"))
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0);
        let proxy_rank = (w_rank - v_rank) / 2 + v_rank;
        let dummy_id = loop {
            let id = format!("_ep{}", counter);
            counter += 1;
            if g.node_label(&id).is_none() {
                break id;
            }
        };
        proxies.push((dummy_id, proxy_rank, edge.id.clone()));
    }
    eprintln!("[inject_edge_label_proxies] edges={} checked={} skipped_no_size={} proxies={}", edges.len(), checked, skipped_no_size, proxies.len());
    for (dummy_id, proxy_rank, edge_id) in proxies {
        g.set_node(
            &dummy_id,
            serde_json::json!({
                "dummy": "edge-proxy",
                "rank": proxy_rank,
                "width": 0,
                "height": 0,
                "edge_id": edge_id
            }),
        );
    }
}

fn remove_edge_label_proxies(g: &mut Graph) {
    let nodes = g.nodes();
    let mut updates = Vec::new();
    for node_id in &nodes {
        let Some(label) = g.node_label(node_id) else {
            continue;
        };
        let is_proxy = label
            .get("dummy")
            .and_then(serde_json::Value::as_str)
            .map(|v| v == "edge-proxy")
            .unwrap_or(false);
        if !is_proxy {
            continue;
        }
        let proxy_rank = label.get("rank").and_then(serde_json::Value::as_i64);
        let edge_id = label
            .get("edge_id")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        if let (Some(rank), Some(eid)) = (proxy_rank, edge_id) {
            updates.push((node_id.clone(), eid, rank));
        }
    }
    for (node_id, edge_id, rank) in updates {
        g.remove_node(&node_id);
        if let Some(mut edge_label) = g.edge_label(&edge_id).cloned() {
            if edge_label.is_object() {
                edge_label["labelRank"] = serde_json::json!(rank);
                let _ = g.set_edge_label(&edge_id, edge_label);
            }
        }
    }
}

#[derive(Default)]
struct NestingState {
    nesting_root: Option<String>,
    node_rank_factor: i64,
}

fn collect_ranks(g: &Graph) -> HashMap<String, i64> {
    let mut ranks = HashMap::new();
    for node in g.nodes() {
        if let Some(rank) = g
            .node_label(&node)
            .and_then(|label| label.get("rank"))
            .and_then(serde_json::Value::as_i64)
        {
            ranks.insert(node, rank);
        }
    }
    ranks
}

fn set_node_object_field(g: &mut Graph, id: &str, key: &str, value: serde_json::Value) {
    let mut label = g
        .node_label(id)
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    if !label.is_object() {
        label = serde_json::json!({});
    }
    label[key] = value;
    g.set_node(id, label);
}

fn next_dummy_id(g: &Graph, prefix: &str, counter: &mut usize) -> String {
    loop {
        let id = format!("{}_{}", prefix, *counter);
        *counter += 1;
        if g.node_label(&id).is_none() {
            return id;
        }
    }
}

fn add_dummy_node(
    g: &mut Graph,
    dummy_type: &str,
    mut label: serde_json::Value,
    prefix: &str,
    counter: &mut usize,
) -> String {
    if !label.is_object() {
        label = serde_json::json!({});
    }
    label["dummy"] = serde_json::json!(dummy_type);
    let id = next_dummy_id(g, prefix, counter);
    g.set_node(&id, label);
    id
}

fn tree_depths(g: &Graph) -> HashMap<String, i64> {
    fn dfs(g: &Graph, v: &str, depth: i64, out: &mut HashMap<String, i64>) {
        for child in g.children(Some(v)) {
            dfs(g, &child, depth + 1, out);
        }
        out.insert(v.to_string(), depth);
    }

    let mut out = HashMap::new();
    for child in g.children(None) {
        dfs(g, &child, 1, &mut out);
    }
    out
}

fn nesting_graph_run(g: &mut Graph, state: &mut NestingState) {
    let mut counter = 0_usize;
    let root = add_dummy_node(g, "root", serde_json::json!({}), "_root", &mut counter);
    let depths = tree_depths(g);
    let mut height = depths.values().copied().max().unwrap_or(1);
    height = (height - 1).max(0);
    let node_sep = 2 * height + 1;

    for edge in g.edges() {
        let mut label = g
            .edge_label(&edge.id)
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        if !label.is_object() {
            label = serde_json::json!({});
        }
        let minlen = edge_minlen(&label);
        label["minlen"] = serde_json::json!(minlen.saturating_mul(node_sep.max(1)));
        if label.get("weight").and_then(serde_json::Value::as_i64).is_none() {
            label["weight"] = serde_json::json!(1);
        }
        let _ = g.set_edge_label(&edge.id, label);
    }

    let weight = g
        .edges()
        .into_iter()
        .map(|edge| {
            g.edge_label(&edge.id)
                .and_then(|label| label.get("weight"))
                .and_then(serde_json::Value::as_i64)
                .unwrap_or(1)
        })
        .sum::<i64>()
        .saturating_add(1);

    fn dfs(
        g: &mut Graph,
        root: &str,
        node_sep: i64,
        weight: i64,
        height: i64,
        depths: &HashMap<String, i64>,
        v: &str,
        counter: &mut usize,
    ) {
        let children = g.children(Some(v));
        if children.is_empty() {
            if v != root {
                g.set_edge(root, v, serde_json::json!({"weight":0, "minlen": node_sep.max(1)}));
            }
            return;
        }

        let top = add_dummy_node(
            g,
            "border",
            serde_json::json!({"width":0, "height":0}),
            "_bt",
            counter,
        );
        let bottom = add_dummy_node(
            g,
            "border",
            serde_json::json!({"width":0, "height":0}),
            "_bb",
            counter,
        );
        g.set_parent(&top, Some(v));
        g.set_parent(&bottom, Some(v));
        set_node_object_field(g, v, "borderTop", serde_json::json!(top));
        set_node_object_field(g, v, "borderBottom", serde_json::json!(bottom));

        for child in children {
            dfs(g, root, node_sep, weight, height, depths, &child, counter);
            let child_label = g
                .node_label(&child)
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            let child_top = child_label
                .get("borderTop")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| child.clone());
            let child_bottom = child_label
                .get("borderBottom")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| child.clone());
            let this_weight = if child_label.get("borderTop").is_some() {
                weight
            } else {
                weight.saturating_mul(2)
            };
            let depth_v = *depths.get(v).unwrap_or(&1);
            let minlen = if child_top == child_bottom {
                (height - depth_v + 1).max(1)
            } else {
                1
            };

            let top_id = g
                .node_label(v)
                .and_then(|label| label.get("borderTop"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
                .expect("borderTop set");
            let bottom_id = g
                .node_label(v)
                .and_then(|label| label.get("borderBottom"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
                .expect("borderBottom set");

            g.set_edge(
                &top_id,
                &child_top,
                serde_json::json!({"weight": this_weight, "minlen": minlen, "nestingEdge": true}),
            );
            g.set_edge(
                &child_bottom,
                &bottom_id,
                serde_json::json!({"weight": this_weight, "minlen": minlen, "nestingEdge": true}),
            );
        }

        if g.parent(v).is_none() {
            let depth_v = *depths.get(v).unwrap_or(&1);
            let top_id = g
                .node_label(v)
                .and_then(|label| label.get("borderTop"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
                .expect("borderTop set");
            g.set_edge(
                root,
                &top_id,
                serde_json::json!({"weight":0, "minlen": height + depth_v}),
            );
        }
    }

    for child in g.children(None) {
        dfs(
            g,
            &root,
            node_sep,
            weight,
            height,
            &depths,
            &child,
            &mut counter,
        );
    }

    state.nesting_root = Some(root);
    state.node_rank_factor = node_sep.max(1);
}

fn remove_empty_ranks(g: &mut Graph, node_rank_factor: i64) {
    if g.node_count() == 0 {
        return;
    }
    let mut min_rank = i64::MAX;
    let mut max_rank = i64::MIN;
    for node in g.nodes() {
        if let Some(rank) = g
            .node_label(&node)
            .and_then(|label| label.get("rank"))
            .and_then(serde_json::Value::as_i64)
        {
            min_rank = min_rank.min(rank);
            max_rank = max_rank.max(rank);
        }
    }
    if min_rank > max_rank {
        return;
    }

    let mut layers: HashMap<i64, Vec<String>> = HashMap::new();
    for node in g.nodes() {
        if let Some(rank) = g
            .node_label(&node)
            .and_then(|label| label.get("rank"))
            .and_then(serde_json::Value::as_i64)
        {
            let offset = rank - min_rank;
            layers.entry(offset).or_default().push(node);
        }
    }

    let mut delta = 0_i64;
    let total_offsets = max_rank - min_rank;
    let mut removed_count = 0_i64;
    for offset in 0..=(max_rank - min_rank) {
        // node_rank_factor=0 表示所有空 rank 都可移除（JS 中 undefined % n → NaN !== 0 → true）
        let is_removable_empty = !layers.contains_key(&offset)
            && (node_rank_factor == 0 || offset % node_rank_factor != 0);
        if is_removable_empty {
            delta -= 1;
            continue;
        }
        if delta == 0 {
            continue;
        }
        if let Some(nodes) = layers.get(&offset) {
            for node in nodes {
                let Some(mut label) = g.node_label(node).cloned() else {
                    continue;
                };
                if !label.is_object() {
                    continue;
                }
                let Some(rank) = label.get("rank").and_then(serde_json::Value::as_i64) else {
                    continue;
                };
                label["rank"] = serde_json::json!(rank + delta);
                g.set_node(node, label);
            }
        }
    }
    eprintln!("[remove_empty_ranks] min_rank={} max_rank={} total_offsets={} node_rank_factor={} final_delta={} layers_count={}", min_rank, max_rank, total_offsets, node_rank_factor, delta, layers.len());
}

fn nesting_graph_cleanup(g: &mut Graph, state: &NestingState) {
    if let Some(root) = &state.nesting_root {
        let _ = g.remove_node(root);
    }

    let edge_ids: Vec<String> = g
        .edges()
        .into_iter()
        .filter_map(|edge| {
            let is_nesting = g
                .edge_label(&edge.id)
                .and_then(|label| label.get("nestingEdge"))
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            if is_nesting {
                Some(edge.id)
            } else {
                None
            }
        })
        .collect();
    for edge_id in edge_ids {
        let _ = g.remove_edge(&edge_id);
    }
}

fn assign_ranks(g: &Graph) -> Result<HashMap<String, i64>, RankError> {
    let mut nodes: HashSet<String> = g.nodes().into_iter().collect();
    let edge_constraints: Vec<EdgeView> = g
        .edges()
        .into_iter()
        .map(|edge| {
            nodes.insert(edge.v.clone());
            nodes.insert(edge.w.clone());
            let minlen = edge_minlen(g.edge_label(&edge.id).expect("edge label should exist"));
            EdgeView {
                v: edge.v,
                w: edge.w,
                minlen,
            }
        })
        .collect();

    let mut outgoing: HashMap<String, Vec<(String, i64)>> = HashMap::new();
    let mut incoming_degree: HashMap<String, usize> = HashMap::new();
    for node in &nodes {
        outgoing.entry(node.clone()).or_default();
        incoming_degree.entry(node.clone()).or_insert(0);
    }
    for edge in &edge_constraints {
        outgoing
            .entry(edge.v.clone())
            .or_default()
            .push((edge.w.clone(), edge.minlen));
        *incoming_degree.entry(edge.w.clone()).or_insert(0) += 1;
    }

    let mut queue: VecDeque<String> = incoming_degree
        .iter()
        .filter_map(|(node, degree)| if *degree == 0 { Some(node.clone()) } else { None })
        .collect();
    let mut topo = Vec::with_capacity(nodes.len());
    while let Some(v) = queue.pop_front() {
        topo.push(v.clone());
        if let Some(edges) = outgoing.get(&v) {
            for (w, _) in edges {
                if let Some(entry) = incoming_degree.get_mut(w) {
                    *entry = entry.saturating_sub(1);
                    if *entry == 0 {
                        queue.push_back(w.clone());
                    }
                }
            }
        }
    }
    if topo.len() != nodes.len() {
        return Err(RankError::UnsatisfiedConstraints);
    }

    let mut ranks: HashMap<String, i64> = HashMap::new();
    for node in &nodes {
        ranks.insert(node.clone(), 0);
    }
    for v in topo.into_iter().rev() {
        let mut rank = i64::MAX;
        if let Some(edges) = outgoing.get(&v) {
            for (w, minlen) in edges {
                let w_rank = *ranks.get(w).unwrap_or(&0);
                let Some(candidate) = w_rank.checked_sub(*minlen) else {
                    return Err(RankError::Overflow);
                };
                rank = rank.min(candidate);
            }
        }
        if rank == i64::MAX {
            rank = 0;
        }
        ranks.insert(v, rank);
    }

    feasible_tree_tighten(&mut ranks, &nodes, &edge_constraints)?;

    for edge in &edge_constraints {
        let v_rank = *ranks.get(&edge.v).unwrap_or(&0);
        let w_rank = *ranks.get(&edge.w).unwrap_or(&0);
        let Some(diff) = w_rank.checked_sub(v_rank) else {
            return Err(RankError::Overflow);
        };
        if diff < edge.minlen {
            return Err(RankError::UnsatisfiedConstraints);
        }
    }

    Ok(ranks)
}

fn feasible_tree_tighten(
    ranks: &mut HashMap<String, i64>,
    nodes: &HashSet<String>,
    edges: &[EdgeView],
) -> Result<(), RankError> {
    if nodes.is_empty() {
        return Ok(());
    }
    let start = nodes.iter().min().cloned().unwrap_or_default();
    let mut tree: HashSet<String> = HashSet::from([start]);

    fn slack(ranks: &HashMap<String, i64>, edge: &EdgeView) -> Result<i64, RankError> {
        let v_rank = *ranks.get(&edge.v).unwrap_or(&0);
        let w_rank = *ranks.get(&edge.w).unwrap_or(&0);
        let Some(diff) = w_rank.checked_sub(v_rank) else {
            return Err(RankError::Overflow);
        };
        let Some(value) = diff.checked_sub(edge.minlen) else {
            return Err(RankError::Overflow);
        };
        Ok(value)
    }

    loop {
        let mut stack: Vec<String> = tree.iter().cloned().collect();
        while let Some(v) = stack.pop() {
            for edge in edges {
                let w = if edge.v == v {
                    Some(edge.w.clone())
                } else if edge.w == v {
                    Some(edge.v.clone())
                } else {
                    None
                };
                let Some(w) = w else {
                    continue;
                };
                if tree.contains(&w) {
                    continue;
                }
                if slack(ranks, edge)? == 0 {
                    tree.insert(w.clone());
                    stack.push(w);
                }
            }
        }

        if tree.len() >= nodes.len() {
            break;
        }

        let mut best: Option<(usize, i64)> = None;
        for (index, edge) in edges.iter().enumerate() {
            let v_in = tree.contains(&edge.v);
            let w_in = tree.contains(&edge.w);
            if v_in == w_in {
                continue;
            }
            let s = slack(ranks, edge)?;
            if best.map(|(_, value)| s < value).unwrap_or(true) {
                best = Some((index, s));
            }
        }

        let Some((index, s)) = best else {
            break;
        };
        let edge = &edges[index];
        let delta = if tree.contains(&edge.v) { s } else { -s };
        for node in &tree {
            let rank = *ranks.get(node).unwrap_or(&0);
            let Some(next) = rank.checked_add(delta) else {
                return Err(RankError::Overflow);
            };
            ranks.insert(node.clone(), next);
        }
    }

    Ok(())
}

#[derive(Clone)]
struct EdgeView {
    v: String,
    w: String,
    minlen: i64,
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

    use super::{assign_ranks, nesting_graph_run, node_rank, run_rank_pipeline, NestingState};

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

    #[test]
    fn rank_pipeline_keeps_unconstrained_cluster_sibling_in_same_rank_band() {
        let mut graph = Graph::new(true, false);
        graph.set_node("cluster", serde_json::json!({}));
        graph.set_node("a", serde_json::json!({}));
        graph.set_node("b", serde_json::json!({}));
        graph.set_node("c", serde_json::json!({}));
        graph.set_node("d", serde_json::json!({}));
        graph.set_parent("a", Some("cluster"));
        graph.set_parent("b", Some("cluster"));
        graph.set_parent("c", Some("cluster"));
        graph.set_edge("a", "b", serde_json::json!({"minlen": 1, "weight": 1}));

        run_rank_pipeline(&mut graph).expect("rank pipeline should succeed");

        let a_rank = node_rank(&graph, "a");
        let b_rank = node_rank(&graph, "b");
        let c_rank = node_rank(&graph, "c");
        let d_rank = node_rank(&graph, "d");

        assert_eq!(b_rank, c_rank, "cluster siblings should share rank band");
        assert_eq!(a_rank, d_rank, "unrelated root node should align with source rank");
    }

    #[test]
    fn assign_ranks_keeps_parallel_source_on_same_band_as_merge_parent() {
        let mut graph = Graph::new(false, false);
        graph.set_node("a", serde_json::json!({}));
        graph.set_node("b", serde_json::json!({}));
        graph.set_node("c", serde_json::json!({}));
        graph.set_node("d", serde_json::json!({}));
        graph.set_edge("a", "d", serde_json::json!({"minlen": 2, "weight": 1}));
        graph.set_edge("b", "c", serde_json::json!({"minlen": 2, "weight": 1}));
        graph.set_edge("c", "d", serde_json::json!({"minlen": 2, "weight": 1}));

        let ranks = assign_ranks(&graph).expect("assign ranks");

        assert_eq!(ranks.get("a"), Some(&-2));
        assert_eq!(ranks.get("b"), Some(&-4));
        assert_eq!(ranks.get("c"), Some(&-2));
        assert_eq!(ranks.get("d"), Some(&0));
    }

    #[test]
    fn rank_pipeline_keeps_parallel_source_on_same_band_as_merge_parent() {
        let mut graph = Graph::new(true, false);
        graph.set_node("a", serde_json::json!({}));
        graph.set_node("b", serde_json::json!({}));
        graph.set_node("c", serde_json::json!({}));
        graph.set_node("d", serde_json::json!({}));
        graph.set_edge("a", "d", serde_json::json!({"minlen": 2, "weight": 1}));
        graph.set_edge("b", "c", serde_json::json!({"minlen": 2, "weight": 1}));
        graph.set_edge("c", "d", serde_json::json!({"minlen": 2, "weight": 1}));

        run_rank_pipeline(&mut graph).expect("rank pipeline should succeed");

        let a_rank = node_rank(&graph, "a");
        let b_rank = node_rank(&graph, "b");
        let c_rank = node_rank(&graph, "c");
        let d_rank = node_rank(&graph, "d");
        assert_eq!(a_rank, c_rank, "parallel source a should align with c");
        assert_eq!(b_rank, 0, "b should be on bottom source band");
        assert_eq!(d_rank - c_rank, 2, "d should stay one minlen step below c");
    }

    #[test]
    fn assign_ranks_with_nesting_root_matches_js_raw_ranks() {
        let mut graph = Graph::new(false, false);
        for id in ["_root", "a", "b", "c", "d"] {
            graph.set_node(id, serde_json::json!({}));
        }
        graph.set_edge("_root", "a", serde_json::json!({"minlen": 1, "weight": 1}));
        graph.set_edge("_root", "b", serde_json::json!({"minlen": 1, "weight": 1}));
        graph.set_edge("_root", "c", serde_json::json!({"minlen": 1, "weight": 1}));
        graph.set_edge("_root", "d", serde_json::json!({"minlen": 1, "weight": 1}));
        graph.set_edge("a", "d", serde_json::json!({"minlen": 2, "weight": 1}));
        graph.set_edge("b", "c", serde_json::json!({"minlen": 2, "weight": 1}));
        graph.set_edge("c", "d", serde_json::json!({"minlen": 2, "weight": 1}));

        let ranks = assign_ranks(&graph).expect("assign ranks");

        assert_eq!(ranks.get("a"), Some(&-2));
        assert_eq!(ranks.get("b"), Some(&-4));
        assert_eq!(ranks.get("c"), Some(&-2));
        assert_eq!(ranks.get("d"), Some(&0));
        assert_eq!(ranks.get("_root"), Some(&-5));
    }

    #[test]
    fn assign_ranks_after_nesting_run_matches_js_raw_ranks() {
        let mut graph = Graph::new(true, false);
        for id in ["a", "b", "c", "d"] {
            graph.set_node(id, serde_json::json!({}));
        }
        graph.set_edge("a", "d", serde_json::json!({"minlen": 2, "weight": 1}));
        graph.set_edge("b", "c", serde_json::json!({"minlen": 2, "weight": 1}));
        graph.set_edge("c", "d", serde_json::json!({"minlen": 2, "weight": 1}));

        let mut state = NestingState::default();
        nesting_graph_run(&mut graph, &mut state);

        let non_compound = graph.as_non_compound_graph();
        let ranks = assign_ranks(&non_compound).expect("assign ranks");

        assert_eq!(ranks.get("a"), Some(&-2));
        assert_eq!(ranks.get("b"), Some(&-4));
        assert_eq!(ranks.get("c"), Some(&-2));
        assert_eq!(ranks.get("d"), Some(&0));
    }
}
