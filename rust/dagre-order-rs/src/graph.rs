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
        }
    }

    pub fn set_node(&mut self, id: &str, label: NodeLabel) {
        let key = id.to_string();
        let existed = self.nodes.contains_key(&key);
        self.nodes.insert(key.clone(), label);

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
            self.edges
                .insert(edge_id.clone(), (v.to_string(), w.to_string()));
            self.edge_labels.insert(edge_id.clone(), label);
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

    pub fn is_compound(&self) -> bool {
        self.is_compound
    }

    pub fn is_multigraph(&self) -> bool {
        self.is_multigraph
    }

    pub fn edge_count(&self) -> usize {
        self.edges.len()
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
}
