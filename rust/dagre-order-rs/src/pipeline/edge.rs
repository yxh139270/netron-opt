use crate::graph::Graph;

pub fn run_edge_pipeline(g: &mut Graph) {
    for edge in g.edges() {
        let Some((vx, vy)) = node_xy(g, &edge.v) else {
            continue;
        };
        let Some((wx, wy)) = node_xy(g, &edge.w) else {
            continue;
        };

        let mut label = g
            .edge_label(&edge.id)
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        if !label.is_object() {
            label = serde_json::json!({});
        }

        let mid_y = (vy + wy) / 2.0;
        let points = if (vy - wy).abs() < f64::EPSILON {
            serde_json::json!([
                { "x": vx, "y": vy },
                { "x": wx, "y": wy }
            ])
        } else {
            serde_json::json!([
                { "x": vx, "y": vy },
                { "x": vx, "y": mid_y },
                { "x": wx, "y": mid_y },
                { "x": wx, "y": wy }
            ])
        };

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
