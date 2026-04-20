use std::collections::HashMap;

pub type NodeLabel = serde_json::Value;
pub type EdgeLabel = serde_json::Value;

const ROOT_ID: &str = "__root__";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EdgeRef {
    pub id: String,
    pub v: String,
    pub w: String,
}

#[derive(Debug, Clone)]
pub struct Graph {
    is_compound: bool,
    is_multigraph: bool,
    nodes: HashMap<String, NodeLabel>,
    edges: HashMap<String, (String, String)>,
    edge_labels: HashMap<String, EdgeLabel>,
    out_edges: HashMap<String, Vec<String>>,
    in_edges: HashMap<String, Vec<String>>,
    parents: HashMap<String, String>,
    children: HashMap<String, Vec<String>>,
    edge_sequence: usize,
    edge_insert_sequence: usize,
    edge_insert_order: HashMap<String, usize>,
    node_sequence: usize,
    node_insert_order: HashMap<String, usize>,
}

impl Graph {
    pub fn new(is_compound: bool, is_multigraph: bool) -> Self {
        Self {
            is_compound,
            is_multigraph,
            nodes: HashMap::new(),
            edges: HashMap::new(),
            edge_labels: HashMap::new(),
            out_edges: HashMap::new(),
            in_edges: HashMap::new(),
            parents: HashMap::new(),
            children: HashMap::new(),
            edge_sequence: 0,
            edge_insert_sequence: 0,
            edge_insert_order: HashMap::new(),
            node_sequence: 0,
            node_insert_order: HashMap::new(),
        }
    }

    pub fn set_node(&mut self, id: &str, label: NodeLabel) {
        let key = id.to_string();
        let existed = self.nodes.contains_key(&key);
        self.nodes.insert(key.clone(), label);
        if !self.node_insert_order.contains_key(&key) {
            self.node_insert_order.insert(key.clone(), self.node_sequence);
            self.node_sequence += 1;
        }

        if self.is_compound && !existed && !self.parents.contains_key(&key) {
            self.parents.insert(key.clone(), ROOT_ID.to_string());
            self.children
                .entry(ROOT_ID.to_string())
                .or_default()
                .push(key);
        }
    }

    pub fn set_edge(&mut self, v: &str, w: &str, label: EdgeLabel) -> String {
        self.set_edge_with_key(v, w, None, label)
    }

    pub fn set_edge_with_key(&mut self, v: &str, w: &str, key: Option<&str>, label: EdgeLabel) -> String {
        self.ensure_node(v);
        self.ensure_node(w);

        if self.is_multigraph {
            let edge_key = match key {
                Some(value) => value.to_string(),
                None => {
                    let value = self.edge_sequence.to_string();
                    self.edge_sequence += 1;
                    value
                }
            };
            let edge_id = format!("{}->{}#{}", v, w, edge_key);
            let is_new = !self.edges.contains_key(&edge_id);
            self.edges
                .insert(edge_id.clone(), (v.to_string(), w.to_string()));
            self.edge_labels.insert(edge_id.clone(), label);
            if is_new {
                self.edge_insert_order
                    .insert(edge_id.clone(), self.edge_insert_sequence);
                self.edge_insert_sequence += 1;
            }
            self.out_edges
                .entry(v.to_string())
                .or_default()
                .push(edge_id.clone());
            self.in_edges
                .entry(w.to_string())
                .or_default()
                .push(edge_id.clone());
            return edge_id;
        }

        let edge_id = format!("{}->{}", v, w);
        let is_new = !self.edges.contains_key(&edge_id);
        self.edges
            .insert(edge_id.clone(), (v.to_string(), w.to_string()));
        self.edge_labels.insert(edge_id.clone(), label);

        if is_new {
            self.edge_insert_order
                .insert(edge_id.clone(), self.edge_insert_sequence);
            self.edge_insert_sequence += 1;
            self.out_edges
                .entry(v.to_string())
                .or_default()
                .push(edge_id.clone());
            self.in_edges
                .entry(w.to_string())
                .or_default()
                .push(edge_id.clone());
        }

        edge_id
    }

    pub fn successors(&self, id: &str) -> Vec<String> {
        let mut successors = Vec::new();
        if let Some(edge_ids) = self.out_edges.get(id) {
            for edge_id in edge_ids {
                if let Some((_v, w)) = self.edges.get(edge_id) {
                    if !successors.contains(w) {
                        successors.push(w.clone());
                    }
                }
            }
        }
        successors.sort();
        successors
    }

    pub fn successors_insertion_order(&self, id: &str) -> Vec<String> {
        let mut seen = std::collections::HashSet::new();
        let mut successors = Vec::new();
        if let Some(edge_ids) = self.out_edges.get(id) {
            for edge_id in edge_ids {
                if let Some((_v, w)) = self.edges.get(edge_id) {
                    if seen.insert(w.clone()) {
                        successors.push(w.clone());
                    }
                }
            }
        }
        successors
    }

    pub fn predecessors(&self, id: &str) -> Vec<String> {
        let mut predecessors = Vec::new();
        if let Some(edge_ids) = self.in_edges.get(id) {
            for edge_id in edge_ids {
                if let Some((v, _w)) = self.edges.get(edge_id) {
                    if !predecessors.contains(v) {
                        predecessors.push(v.clone());
                    }
                }
            }
        }
        predecessors.sort();
        predecessors
    }

    pub fn set_parent(&mut self, id: &str, parent: Option<&str>) {
        if !self.is_compound {
            return;
        }

        self.ensure_node(id);
        if let Some(parent_id) = parent {
            self.ensure_node(parent_id);
        }

        let node_id = id.to_string();
        let next_parent = parent.unwrap_or(ROOT_ID).to_string();

        if node_id == next_parent {
            return;
        }
        if self.is_descendant(&next_parent, &node_id) {
            return;
        }

        if let Some(old_parent) = self.parents.get(&node_id).cloned() {
            if let Some(old_children) = self.children.get_mut(&old_parent) {
                old_children.retain(|child| child != &node_id);
            }
        }

        self.parents.insert(node_id.clone(), next_parent.clone());
        self.children.entry(next_parent).or_default().push(node_id);
    }

    pub fn parent(&self, id: &str) -> Option<String> {
        if !self.is_compound {
            return None;
        }

        match self.parents.get(id) {
            Some(parent) if parent != ROOT_ID => Some(parent.clone()),
            _ => None,
        }
    }

    pub fn children(&self, id: Option<&str>) -> Vec<String> {
        if !self.is_compound {
            return Vec::new();
        }

        let parent_key = id.unwrap_or(ROOT_ID);
        let mut out = self.children.get(parent_key).cloned().unwrap_or_default();
        out.sort();
        out.dedup();
        out
    }

    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    pub fn nodes(&self) -> Vec<String> {
        let mut nodes: Vec<String> = self.nodes.keys().cloned().collect();
        nodes.sort();
        nodes
    }

    pub fn nodes_insertion_order(&self) -> Vec<String> {
        let mut nodes: Vec<(usize, String)> = self
            .nodes
            .keys()
            .map(|id| {
                (
                    self.node_insert_order.get(id).copied().unwrap_or(usize::MAX),
                    id.clone(),
                )
            })
            .collect();
        nodes.sort_by(|left, right| left.0.cmp(&right.0));
        nodes.into_iter().map(|(_, id)| id).collect()
    }

    pub fn is_compound(&self) -> bool {
        self.is_compound
    }

    pub fn is_multigraph(&self) -> bool {
        self.is_multigraph
    }

    pub fn edge_count(&self) -> usize {
        self.edges.len()
    }

    pub fn remove_edge(&mut self, edge_id: &str) -> bool {
        let Some((v, w)) = self.edges.remove(edge_id) else {
            return false;
        };
        self.edge_labels.remove(edge_id);
        if let Some(out) = self.out_edges.get_mut(&v) {
            out.retain(|id| id != edge_id);
        }
        if let Some(input) = self.in_edges.get_mut(&w) {
            input.retain(|id| id != edge_id);
        }
        self.edge_insert_order.remove(edge_id);
        true
    }

    pub fn remove_node(&mut self, id: &str) -> bool {
        if !self.nodes.contains_key(id) {
            return false;
        }

        let mut incident = Vec::new();
        if let Some(edges) = self.out_edges.get(id) {
            incident.extend(edges.iter().cloned());
        }
        if let Some(edges) = self.in_edges.get(id) {
            incident.extend(edges.iter().cloned());
        }
        incident.sort();
        incident.dedup();
        for edge_id in incident {
            let _ = self.remove_edge(&edge_id);
        }

        self.out_edges.remove(id);
        self.in_edges.remove(id);

        if self.is_compound {
            if let Some(parent) = self.parents.remove(id) {
                if let Some(children) = self.children.get_mut(&parent) {
                    children.retain(|child| child != id);
                }
            }
            if let Some(children) = self.children.remove(id) {
                for child in children {
                    self.set_parent(&child, None);
                }
            }
        }

        self.nodes.remove(id);
        self.node_insert_order.remove(id);
        true
    }

    pub fn node_label(&self, id: &str) -> Option<&NodeLabel> {
        self.nodes.get(id)
    }

    pub fn edge_label(&self, edge_id: &str) -> Option<&EdgeLabel> {
        self.edge_labels.get(edge_id)
    }

    pub fn set_edge_label(&mut self, edge_id: &str, label: EdgeLabel) -> bool {
        if self.edges.contains_key(edge_id) {
            self.edge_labels.insert(edge_id.to_string(), label);
            true
        } else {
            false
        }
    }

    pub fn edges(&self) -> Vec<EdgeRef> {
        let mut ids: Vec<String> = self.edges.keys().cloned().collect();
        ids.sort();

        ids.into_iter()
            .filter_map(|id| {
                self.edges.get(&id).map(|(v, w)| EdgeRef {
                    id,
                    v: v.clone(),
                    w: w.clone(),
                })
            })
            .collect()
    }

    pub fn edges_insertion_order(&self) -> Vec<EdgeRef> {
        let mut ids: Vec<(usize, String)> = self
            .edges
            .keys()
            .map(|id| {
                (
                    self.edge_insert_order.get(id).copied().unwrap_or(usize::MAX),
                    id.clone(),
                )
            })
            .collect();
        ids.sort_by(|left, right| left.0.cmp(&right.0));

        ids.into_iter()
            .filter_map(|(_, id)| {
                self.edges.get(&id).map(|(v, w)| EdgeRef {
                    id,
                    v: v.clone(),
                    w: w.clone(),
                })
            })
            .collect()
    }

    pub fn as_non_compound_graph(&self) -> Graph {
        let mut graph = Graph::new(false, false);

        for node_id in self.nodes() {
            if self.is_compound() && !self.children(Some(&node_id)).is_empty() {
                continue;
            }
            if let Some(label) = self.node_label(&node_id) {
                graph.set_node(&node_id, label.clone());
            }
        }

        for edge in self.edges() {
            if let Some(label) = self.edge_label(&edge.id) {
                graph.set_edge(&edge.v, &edge.w, label.clone());
            }
        }

        graph
    }

    fn ensure_node(&mut self, id: &str) {
        if self.nodes.contains_key(id) {
            return;
        }
        self.set_node(id, serde_json::Value::Null);
    }

    fn is_descendant(&self, candidate_parent: &str, node_id: &str) -> bool {
        if !self.is_compound {
            return false;
        }
        let mut current = candidate_parent;
        while current != ROOT_ID {
            if current == node_id {
                return true;
            }
            match self.parents.get(current) {
                Some(parent) => {
                    current = parent;
                }
                None => {
                    break;
                }
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::Graph;

    #[test]
    fn inserts_nodes_and_edges_with_deterministic_neighbors() {
        let mut graph = Graph::new(false, false);
        graph.set_node("b", serde_json::json!({"width": 20}));
        graph.set_node("a", serde_json::json!({"width": 10}));
        graph.set_edge("a", "b", serde_json::json!({"minlen": 1}));

        assert_eq!(graph.node_count(), 2);
        assert_eq!(graph.edge_count(), 1);
        assert_eq!(graph.successors("a"), vec!["b".to_string()]);
        assert_eq!(graph.predecessors("b"), vec!["a".to_string()]);
        assert_eq!(graph.successors("missing"), Vec::<String>::new());
        assert_eq!(graph.predecessors("missing"), Vec::<String>::new());
        assert_eq!(graph.node_label("a"), Some(&serde_json::json!({"width": 10})));
    }

    #[test]
    fn set_edge_auto_creates_missing_nodes() {
        let mut graph = Graph::new(false, false);
        graph.set_edge("left", "right", serde_json::json!({}));

        assert_eq!(graph.node_count(), 2);
        assert_eq!(graph.successors("left"), vec!["right".to_string()]);
        assert_eq!(graph.predecessors("right"), vec!["left".to_string()]);
    }

    #[test]
    fn successors_insertion_order_preserves_edge_add_order() {
        let mut graph = Graph::new(false, false);
        graph.set_edge("s", "y", serde_json::json!({}));
        graph.set_edge("s", "x", serde_json::json!({}));

        assert_eq!(graph.successors("s"), vec!["x".to_string(), "y".to_string()]);
        assert_eq!(
            graph.successors_insertion_order("s"),
            vec!["y".to_string(), "x".to_string()]
        );
    }

    #[test]
    fn set_parent_tracks_compound_children() {
        let mut graph = Graph::new(true, false);
        graph.set_node("cluster", serde_json::json!({}));
        graph.set_node("n1", serde_json::json!({}));
        graph.set_node("n2", serde_json::json!({}));
        graph.set_parent("n2", Some("cluster"));
        graph.set_parent("n1", Some("cluster"));

        assert_eq!(graph.parent("n1"), Some("cluster".to_string()));
        assert_eq!(graph.parent("n2"), Some("cluster".to_string()));
        assert_eq!(graph.children(Some("cluster")), vec!["n1".to_string(), "n2".to_string()]);
        assert_eq!(graph.children(None), vec!["cluster".to_string()]);
    }

    #[test]
    fn overwriting_same_edge_keeps_single_edge_and_updates_label() {
        let mut graph = Graph::new(false, false);
        let id1 = graph.set_edge("a", "b", serde_json::json!({"weight": 1}));
        let id2 = graph.set_edge("a", "b", serde_json::json!({"weight": 2}));

        assert_eq!(id1, id2);
        assert_eq!(graph.edge_count(), 1);
        assert_eq!(graph.edge_label(&id1), Some(&serde_json::json!({"weight": 2})));
        assert_eq!(graph.edges().len(), 1);
    }

    #[test]
    fn set_parent_rejects_self_or_cycle_relationship() {
        let mut graph = Graph::new(true, false);
        graph.set_node("a", serde_json::json!({}));
        graph.set_node("b", serde_json::json!({}));
        graph.set_parent("b", Some("a"));
        graph.set_parent("a", Some("a"));
        graph.set_parent("a", Some("b"));

        assert_eq!(graph.parent("a"), None);
        assert_eq!(graph.parent("b"), Some("a".to_string()));
    }

    #[test]
    fn multigraph_supports_stable_explicit_edge_key() {
        let mut graph = Graph::new(false, true);
        let edge_id = graph.set_edge_with_key("a", "b", Some("edge-1"), serde_json::json!({}));

        assert_eq!(edge_id, "a->b#edge-1".to_string());
        assert_eq!(graph.edge_count(), 1);
        assert_eq!(graph.successors("a"), vec!["b".to_string()]);
    }

    #[test]
    fn remove_node_drops_incident_edges() {
        let mut graph = Graph::new(false, false);
        graph.set_edge("a", "b", serde_json::json!({}));
        graph.set_edge("b", "c", serde_json::json!({}));

        assert!(graph.remove_node("b"));
        assert_eq!(graph.edge_count(), 0);
        assert_eq!(graph.successors("a"), Vec::<String>::new());
        assert_eq!(graph.predecessors("c"), Vec::<String>::new());
    }

    #[test]
    fn as_non_compound_graph_removes_parent_nodes_keeps_leaf_children_and_edges() {
        let mut graph = Graph::new(true, false);
        graph.set_node("cluster", serde_json::json!({"kind":"parent"}));
        graph.set_node("a", serde_json::json!({"kind":"leaf"}));
        graph.set_node("b", serde_json::json!({"kind":"leaf"}));
        graph.set_parent("a", Some("cluster"));
        graph.set_parent("b", Some("cluster"));
        graph.set_edge("a", "b", serde_json::json!({"minlen": 2}));

        let flat = graph.as_non_compound_graph();

        assert!(!flat.is_compound());
        assert!(flat.node_label("cluster").is_none(), "compound parent should be omitted");
        assert!(flat.node_label("a").is_some(), "leaf child should be kept");
        assert!(flat.node_label("b").is_some(), "leaf child should be kept");
        assert_eq!(flat.edge_count(), 1, "edge between leaf nodes should be preserved");
    }
}
