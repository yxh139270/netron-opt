use std::collections::HashMap;

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

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::normalize_graph;

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
}
