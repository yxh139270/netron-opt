#include "layout.h"

#include "column.h"
#include "coord.h"
#include "json_io.h"
#include "rank.h"
#include "route.h"

#include <chrono>
#include <cstdlib>
#include <cstring>
#include <sstream>
#include <string>

namespace dagre_fast {

bool run_layout(Graph& graph, Meta& meta) {
    using Clock = std::chrono::steady_clock;

    const auto t0 = Clock::now();
    assign_rank(graph);
    const auto t1 = Clock::now();
    assign_column(graph);
    const auto t2 = Clock::now();
    assign_coord(graph);
    const auto t3 = Clock::now();
    route_edges(graph);
    const auto t4 = Clock::now();

    const auto ms = [](Clock::time_point a, Clock::time_point b) {
        return std::chrono::duration_cast<std::chrono::milliseconds>(b - a).count();
    };

    std::ostringstream ss;
    ss << "rank=" << ms(t0, t1)
       << ",column=" << ms(t1, t2)
       << ",coord=" << ms(t2, t3)
       << ",route=" << ms(t3, t4);
    meta.stage_ms = ss.str();
    meta.log = graph.log.str();
    meta.ok = true;
    return true;
}

} // namespace dagre_fast

extern "C" {
const char* layout_json(const char* input) {
    dagre_fast::Graph graph;
    dagre_fast::Meta meta;

    std::string error;
    const std::string payload = input ? input : "{}";
    bool ok = dagre_fast::parse_input_json(payload, graph, error);
    if (!ok) {
        meta.ok = false;
        meta.stage_ms = "";
        std::string safe = error;
        for (char& c : safe) {
            if (c == '\"') {
                c = '\'';
            }
        }
        std::string output = std::string("{\"nodes\":[],\"edges\":[],\"meta\":{\"ok\":false,\"stage_ms\":\"\",\"error\":\"") + safe + "\"}}";
        char* buffer = static_cast<char*>(std::malloc(output.size() + 1));
        std::memcpy(buffer, output.c_str(), output.size() + 1);
        return buffer;
    }

    dagre_fast::run_layout(graph, meta);
    const std::string output = dagre_fast::serialize_output_json(graph, meta);
    char* buffer = static_cast<char*>(std::malloc(output.size() + 1));
    std::memcpy(buffer, output.c_str(), output.size() + 1);
    return buffer;
}

void free_json(const char* p) {
    std::free(const_cast<char*>(p));
}
}
