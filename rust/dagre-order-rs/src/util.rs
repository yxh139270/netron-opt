use std::collections::HashMap;
use std::hash::Hash;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = Date, js_name = now)]
    fn js_date_now() -> f64;
}

pub fn edge_minlen(label: &serde_json::Value) -> i64 {
    label
        .get("minlen")
        .and_then(serde_json::Value::as_i64)
        .filter(|value| *value > 0)
        .unwrap_or(1)
}

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

pub fn now_ms() -> f64 {
    #[cfg(target_arch = "wasm32")]
    {
        js_date_now()
    }

    #[cfg(not(target_arch = "wasm32"))]
    {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs_f64() * 1000.0)
            .unwrap_or(0.0)
    }
}
