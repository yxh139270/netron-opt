use crate::graph::Graph;

pub fn run_edge_pipeline(g: &mut Graph) {
    for edge in g.edges() {
        let Some((vx, vy)) = node_xy(g, &edge.v) else {
            continue;
        };
        let Some((wx, wy)) = node_xy(g, &edge.w) else {
            continue;
        };

        let Some(vrect) = node_rect(g, &edge.v) else {
            continue;
        };
        let Some(wrect) = node_rect(g, &edge.w) else {
            continue;
        };

        let mut label = g
            .edge_label(&edge.id)
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        if !label.is_object() {
            label = serde_json::json!({});
        }

        let pred_count = g.predecessors(&edge.w).len();
        let mut inner_points: Vec<(f64, f64)> = Vec::new();

        if (vy - wy).abs() >= f64::EPSILON {
            let downward = wy >= vy;
            let v_half_h = vrect.3 / 2.0;
            let w_half_h = wrect.3 / 2.0;
            let v_boundary_y = if downward { vy + v_half_h } else { vy - v_half_h };
            let w_boundary_y = if downward { wy - w_half_h } else { wy + w_half_h };

            let rank_diff = match (node_rank(g, &edge.v), node_rank(g, &edge.w)) {
                (Some(v_rank), Some(w_rank)) => (w_rank - v_rank).unsigned_abs() as usize,
                _ => 0,
            };
            let interior_count = if rank_diff >= 2 {
                (rank_diff / 2).max(1)
            } else if pred_count > 1 {
                2
            } else {
                1
            };

            let x_inner = if (vx - wx).abs() < f64::EPSILON {
                vx
            } else if pred_count <= 1 {
                wx
            } else {
                vx
            };
            let span = w_boundary_y - v_boundary_y;
            for index in 1..=interior_count {
                let t = index as f64 / (interior_count + 1) as f64;
                let y = v_boundary_y + span * t;
                inner_points.push((x_inner, y));
            }
        }

        let p1 = inner_points.first().copied().unwrap_or((wx, wy));
        let p2 = inner_points.last().copied().unwrap_or((vx, vy));
        let start = intersect_rect(vrect, p1);
        let end = intersect_rect(wrect, p2);

        let mut routed = Vec::with_capacity(inner_points.len() + 2);
        routed.push(serde_json::json!({ "x": start.0, "y": start.1 }));
        for (x, y) in inner_points {
            routed.push(serde_json::json!({ "x": x, "y": y }));
        }
        routed.push(serde_json::json!({ "x": end.0, "y": end.1 }));
        let points = serde_json::Value::Array(routed);

        label["points"] = points;
        let _ = g.set_edge_label(&edge.id, label);
    }
}

fn node_xy(g: &Graph, id: &str) -> Option<(f64, f64)> {
    let label = g.node_label(id)?;
    let x = label.get("x")?.as_f64()?;
    let y = label.get("y")?.as_f64()?;
    Some((x, y))
}

fn node_rect(g: &Graph, id: &str) -> Option<(f64, f64, f64, f64)> {
    let label = g.node_label(id)?;
    let x = label.get("x")?.as_f64()?;
    let y = label.get("y")?.as_f64()?;
    let width = label
        .get("width")
        .and_then(serde_json::Value::as_f64)
        .unwrap_or(0.0);
    let height = label
        .get("height")
        .and_then(serde_json::Value::as_f64)
        .unwrap_or(0.0);
    Some((x, y, width, height))
}

fn intersect_rect(rect: (f64, f64, f64, f64), point: (f64, f64)) -> (f64, f64) {
    let (x, y, width, height) = rect;
    let dx = point.0 - x;
    let dy = point.1 - y;
    if dx.abs() < f64::EPSILON && dy.abs() < f64::EPSILON {
        return (x, y);
    }
    let mut half_w = width / 2.0;
    let mut half_h = height / 2.0;
    if dy.abs() * half_w > dx.abs() * half_h {
        half_h = if dy < 0.0 { -half_h } else { half_h };
        return (x + half_h * dx / dy, y + half_h);
    }
    half_w = if dx < 0.0 { -half_w } else { half_w };
    (x + half_w, y + half_w * dy / dx)
}

fn node_rank(g: &Graph, id: &str) -> Option<i64> {
    g.node_label(id)
        .and_then(|label| label.get("rank"))
        .and_then(serde_json::Value::as_i64)
}

#[cfg(test)]
mod tests {
    use super::run_edge_pipeline;
    use crate::graph::Graph;

    #[test]
    fn edge_points_touch_node_boundaries_instead_of_centers() {
        let mut graph = Graph::new(false, false);
        graph.set_node("a", serde_json::json!({"x": 0.0, "y": 0.0, "width": 100.0, "height": 40.0}));
        graph.set_node("b", serde_json::json!({"x": 0.0, "y": 100.0, "width": 80.0, "height": 20.0}));
        graph.set_edge("a", "b", serde_json::json!({}));

        run_edge_pipeline(&mut graph);

        let points = graph
            .edge_label("a->b")
            .and_then(|label| label.get("points"))
            .and_then(serde_json::Value::as_array)
            .expect("points should exist");
        assert!(points.len() >= 2, "expected at least two points");

        let first_y = points
            .first()
            .and_then(|point| point.get("y"))
            .and_then(serde_json::Value::as_f64)
            .expect("first y");
        let last_y = points
            .last()
            .and_then(|point| point.get("y"))
            .and_then(serde_json::Value::as_f64)
            .expect("last y");

        assert!((first_y - 20.0).abs() < 1e-6, "expected first y=20, got {first_y}");
        assert!((last_y - 90.0).abs() < 1e-6, "expected last y=90, got {last_y}");
    }

    #[test]
    fn vertical_edges_emit_three_points_for_simple_chain() {
        let mut graph = Graph::new(false, false);
        graph.set_node("a", serde_json::json!({"x": 50.0, "y": 18.0, "width": 80.0, "height": 36.0}));
        graph.set_node("b", serde_json::json!({"x": 50.0, "y": 77.0, "width": 100.0, "height": 42.0}));
        graph.set_edge("a", "b", serde_json::json!({}));

        run_edge_pipeline(&mut graph);

        let points = graph
            .edge_label("a->b")
            .and_then(|label| label.get("points"))
            .and_then(serde_json::Value::as_array)
            .expect("points should exist");
        assert_eq!(points.len(), 3, "expected three points for vertical edge");
        let mid_y = points
            .get(1)
            .and_then(|point| point.get("y"))
            .and_then(serde_json::Value::as_f64)
            .expect("midpoint y");
        assert!((mid_y - 46.0).abs() < 1e-6, "expected midpoint y=46, got {mid_y}");
    }

    #[test]
    fn diagonal_single_input_edge_uses_three_points() {
        let mut graph = Graph::new(false, false);
        graph.set_node("a", serde_json::json!({"x": 162.0, "y": 28.0, "width": 96.0, "height": 36.0}));
        graph.set_node("b", serde_json::json!({"x": 96.0, "y": 87.0, "width": 112.0, "height": 42.0}));
        graph.set_edge("a", "b", serde_json::json!({}));

        run_edge_pipeline(&mut graph);

        let points = graph
            .edge_label("a->b")
            .and_then(|label| label.get("points"))
            .and_then(serde_json::Value::as_array)
            .expect("points should exist");
        assert_eq!(points.len(), 3, "expected three points for diagonal single-input edge");

        let bend_x = points
            .get(1)
            .and_then(|point| point.get("x"))
            .and_then(serde_json::Value::as_f64)
            .expect("bend x");
        let bend_y = points
            .get(1)
            .and_then(|point| point.get("y"))
            .and_then(serde_json::Value::as_f64)
            .expect("bend y");
        assert!((bend_x - 96.0).abs() < 1e-6, "expected bend x=96, got {bend_x}");
        assert!((bend_y - 56.0).abs() < 1e-6, "expected bend y=56, got {bend_y}");
    }

    #[test]
    fn multi_input_sink_edges_stay_vertical_before_diagonal_entry() {
        let mut graph = Graph::new(false, false);
        graph.set_node("b", serde_json::json!({"x": 96.0, "y": 87.0, "width": 112.0, "height": 42.0}));
        graph.set_node("c", serde_json::json!({"x": 228.0, "y": 87.0, "width": 112.0, "height": 42.0}));
        graph.set_node("d", serde_json::json!({"x": 162.0, "y": 156.0, "width": 96.0, "height": 36.0}));
        graph.set_edge("b", "d", serde_json::json!({}));
        graph.set_edge("c", "d", serde_json::json!({}));

        run_edge_pipeline(&mut graph);

        let bd = graph
            .edge_label("b->d")
            .and_then(|label| label.get("points"))
            .and_then(serde_json::Value::as_array)
            .expect("b->d points should exist");
        assert_eq!(bd.len(), 4, "expected four points for multi-input sink edge");

        let x1 = bd
            .get(1)
            .and_then(|point| point.get("x"))
            .and_then(serde_json::Value::as_f64)
            .expect("x1");
        let x2 = bd
            .get(2)
            .and_then(|point| point.get("x"))
            .and_then(serde_json::Value::as_f64)
            .expect("x2");
        let y1 = bd
            .get(1)
            .and_then(|point| point.get("y"))
            .and_then(serde_json::Value::as_f64)
            .expect("y1");
        let y2 = bd
            .get(2)
            .and_then(|point| point.get("y"))
            .and_then(serde_json::Value::as_f64)
            .expect("y2");
        assert!((x1 - 96.0).abs() < 1e-6, "expected second point x=96, got {x1}");
        assert!((x2 - 96.0).abs() < 1e-6, "expected third point x=96, got {x2}");
        assert!((y1 - 118.0).abs() < 1e-6, "expected second point y=118, got {y1}");
        assert!((y2 - 128.0).abs() < 1e-6, "expected third point y=128, got {y2}");
    }
}
