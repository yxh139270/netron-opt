#include "column.h"

#include <algorithm>
#include <map>
#include <vector>

namespace dagre_fast {

void assign_column(Graph& graph) {
    std::map<int, std::vector<size_t>> rank_nodes;
    for (size_t i = 0; i < graph.nodes.size(); i++) {
        rank_nodes[graph.nodes[i].rank].push_back(i);
    }

    graph.log << "[column] === Column Assignment ===\n";
    for (auto& [rank, ids] : rank_nodes) {
        std::sort(ids.begin(), ids.end(), [&](size_t a, size_t b) {
            return graph.nodes[a].v < graph.nodes[b].v;
        });
        for (size_t i = 0; i < ids.size(); i++) {
            graph.nodes[ids[i]].col = static_cast<double>(i);
        }
        graph.log << "  rank=" << rank << " nodes=" << ids.size() << ": ";
        for (size_t i = 0; i < ids.size(); i++) {
            if (i > 0) graph.log << ", ";
            graph.log << "\"" << graph.nodes[ids[i]].v << "\".col=" << graph.nodes[ids[i]].col;
        }
        graph.log << "\n";
    }
    graph.log << "[column] === Column Assignment Done ===\n";
}

} // namespace dagre_fast
