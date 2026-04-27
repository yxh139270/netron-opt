#include "coord.h"

#include <algorithm>
#include <limits>
#include <map>
#include <unordered_map>
#include <vector>

namespace dagre_fast {

void assign_coord(Graph& graph) {
    const double nodesep = graph.options.nodesep;
    const double ranksep = graph.options.ranksep;

    graph.log << "[coord] === Coordinate Assignment ===\n";
    graph.log << "[coord] options: nodesep=" << nodesep
              << " ranksep=" << ranksep << "\n";

    std::map<int, std::vector<size_t>> rank_nodes;
    for (size_t i = 0; i < graph.nodes.size(); i++) {
        rank_nodes[graph.nodes[i].rank].push_back(i);
    }

    std::unordered_map<std::string, std::vector<std::pair<std::string, double>>> incoming;
    for (const auto& edge : graph.edges) {
        double gap = edge.height;
        if (!(gap > 0.0)) {
            gap = edge.hasLabel ? 45.0 : 40.0;
        }
        incoming[edge.w].push_back({ edge.v, gap });
    }

    std::unordered_map<int, double> rank_y;
    double cursor_y = 0;
    bool first = true;
    double prev_max_h = 0;
    for (const auto& [rank, ids] : rank_nodes) {
        double max_h = 0;
        for (const auto id : ids) {
            max_h = std::max(max_h, graph.nodes[id].height);
        }
        if (first) {
            cursor_y = max_h / 2.0;
            first = false;
        } else {
            const double base = cursor_y + prev_max_h / 2.0 + ranksep + max_h / 2.0;
            double constrained = 0.0;
            for (const auto id : ids) {
                const auto& node = graph.nodes[id];
                double candidate_y = node.height / 2.0;
                const auto it = incoming.find(node.v);
                if (it != incoming.end()) {
                    for (const auto& p : it->second) {
                        const auto ip = graph.index.find(p.first);
                        if (ip == graph.index.end()) {
                            continue;
                        }
                        const auto& pred = graph.nodes[ip->second];
                        const auto iy = rank_y.find(pred.rank);
                        if (iy == rank_y.end()) {
                            continue;
                        }
                        candidate_y = std::max(
                            candidate_y,
                            iy->second + pred.height / 2.0 + p.second + node.height / 2.0);
                    }
                }
                constrained = std::max(constrained, candidate_y);
            }
            cursor_y = std::max(base, constrained);
        }
        rank_y[rank] = cursor_y;
        prev_max_h = max_h;
        graph.log << "[coord] rank=" << rank
                  << " nodeCount=" << ids.size()
                  << " maxHeight=" << max_h
                  << " y=" << cursor_y << "\n";
    }

    double min_col = std::numeric_limits<double>::max();
    double max_col = std::numeric_limits<double>::lowest();
    double max_width = 0.0;
    for (const auto& node : graph.nodes) {
        min_col = std::min(min_col, node.col);
        max_col = std::max(max_col, node.col);
        max_width = std::max(max_width, node.width);
    }
    if (max_width <= 0.0) {
        max_width = 1.0;
    }
    const double col_step = max_width + nodesep;
    graph.log << "[coord] col-map: minCol=" << min_col
              << " maxCol=" << max_col
              << " maxWidth=" << max_width
              << " colStep=" << col_step << "\n";

    std::unordered_map<int, std::vector<size_t>> by_rank;
    for (size_t i = 0; i < graph.nodes.size(); i++) {
        by_rank[graph.nodes[i].rank].push_back(i);
    }

    for (auto& [rank, ids] : by_rank) {
        std::sort(ids.begin(), ids.end(), [&](size_t a, size_t b) {
            if (graph.nodes[a].col == graph.nodes[b].col) {
                return graph.nodes[a].v < graph.nodes[b].v;
            }
            return graph.nodes[a].col < graph.nodes[b].col;
        });

        graph.log << "[coord] rank=" << rank << " sortedByCol: ";
        for (size_t i = 0; i < ids.size(); i++) {
            if (i > 0) graph.log << ", ";
            const auto& n = graph.nodes[ids[i]];
            graph.log << n.v << "(col=" << n.col << ",w=" << n.width << ")";
        }
        graph.log << "\n";

        for (const auto id : ids) {
            graph.nodes[id].x = (graph.nodes[id].col - min_col) * col_step + max_width / 2.0;
            graph.nodes[id].y = rank_y[graph.nodes[id].rank];
            graph.log << "[coord] place node=" << graph.nodes[id].v
                      << " rank=" << graph.nodes[id].rank
                      << " col=" << graph.nodes[id].col
                      << " -> x=" << graph.nodes[id].x
                      << " y=" << graph.nodes[id].y
                      << "\n";
        }
    }

    graph.log << "[coord] === Coordinate Assignment Done ===\n";
}

} // namespace dagre_fast
