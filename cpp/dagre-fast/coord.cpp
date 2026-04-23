#include "coord.h"

#include <algorithm>
#include <map>
#include <unordered_map>
#include <vector>

namespace dagre_fast {

void assign_coord(Graph& graph) {
    const double nodesep = graph.options.nodesep;
    const double ranksep = graph.options.ranksep;

    std::map<int, std::vector<size_t>> rank_nodes;
    for (size_t i = 0; i < graph.nodes.size(); i++) {
        rank_nodes[graph.nodes[i].rank].push_back(i);
    }

    std::unordered_map<int, double> rank_y;
    double cursor_y = 0;
    bool first = true;
    for (const auto& [rank, ids] : rank_nodes) {
        double max_h = 0;
        for (const auto id : ids) {
            max_h = std::max(max_h, graph.nodes[id].height);
        }
        if (first) {
            cursor_y = max_h / 2.0;
            first = false;
        } else {
            cursor_y += ranksep + max_h;
        }
        rank_y[rank] = cursor_y;
    }

    std::unordered_map<int, std::vector<size_t>> by_rank;
    for (size_t i = 0; i < graph.nodes.size(); i++) {
        by_rank[graph.nodes[i].rank].push_back(i);
    }

    for (auto& [rank, ids] : by_rank) {
        (void)rank;
        std::sort(ids.begin(), ids.end(), [&](size_t a, size_t b) {
            if (graph.nodes[a].col == graph.nodes[b].col) {
                return graph.nodes[a].v < graph.nodes[b].v;
            }
            return graph.nodes[a].col < graph.nodes[b].col;
        });

        double x = 0;
        bool first_node = true;
        for (const auto id : ids) {
            if (first_node) {
                x = graph.nodes[id].width / 2.0;
                first_node = false;
            } else {
                x += nodesep + graph.nodes[id].width;
            }
            graph.nodes[id].x = x;
            graph.nodes[id].y = rank_y[graph.nodes[id].rank];
        }
    }
}

} // namespace dagre_fast
