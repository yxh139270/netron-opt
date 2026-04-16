use std::collections::HashMap;
use std::hash::Hash;

pub fn unique_id(prefix: &str, counter: &mut usize) -> String {
    let id = format!("{}{}", prefix, *counter);
    *counter += 1;
    id
}

pub fn map_values<K, V, U>(input: &HashMap<K, V>, f: impl Fn(&V) -> U) -> HashMap<K, U>
where
    K: Eq + Hash + Clone,
{
    let mut output = HashMap::with_capacity(input.len());
    for (key, value) in input {
        output.insert(key.clone(), f(value));
    }
    output
}
