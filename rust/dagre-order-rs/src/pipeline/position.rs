use std::collections::{BTreeMap, HashMap, HashSet};

use crate::graph::Graph;

const NODE_SEP: f64 = 80.0;
const RANK_SEP: f64 = 100.0;

pub fn run_position_pipeline(g: &mut Graph, layout: &serde_json::Value) {
    let ranksep = layout_number(layout, "ranksep", 50.0);
    let layering = build_layer_matrix(g);
    if layering.is_empty() {
        return;
    }

    let mut y = 0.0_f64;
    for layer in &layering {
        let max_height = layer
            .iter()
            .map(|node| node_height(g, node))
            .fold(0.0_f64, f64::max);
        for node in layer {
            set_xy(g, node, None, Some(y + max_height / 2.0));
        }
        y += max_height + ranksep;
    }

    let type1 = find_type1_conflicts(g, &layering);
    let type2 = find_type2_conflicts(g, &layering);
    let mut conflicts = type1;
    for (k, vs) in type2 {
        conflicts.insert(k, vs);
    }

    let fast_order_mode = layout
        .get("order")
        .and_then(serde_json::Value::as_str)
        .map(|value| value.eq_ignore_ascii_case("fast"))
        .unwrap_or(false);
    let mut xss: HashMap<String, HashMap<String, f64>> = HashMap::new();
    let mut alignment_order: Vec<String> = Vec::new();
    let vertical_passes = if fast_order_mode { vec!["u"] } else { vec!["u", "d"] };
    for vertical in vertical_passes {
        let base = if vertical == "u" {
            layering.clone()
        } else {
            let mut reversed = layering.clone();
            reversed.reverse();
            reversed
        };
        for horizontal in ["l", "r"] {
            let adjusted = if horizontal == "l" {
                base.clone()
            } else {
                base.iter()
                    .map(|layer| {
                        let mut layer = layer.clone();
                        layer.reverse();
                        layer
                    })
                    .collect::<Vec<_>>()
            };
            let neighbor_up = vertical == "u";
            let (root, align) = vertical_alignment(g, &adjusted, &conflicts, neighbor_up);
            let mut xs = horizontal_compaction(g, layout, &adjusted, &root, &align, horizontal == "r");
            if horizontal == "r" {
                for value in xs.values_mut() {
                    *value = -*value;
                }
            }
            let key = format!("{vertical}{horizontal}");
            alignment_order.push(key.clone());
            xss.insert(key, xs);
        }
    }

    let ul = xss.get("ul");
    let ur = xss.get("ur");
    let dl = xss.get("dl");
    let dr = xss.get("dr");

    let mut align_to = ul.or(ur).or(dl).or(dr).cloned().unwrap_or_default();
    if !fast_order_mode {
        let mut min_width = f64::INFINITY;
        for key in &alignment_order {
            let Some(xs) = xss.get(key) else {
                continue;
            };
            if xs.is_empty() {
                continue;
            }
            let mut min = f64::INFINITY;
            let mut max = f64::NEG_INFINITY;
            for (v, x) in xs {
                let half = node_width(g, v) / 2.0;
                min = min.min(*x - half);
                max = max.max(*x + half);
            }
            let width = max - min;
            if width < min_width {
                min_width = width;
                align_to = xs.clone();
            }
        }
    }

    if !align_to.is_empty() {
        let align_to_range = value_range(align_to.values().copied());
        for name in &alignment_order {
            let Some(xs) = xss.get_mut(name) else {
                continue;
            };
            if *xs == align_to {
                continue;
            }
            if xs.is_empty() {
                continue;
            }
            let range = value_range(xs.values().copied());
            let delta = if name.ends_with('l') {
                align_to_range.0 - range.0
            } else {
                align_to_range.1 - range.1
            };
            if delta != 0.0 {
                for value in xs.values_mut() {
                    *value += delta;
                }
            }
        }

        if fast_order_mode {
            let center = (align_to_range.0 + align_to_range.1) / 2.0;
            if center != 0.0 {
                for name in &alignment_order {
                    if let Some(xs) = xss.get_mut(name) {
                        for value in xs.values_mut() {
                            *value -= center;
                        }
                    }
                }
            }
        }

    }

    if let Some(align_value) = layout.get("align").and_then(serde_json::Value::as_str) {
        if let Some(xs) = xss.get(&align_value.to_ascii_lowercase()) {
            for (v, x) in xs {
                set_xy(g, v, Some(*x), None);
            }
        }
    } else if fast_order_mode {
        let left = xss
            .get("ul")
            .or_else(|| xss.get("ur"))
            .or_else(|| xss.get("dl"))
            .or_else(|| xss.get("dr"));
        let right = xss
            .get("ur")
            .or_else(|| xss.get("ul"))
            .or_else(|| xss.get("dr"))
            .or_else(|| xss.get("dl"));
        if let (Some(left), Some(right)) = (left, right) {
            for (v, lx) in left {
                if let Some(rx) = right.get(v) {
                    set_xy(g, v, Some((lx + rx) / 2.0), None);
                }
            }
        }
    } else {
        let base = xss
            .get("ul")
            .or_else(|| xss.get("ur"))
            .or_else(|| xss.get("dl"))
            .or_else(|| xss.get("dr"));
        if let Some(base) = base {
            for v in base.keys() {
                let mut values = Vec::new();
                for key in ["ul", "ur", "dl", "dr"] {
                    if let Some(xs) = xss.get(key) {
                        if let Some(x) = xs.get(v) {
                            values.push(*x);
                        }
                    }
                }
                if values.len() >= 2 {
                    let x = median_two(&values);
                    set_xy(g, v, Some(x), None);
                }
            }
        }
    }

}

fn build_layer_matrix(g: &Graph) -> Vec<Vec<String>> {
    let mut by_rank: BTreeMap<i64, Vec<(usize, String)>> = BTreeMap::new();
    for node in g.nodes() {
        if g.is_compound() && !g.children(Some(&node)).is_empty() {
            continue;
        }
        let Some(rank) = node_rank(g, &node) else {
            continue;
        };
        by_rank
            .entry(rank)
            .or_default()
            .push((node_order(g, &node), node));
    }
    let max_rank = by_rank.keys().next_back().copied().unwrap_or(-1);
    if max_rank < 0 {
        return Vec::new();
    }
    let mut layers = vec![Vec::new(); (max_rank + 1) as usize];
    for (rank, mut nodes) in by_rank {
        nodes.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
        layers[rank as usize] = nodes.into_iter().map(|(_, id)| id).collect();
    }
    layers
}

fn add_conflict(conflicts: &mut HashMap<String, HashSet<String>>, left: &str, right: &str) {
    let (a, b) = if left <= right { (left, right) } else { (right, left) };
    conflicts
        .entry(a.to_string())
        .or_default()
        .insert(b.to_string());
}

fn has_conflict(conflicts: &HashMap<String, HashSet<String>>, left: &str, right: &str) -> bool {
    let (a, b) = if left <= right { (left, right) } else { (right, left) };
    conflicts.get(a).map(|set| set.contains(b)).unwrap_or(false)
}

fn predecessors_sorted(g: &Graph, v: &str) -> Vec<String> {
    let mut list = g.predecessors(v);
    list.sort_by(|left, right| {
        node_order(g, left)
            .cmp(&node_order(g, right))
            .then_with(|| left.cmp(right))
    });
    list
}

fn successors_sorted(g: &Graph, v: &str) -> Vec<String> {
    let mut list = g.successors(v);
    list.sort_by(|left, right| {
        node_order(g, left)
            .cmp(&node_order(g, right))
            .then_with(|| left.cmp(right))
    });
    list
}

fn find_type1_conflicts(g: &Graph, layering: &[Vec<String>]) -> HashMap<String, HashSet<String>> {
    let mut conflicts = HashMap::new();
    if layering.is_empty() {
        return conflicts;
    }
    let mut prev = layering[0].clone();
    for layer in layering.iter().skip(1) {
        let mut k0 = 0_usize;
        let mut scan_pos = 0_usize;
        let prev_len = prev.len();
        let last_node = layer.last().cloned().unwrap_or_default();
        for (i, v) in layer.iter().enumerate() {
            let v_dummy = node_dummy(g, v).is_some();
            let w = if v_dummy {
                predecessors_sorted(g, v)
                    .into_iter()
                    .find(|u| node_dummy(g, u).is_some())
            } else {
                None
            };
            if w.is_some() || *v == last_node {
                let k1 = w
                    .as_ref()
                    .map(|u| node_order(g, u))
                    .unwrap_or(prev_len);
                for scan_node in layer.iter().take(i + 1).skip(scan_pos) {
                    let scan_dummy = node_dummy(g, scan_node).is_some();
                    for u in predecessors_sorted(g, scan_node) {
                        let u_pos = node_order(g, &u);
                        let u_dummy = node_dummy(g, &u).is_some();
                        if (u_pos < k0 || k1 < u_pos) && !(u_dummy && scan_dummy) {
                            add_conflict(&mut conflicts, &u, scan_node);
                        }
                    }
                }
                scan_pos = i + 1;
                k0 = k1;
            }
        }
        prev = layer.clone();
    }
    conflicts
}

fn find_type2_conflicts(g: &Graph, layering: &[Vec<String>]) -> HashMap<String, HashSet<String>> {
    let mut conflicts = HashMap::new();
    if layering.is_empty() {
        return conflicts;
    }

    fn scan(
        g: &Graph,
        conflicts: &mut HashMap<String, HashSet<String>>,
        south: &[String],
        south_pos: usize,
        south_end: usize,
        prev_north_border: isize,
        next_north_border: usize,
    ) {
        for v in south.iter().take(south_end).skip(south_pos) {
            if node_dummy(g, v).is_none() {
                continue;
            }
            for u in predecessors_sorted(g, v) {
                if node_dummy(g, &u).is_none() {
                    continue;
                }
                let u_order = node_order(g, &u) as isize;
                if u_order < prev_north_border || u_order > next_north_border as isize {
                    add_conflict(conflicts, &u, v);
                }
            }
        }
    }

    let mut north = layering[0].clone();
    for south in layering.iter().skip(1) {
        let mut prev_north_pos: isize = -1;
        let mut next_north_pos: usize = 0;
        let mut south_pos = 0_usize;
        for (south_lookahead, v) in south.iter().enumerate() {
            if node_dummy(g, v).as_deref() == Some("border") {
                let preds = predecessors_sorted(g, v);
                if let Some(first) = preds.first() {
                    next_north_pos = node_order(g, first);
                    scan(
                        g,
                        &mut conflicts,
                        south,
                        south_pos,
                        south_lookahead,
                        prev_north_pos,
                        next_north_pos,
                    );
                    south_pos = south_lookahead;
                    prev_north_pos = next_north_pos as isize;
                }
            }
            scan(
                g,
                &mut conflicts,
                south,
                south_pos,
                south.len(),
                next_north_pos as isize,
                north.len(),
            );
        }
        north = south.clone();
    }

    conflicts
}

fn vertical_alignment(
    g: &Graph,
    layering: &[Vec<String>],
    conflicts: &HashMap<String, HashSet<String>>,
    use_predecessors: bool,
) -> (HashMap<String, String>, HashMap<String, String>) {
    let mut root = HashMap::new();
    let mut align = HashMap::new();
    let mut pos = HashMap::new();

    for layer in layering {
        for (order, v) in layer.iter().enumerate() {
            root.insert(v.clone(), v.clone());
            align.insert(v.clone(), v.clone());
            pos.insert(v.clone(), order);
        }
    }

    for layer in layering {
        let mut prev_idx = -1_isize;
        for v in layer {
            let mut ws = if use_predecessors {
                predecessors_sorted(g, v)
            } else {
                successors_sorted(g, v)
            };
            if ws.is_empty() {
                continue;
            }
            ws.sort_by(|left, right| {
                pos.get(left)
                    .copied()
                    .unwrap_or(0)
                    .cmp(&pos.get(right).copied().unwrap_or(0))
                    .then_with(|| left.cmp(right))
            });
            let mp = (ws.len() as f64 - 1.0) / 2.0000001;
            let lo = mp.floor() as usize;
            let hi = mp.ceil() as usize;
            for index in lo..=hi {
                let w = &ws[index];
                let w_pos = pos.get(w).copied().unwrap_or(0) as isize;
                let aligned_self = align.get(v).map(|x| x == v).unwrap_or(false);
                if aligned_self && prev_idx < w_pos && !has_conflict(conflicts, v, w) {
                    let x = root.get(w).cloned().unwrap_or_else(|| w.clone());
                    align.insert(w.clone(), v.clone());
                    align.insert(v.clone(), x.clone());
                    root.insert(v.clone(), x);
                    prev_idx = w_pos;
                }
            }
        }
    }

    (root, align)
}

#[derive(Default)]
struct BlockGraph {
    nodes: HashSet<String>,
    node_list: Vec<String>,
    in_edges: HashMap<String, Vec<(String, f64)>>,
    out_edges: HashMap<String, Vec<(String, f64)>>,
}

impl BlockGraph {
    fn add_node(&mut self, v: &str) {
        if self.nodes.insert(v.to_string()) {
            self.node_list.push(v.to_string());
        }
    }

    fn add_or_update_edge(&mut self, from: &str, to: &str, weight: f64) {
        self.add_node(from);
        self.add_node(to);

        let out = self.out_edges.entry(from.to_string()).or_default();
        if let Some(edge) = out.iter_mut().find(|(id, _)| id == to) {
            edge.1 = edge.1.max(weight);
        } else {
            out.push((to.to_string(), weight));
        }

        let input = self.in_edges.entry(to.to_string()).or_default();
        if let Some(edge) = input.iter_mut().find(|(id, _)| id == from) {
            edge.1 = edge.1.max(weight);
        } else {
            input.push((from.to_string(), weight));
        }
    }

    fn predecessors(&self, v: &str) -> Vec<String> {
        self.in_edges
            .get(v)
            .map(|edges| edges.iter().map(|(id, _)| id.clone()).collect())
            .unwrap_or_default()
    }

    fn successors(&self, v: &str) -> Vec<String> {
        self.out_edges
            .get(v)
            .map(|edges| edges.iter().map(|(id, _)| id.clone()).collect())
            .unwrap_or_default()
    }
}

fn build_block_graph(
    g: &Graph,
    layout: &serde_json::Value,
    layering: &[Vec<String>],
    root: &HashMap<String, String>,
    reverse_sep: bool,
) -> BlockGraph {
    let nodesep = layout_number(layout, "nodesep", 50.0);
    let edgesep = layout_number(layout, "edgesep", 20.0);
    let mut graph = BlockGraph::default();

    for layer in layering {
        let mut previous: Option<String> = None;
        for v in layer {
            let v_root = root.get(v).cloned().unwrap_or_else(|| v.clone());
            graph.add_node(&v_root);
            if let Some(u) = &previous {
                let u_root = root.get(u).cloned().unwrap_or_else(|| u.clone());
                let v_label = g.node_label(v).cloned().unwrap_or_else(|| serde_json::json!({}));
                let u_label = g.node_label(u).cloned().unwrap_or_else(|| serde_json::json!({}));
                let mut sum = 0.0;
                let mut delta = 0.0;
                let v_width = v_label.get("width").and_then(serde_json::Value::as_f64).unwrap_or(NODE_SEP);
                let u_width = u_label.get("width").and_then(serde_json::Value::as_f64).unwrap_or(NODE_SEP);
                sum += v_width / 2.0;
                if let Some(labelpos) = v_label.get("labelpos").and_then(serde_json::Value::as_str) {
                    match labelpos {
                        "l" => delta = -v_width / 2.0,
                        "r" => delta = v_width / 2.0,
                        _ => {}
                    }
                }
                if delta != 0.0 {
                    sum += if reverse_sep { delta } else { -delta };
                }
                sum += if node_dummy(g, v).is_some() {
                    edgesep / 2.0
                } else {
                    nodesep / 2.0
                };
                sum += if node_dummy(g, u).is_some() {
                    edgesep / 2.0
                } else {
                    nodesep / 2.0
                };
                sum += u_width / 2.0;
                delta = 0.0;
                if let Some(labelpos) = u_label.get("labelpos").and_then(serde_json::Value::as_str) {
                    match labelpos {
                        "l" => delta = u_width / 2.0,
                        "r" => delta = -u_width / 2.0,
                        _ => {}
                    }
                }
                if delta != 0.0 {
                    sum += if reverse_sep { delta } else { -delta };
                }
                graph.add_or_update_edge(&u_root, &v_root, sum);
            }
            previous = Some(v.clone());
        }
    }

    graph
}

fn horizontal_compaction(
    g: &Graph,
    layout: &serde_json::Value,
    layering: &[Vec<String>],
    root: &HashMap<String, String>,
    align: &HashMap<String, String>,
    reverse_sep: bool,
) -> HashMap<String, f64> {
    let block_graph = build_block_graph(g, layout, layering, root, reverse_sep);
    let border_type = if reverse_sep { "borderLeft" } else { "borderRight" };
    let mut xs: HashMap<String, f64> = HashMap::new();

    if !block_graph.nodes.is_empty() {
        let mut stack: Vec<String> = block_graph.node_list.clone();
        let mut visited = HashSet::new();
        while let Some(v) = stack.pop() {
            if visited.contains(&v) {
                let mut max_x = 0.0_f64;
                if let Some(edges) = block_graph.in_edges.get(&v) {
                    for (pred, weight) in edges {
                        max_x = max_x.max(xs.get(pred).copied().unwrap_or(0.0) + *weight);
                    }
                }
                xs.insert(v, max_x);
                continue;
            }
            visited.insert(v.clone());
            stack.push(v.clone());
            for pred in block_graph.predecessors(&v) {
                stack.push(pred);
            }
        }
    }

    if !block_graph.nodes.is_empty() {
        let mut stack: Vec<String> = block_graph.node_list.clone();
        let mut visited = HashSet::new();
        while let Some(v) = stack.pop() {
            if visited.contains(&v) {
                let mut min_x = f64::INFINITY;
                if let Some(edges) = block_graph.out_edges.get(&v) {
                    for (succ, weight) in edges {
                        min_x = min_x.min(xs.get(succ).copied().unwrap_or(0.0) - *weight);
                    }
                }
                let border = g
                    .node_label(&v)
                    .and_then(|label| label.get("borderType"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("");
                if min_x.is_finite() && node_dummy(g, &v).is_none() && border != border_type {
                    let current = xs.get(&v).copied().unwrap_or(0.0);
                    xs.insert(v, current.max(min_x));
                }
                continue;
            }
            visited.insert(v.clone());
            stack.push(v.clone());
            for succ in block_graph.successors(&v) {
                stack.push(succ);
            }
        }
    }

    for v in align.values() {
        if let Some(root_id) = root.get(v) {
            if let Some(value) = xs.get(root_id).copied() {
                xs.insert(v.clone(), value);
            }
        }
    }

    xs
}

fn value_range(values: impl Iterator<Item = f64>) -> (f64, f64) {
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    for value in values {
        min = min.min(value);
        max = max.max(value);
    }
    (min, max)
}

fn median_two(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let mid = sorted.len() / 2;
    if sorted.len() % 2 == 1 {
        sorted[mid]
    } else {
        (sorted[mid - 1] + sorted[mid]) / 2.0
    }
}

fn set_xy(g: &mut Graph, id: &str, x: Option<f64>, y: Option<f64>) {
    let mut label = g
        .node_label(id)
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    if !label.is_object() {
        label = serde_json::json!({});
    }
    if let Some(x) = x {
        label["x"] = serde_json::json!(x);
    }
    if let Some(y) = y {
        label["y"] = serde_json::json!(y);
    }
    g.set_node(id, label);
}

fn node_dummy(g: &Graph, id: &str) -> Option<String> {
    g.node_label(id)
        .and_then(|label| label.get("dummy"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
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
    use super::{find_type2_conflicts, run_position_pipeline, update_compound_bounds};
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

        let min_center_gap = (100.0 / 2.0) + 20.0 + (200.0 / 2.0);
        assert!((bx - ax) >= min_center_gap - 1e-6, "expected center gap >= {min_center_gap}, got {}", bx - ax);
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
        update_compound_bounds(&mut graph);

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
        assert!((bx - ax - 30.0).abs() < 1e-6, "expected node spacing 30, got {}", bx - ax);
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

    #[test]
    fn type2_conflicts_detect_non_border_dummy_crossing_border_window() {
        let mut graph = Graph::new(false, false);
        graph.set_node("n0", serde_json::json!({"rank": 0, "order": 0}));
        graph.set_node("n2", serde_json::json!({"rank": 0, "order": 2}));
        graph.set_node("du", serde_json::json!({"rank": 0, "order": 3, "dummy": "edge"}));
        graph.set_node("bl", serde_json::json!({"rank": 1, "order": 0, "dummy": "border"}));
        graph.set_node("v", serde_json::json!({"rank": 1, "order": 1, "dummy": "edge"}));
        graph.set_node("br", serde_json::json!({"rank": 1, "order": 2, "dummy": "border"}));

        graph.set_edge("n0", "bl", serde_json::json!({"weight": 1}));
        graph.set_edge("n2", "br", serde_json::json!({"weight": 1}));
        graph.set_edge("du", "v", serde_json::json!({"weight": 1}));

        let layering = vec![
            vec!["n0".to_string(), "n2".to_string(), "du".to_string()],
            vec!["bl".to_string(), "v".to_string(), "br".to_string()],
        ];
        let conflicts = find_type2_conflicts(&graph, &layering);
        let has = conflicts
            .get("du")
            .map(|set| set.contains("v"))
            .unwrap_or(false);
        assert!(has, "expected type-2 conflict between du and v");
    }

    #[test]
    fn position_matches_js_for_order_aligned_small_fixture() {
        let nodes = vec![
            serde_json::json!({"id":"0","data":{"v":"0","width":128,"height":35}}),
            serde_json::json!({"id":"1","data":{"v":"1","width":100,"height":35}}),
            serde_json::json!({"id":"2","data":{"v":"2","width":88,"height":40}}),
            serde_json::json!({"id":"3","data":{"v":"3","width":114,"height":45}}),
            serde_json::json!({"id":"4","data":{"v":"4","width":92,"height":58}}),
            serde_json::json!({"id":"5","data":{"v":"5","width":99,"height":33}}),
            serde_json::json!({"id":"6","data":{"v":"6","width":83,"height":44}}),
            serde_json::json!({"id":"7","data":{"v":"7","width":104,"height":55}}),
        ];
        let edges = vec![
            serde_json::json!({"v":"0","w":"3","data":{"minlen":1,"weight":1,"width":0,"height":0,"labeloffset":10,"labelpos":"r"}}),
            serde_json::json!({"v":"0","w":"4","data":{"minlen":1,"weight":1,"width":0,"height":0,"labeloffset":10,"labelpos":"r"}}),
            serde_json::json!({"v":"1","w":"4","data":{"minlen":1,"weight":1,"width":0,"height":0,"labeloffset":10,"labelpos":"r"}}),
            serde_json::json!({"v":"1","w":"7","data":{"minlen":1,"weight":1,"width":0,"height":0,"labeloffset":10,"labelpos":"r"}}),
            serde_json::json!({"v":"2","w":"3","data":{"minlen":1,"weight":1,"width":0,"height":0,"labeloffset":10,"labelpos":"r"}}),
            serde_json::json!({"v":"2","w":"6","data":{"minlen":1,"weight":1,"width":0,"height":0,"labeloffset":10,"labelpos":"r"}}),
        ];
        let payload = serde_json::json!({
            "nodes": nodes,
            "edges": edges,
            "layout": {"rankdir":"TB","nodesep":20,"ranksep":20,"debugStages":true},
            "state": {"debugStages": true}
        });

        let output = crate::layout(&payload.to_string());
        let parsed: serde_json::Value = serde_json::from_str(&output).expect("valid json");
        let position_stage = parsed
            .get("debug")
            .and_then(|v| v.get("stageSnapshots"))
            .and_then(serde_json::Value::as_array)
            .and_then(|stages| {
                stages.iter().find(|stage| {
                    stage
                        .get("stage")
                        .and_then(serde_json::Value::as_str)
                        .map(|name| name == "position")
                        .unwrap_or(false)
                })
            })
            .expect("position stage snapshot");

        let node = |id: &str, key: &str| {
            position_stage
                .get("nodes")
                .and_then(serde_json::Value::as_array)
                .and_then(|nodes| {
                    nodes.iter().find(|n| {
                        n.get("id")
                            .and_then(serde_json::Value::as_str)
                            .map(|v| v == id)
                            .unwrap_or(false)
                    })
                })
                .and_then(|n| n.get(key))
                .and_then(serde_json::Value::as_f64)
                .expect("node coordinate")
        };

        let order = |id: &str| {
            parsed
                .get("debug")
                .and_then(|v| v.get("stageSnapshots"))
                .and_then(serde_json::Value::as_array)
                .and_then(|stages| {
                    stages.iter().find(|stage| {
                        stage
                            .get("stage")
                            .and_then(serde_json::Value::as_str)
                            .map(|name| name == "order")
                            .unwrap_or(false)
                    })
                })
                .and_then(|stage| stage.get("nodes"))
                .and_then(serde_json::Value::as_array)
                .and_then(|nodes| {
                    nodes.iter().find(|n| {
                        n.get("id")
                            .and_then(serde_json::Value::as_str)
                            .map(|v| v == id)
                            .unwrap_or(false)
                    })
                })
                .and_then(|n| n.get("order"))
                .and_then(serde_json::Value::as_u64)
                .expect("node order")
        };

        let x3 = node("3", "x");
        let x4 = node("4", "x");
        let x6 = node("6", "x");
        let x7 = node("7", "x");

        let stage_name = position_stage
            .get("stage")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("<none>");

        assert_eq!(order("3"), 0);
        assert_eq!(order("4"), 1);
        assert_eq!(order("7"), 2);
        assert_eq!(order("6"), 3);

        assert!((x3 - (-46.75)).abs() <= 1e-6, "expected node 3 x=-46.75, got {x3}, stage={stage_name}");
        assert!((x4 - 76.25).abs() <= 1e-6, "expected node 4 x=76.25, got {x4}, stage={stage_name}");
        assert!((x6 - 307.75).abs() <= 1e-6, "expected node 6 x=307.75, got {x6}, stage={stage_name}");
        assert!((x7 - 194.25).abs() <= 1e-6, "expected node 7 x=194.25, got {x7}, stage={stage_name}");
    }
}
