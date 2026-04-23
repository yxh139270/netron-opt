#include "rank.h"

#include <algorithm>
#include <cstdint>
#include <queue>
#include <vector>

namespace dagre_fast {

void assign_rank(Graph& graph) {
    const size_t n = graph.nodes.size();
    std::vector<int> indegree(n, 0);
    std::vector<std::vector<size_t>> out(n);
    std::vector<std::vector<size_t>> in(n);

    for (const auto& edge : graph.edges) {
        const auto itV = graph.index.find(edge.v);
        const auto itW = graph.index.find(edge.w);
        if (itV == graph.index.end() || itW == graph.index.end()) {
            continue;
        }
        const size_t vi = itV->second;
        const size_t wi = itW->second;
        out[vi].push_back(wi);
        in[wi].push_back(vi);
        indegree[wi] += 1;
    }

    std::queue<size_t> q;
    for (size_t i = 0; i < n; i++) {
        graph.nodes[i].rank = 0;
        if (indegree[i] == 0) {
            q.push(i);
        }
    }

    std::vector<size_t> topo;
    topo.reserve(n);
    while (!q.empty()) {
        const size_t cur = q.front();
        q.pop();
        topo.push_back(cur);
        for (const auto nxt : out[cur]) {
            indegree[nxt] -= 1;
            if (indegree[nxt] == 0) {
                q.push(nxt);
            }
        }
    }

    if (topo.size() != n) {
        topo.clear();
        topo.reserve(n);
        for (size_t i = 0; i < n; i++) {
            topo.push_back(i);
        }
    }

    graph.log << "[rank] === Rank Assignment ===\n";

    // Forward pass: push rank down from predecessors
    for (const auto id : topo) {
        int best = 0;
        for (const auto& edge : graph.edges) {
            if (edge.w != graph.nodes[id].v) {
                continue;
            }
            const auto itV = graph.index.find(edge.v);
            if (itV == graph.index.end()) {
                continue;
            }
            const int candidate = graph.nodes[itV->second].rank + std::max(1, edge.minlen);
            best = std::max(best, candidate);
        }
        graph.nodes[id].rank = best;
        graph.log << "  [fwd] node=\"" << graph.nodes[id].v << "\" rank=" << graph.nodes[id].rank << "\n";
    }

    // Backward pass: pull rank up toward successors
    auto reverseTopo = topo;
    std::reverse(reverseTopo.begin(), reverseTopo.end());
    for (const auto id : reverseTopo) {
        int best = graph.nodes[id].rank;
        int changeBest = INT32_MAX;
        for (const auto& edge : graph.edges) {
            if (edge.v != graph.nodes[id].v) {
                continue;
            }
            const auto itW = graph.index.find(edge.w);
            if (itW == graph.index.end()) {
                continue;
            }
            const int candidate = graph.nodes[itW->second].rank - std::max(1, edge.minlen);
            changeBest = std::min(changeBest, candidate);
        }
        int oldRank = graph.nodes[id].rank;
        if (changeBest != INT32_MAX) {
            graph.nodes[id].rank = std::max(best, changeBest);
        }
        graph.log << "  [bwd] node=\"" << graph.nodes[id].v << "\" rank=" << oldRank << " -> " << graph.nodes[id].rank << "\n";
    }

    graph.log << "[rank] === Rank Assignment Done ===\n";
}

} // namespace dagre_fast
