use std::fs;

fn main() {
    let input_str = fs::read_to_string("/tmp/yolov5s-rust-input.json").unwrap();
    let output = dagre_order_rs::layout(&input_str);
    fs::write("/tmp/yolov5s-rust-output.json", &output).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&output).unwrap();
    if let Some(err) = parsed.get("error") {
        eprintln!("ERROR: {}", err);
        return;
    }
    // 用 debugStages 重新运行来获取 rank 信息
    let mut input: serde_json::Value = serde_json::from_str(&input_str).unwrap();
    input["layout"]["debugStages"] = serde_json::json!(true);
    let debug_output = dagre_order_rs::layout(&serde_json::to_string(&input).unwrap());
    let debug_parsed: serde_json::Value = serde_json::from_str(&debug_output).unwrap();
    
    if let Some(debug) = debug_parsed.get("debug") {
        if let Some(stages) = debug.get("stageSnapshots").and_then(|v| v.as_array()) {
            for stage in stages {
                let stage_name = stage.get("stage").and_then(|v| v.as_str()).unwrap_or("?");
                if stage_name == "rank" || stage_name == "normalize" {
                    let nodes = stage.get("nodes").and_then(|v| v.as_array()).unwrap();
                    // 找 node 0 和 1 的 rank
                    for n in nodes {
                        let id = n.get("id").and_then(|v| v.as_str()).unwrap_or("?");
                        if id == "0" || id == "1" {
                            let rank = n.get("rank").and_then(|v| v.as_i64());
                            println!("[{}] node {} rank={:?}", stage_name, id, rank);
                        }
                    }
                    // 统计 dummy 节点
                    let dummies: Vec<_> = nodes.iter().filter(|n| n.get("dummy").and_then(|v| v.as_str()).is_some()).collect();
                    println!("[{}] total nodes={} dummies={}", stage_name, nodes.len(), dummies.len());
                }
            }
        }
    }
    
    let out_nodes = parsed["nodes"].as_array().unwrap();
    println!("\nNode 0: x={:.1} y={:.1}", out_nodes[0]["x"].as_f64().unwrap_or(0.0), out_nodes[0]["y"].as_f64().unwrap_or(0.0));
    println!("Node 1: x={:.1} y={:.1}", out_nodes[1]["x"].as_f64().unwrap_or(0.0), out_nodes[1]["y"].as_f64().unwrap_or(0.0));
    let out_edges = parsed["edges"].as_array().unwrap();
    println!("Edge 0->1 points: {}", out_edges[0]["points"].as_array().map(|a| a.len()).unwrap_or(0));
}
