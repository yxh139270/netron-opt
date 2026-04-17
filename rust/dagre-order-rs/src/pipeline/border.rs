use crate::graph::Graph;

pub fn add_border_segments(g: &mut Graph) {
    if !g.is_compound() {
        return;
    }

    let compound_nodes: Vec<String> = g
        .nodes()
        .into_iter()
        .filter(|id| !g.children(Some(id)).is_empty())
        .collect();

    for node_id in compound_nodes {
        let children = g.children(Some(&node_id));
        if children.is_empty() {
            continue;
        }

        let mut min_rank = i64::MAX;
        let mut max_rank = i64::MIN;

        for child in &children {
            if let Some(rank) = node_rank(g, child) {
                min_rank = min_rank.min(rank);
                max_rank = max_rank.max(rank);
            }
        }
        if min_rank > max_rank {
            continue;
        }

        let mut border_left = Vec::new();
        let mut border_right = Vec::new();
        let mut prev_left: Option<String> = None;
        let mut prev_right: Option<String> = None;

        for rank in min_rank..=max_rank {
            let left_id = format!("_bl_{}_{}", node_id, rank);
            let right_id = format!("_br_{}_{}", node_id, rank);

            g.set_node(
                &left_id,
                serde_json::json!({
                    "dummy": "border",
                    "borderType": "borderLeft",
                    "width": 0,
                    "height": 0,
                    "rank": rank,
                    "order": 0
                }),
            );
            g.set_node(
                &right_id,
                serde_json::json!({
                    "dummy": "border",
                    "borderType": "borderRight",
                    "width": 0,
                    "height": 0,
                    "rank": rank,
                    "order": 1_000_000
                }),
            );
            g.set_parent(&left_id, Some(&node_id));
            g.set_parent(&right_id, Some(&node_id));

            if let Some(prev) = &prev_left {
                g.set_edge(prev, &left_id, serde_json::json!({ "weight": 1, "minlen": 1 }));
            }
            if let Some(prev) = &prev_right {
                g.set_edge(prev, &right_id, serde_json::json!({ "weight": 1, "minlen": 1 }));
            }

            prev_left = Some(left_id.clone());
            prev_right = Some(right_id.clone());
            border_left.push(left_id);
            border_right.push(right_id);
        }

        let mut label = g
            .node_label(&node_id)
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        if !label.is_object() {
            label = serde_json::json!({});
        }
        label["borderLeft"] = serde_json::json!(border_left);
        label["borderRight"] = serde_json::json!(border_right);
        if let Some(first) = label
            .get("borderLeft")
            .and_then(serde_json::Value::as_array)
            .and_then(|array| array.first())
            .and_then(serde_json::Value::as_str)
        {
            label["borderTop"] = serde_json::json!(first);
        }
        if let Some(last) = label
            .get("borderLeft")
            .and_then(serde_json::Value::as_array)
            .and_then(|array| array.last())
            .and_then(serde_json::Value::as_str)
        {
            label["borderBottom"] = serde_json::json!(last);
        }
        g.set_node(&node_id, label);
    }
}

pub fn remove_border_nodes(g: &mut Graph) {
    if !g.is_compound() {
        return;
    }

    let compound_nodes: Vec<String> = g
        .nodes()
        .into_iter()
        .filter(|id| !g.children(Some(id)).is_empty())
        .collect();

    let mut border_dummy_ids: Vec<String> = g
        .nodes()
        .into_iter()
        .filter(|id| g.node_label(id).map(is_border_dummy).unwrap_or(false))
        .collect();

    for node_id in compound_nodes {
        let Some(label) = g.node_label(&node_id).cloned() else {
            continue;
        };
        let Some(left) = border_endpoint_label(g, &label, "borderLeft", false) else {
            continue;
        };
        let Some(right) = border_endpoint_label(g, &label, "borderRight", false) else {
            continue;
        };
        let Some(top_id) = label.get("borderTop").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let Some(bottom_id) = label.get("borderBottom").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let Some(top) = g.node_label(top_id) else {
            continue;
        };
        let Some(bottom) = g.node_label(bottom_id) else {
            continue;
        };

        let Some(lx) = left.get("x").and_then(serde_json::Value::as_f64) else {
            continue;
        };
        let Some(rx) = right.get("x").and_then(serde_json::Value::as_f64) else {
            continue;
        };
        let Some(ty) = top.get("y").and_then(serde_json::Value::as_f64) else {
            continue;
        };
        let Some(by) = bottom.get("y").and_then(serde_json::Value::as_f64) else {
            continue;
        };

        let width = (rx - lx).abs();
        let height = (by - ty).abs();

        let mut updated = label.clone();
        if !updated.is_object() {
            updated = serde_json::json!({});
        }
        updated["width"] = serde_json::json!(width);
        updated["height"] = serde_json::json!(height);
        updated["x"] = serde_json::json!(lx + width / 2.0);
        updated["y"] = serde_json::json!(ty + height / 2.0);
        g.set_node(&node_id, updated);

        for key in ["borderLeft", "borderRight", "borderTop", "borderBottom"] {
            if let Some(value) = label.get(key) {
                if let Some(array) = value.as_array() {
                    for item in array {
                        if let Some(id) = item.as_str() {
                            border_dummy_ids.push(id.to_string());
                        }
                    }
                } else if let Some(id) = value.as_str() {
                    border_dummy_ids.push(id.to_string());
                }
            }
        }
    }

    border_dummy_ids.sort();
    border_dummy_ids.dedup();
    for dummy_id in border_dummy_ids {
        let _ = g.remove_node(&dummy_id);
    }
}

pub fn is_border_dummy(label: &serde_json::Value) -> bool {
    label
        .get("dummy")
        .and_then(serde_json::Value::as_str)
        .map(|value| value == "border")
        .unwrap_or(false)
}

fn border_endpoint_label<'a>(
    g: &'a Graph,
    label: &'a serde_json::Value,
    key: &str,
    first: bool,
) -> Option<&'a serde_json::Value> {
    let array = label.get(key)?.as_array()?;
    let node_id = if first {
        array.first()?.as_str()?
    } else {
        array.last()?.as_str()?
    };
    g.node_label(node_id)
}

fn node_rank(g: &Graph, id: &str) -> Option<i64> {
    g.node_label(id)
        .and_then(|label| label.get("rank"))
        .and_then(serde_json::Value::as_i64)
}

#[cfg(test)]
mod tests {
    use super::{add_border_segments, is_border_dummy, remove_border_nodes};
    use crate::graph::Graph;

    #[test]
    fn add_border_segments_creates_border_dummy_nodes() {
        let mut graph = Graph::new(true, false);
        graph.set_node("cluster", serde_json::json!({}));
        graph.set_node("a", serde_json::json!({"rank": 0}));
        graph.set_node("b", serde_json::json!({"rank": 2}));
        graph.set_parent("a", Some("cluster"));
        graph.set_parent("b", Some("cluster"));

        add_border_segments(&mut graph);

        let border_nodes: Vec<String> = graph
            .nodes()
            .into_iter()
            .filter(|id| {
                graph
                    .node_label(id)
                    .map(is_border_dummy)
                    .unwrap_or(false)
            })
            .collect();
        assert!(!border_nodes.is_empty(), "expected border dummy nodes");
    }

    #[test]
    fn remove_border_nodes_backfills_compound_geometry() {
        let mut graph = Graph::new(true, false);
        graph.set_node("cluster", serde_json::json!({
            "borderLeft": ["l0", "l1"],
            "borderRight": ["r0", "r1"],
            "borderTop": "l0",
            "borderBottom": "l1"
        }));
        graph.set_node("l0", serde_json::json!({"dummy":"border","x":10.0,"y":20.0}));
        graph.set_node("l1", serde_json::json!({"dummy":"border","x":10.0,"y":80.0}));
        graph.set_node("r0", serde_json::json!({"dummy":"border","x":30.0,"y":20.0}));
        graph.set_node("r1", serde_json::json!({"dummy":"border","x":30.0,"y":80.0}));
        graph.set_parent("l0", Some("cluster"));
        graph.set_parent("l1", Some("cluster"));
        graph.set_parent("r0", Some("cluster"));
        graph.set_parent("r1", Some("cluster"));

        remove_border_nodes(&mut graph);

        let cluster = graph.node_label("cluster").expect("cluster");
        let x = cluster.get("x").and_then(serde_json::Value::as_f64).expect("x");
        let y = cluster.get("y").and_then(serde_json::Value::as_f64).expect("y");
        let width = cluster
            .get("width")
            .and_then(serde_json::Value::as_f64)
            .expect("width");
        let height = cluster
            .get("height")
            .and_then(serde_json::Value::as_f64)
            .expect("height");
        assert!((x - 20.0).abs() < 1e-6);
        assert!((y - 50.0).abs() < 1e-6);
        assert!((width - 20.0).abs() < 1e-6);
        assert!((height - 60.0).abs() < 1e-6);
        assert!(graph.node_label("l0").is_none());
        assert!(graph.node_label("l1").is_none());
        assert!(graph.node_label("r0").is_none());
        assert!(graph.node_label("r1").is_none());
    }
}
