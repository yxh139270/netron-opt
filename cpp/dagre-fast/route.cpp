#include "route.h"

#include <algorithm>
#include <unordered_map>
#include <vector>

namespace dagre_fast {

void route_edges(Graph& graph) {
    std::unordered_map<std::string, std::vector<size_t>> outEdgesByNode;
    std::unordered_map<std::string, std::vector<size_t>> inEdgesByNode;
    for (size_t i = 0; i < graph.edges.size(); i++) {
        outEdgesByNode[graph.edges[i].v].push_back(i);
        inEdgesByNode[graph.edges[i].w].push_back(i);
    }

    std::unordered_map<size_t, size_t> outOrder;
    std::unordered_map<size_t, size_t> inOrder;

    for (auto& item : outEdgesByNode) {
        auto& ids = item.second;
        std::sort(ids.begin(), ids.end(), [&](size_t a, size_t b) {
            const auto itWa = graph.index.find(graph.edges[a].w);
            const auto itWb = graph.index.find(graph.edges[b].w);
            const double colA = itWa == graph.index.end() ? 0.0 : graph.nodes[itWa->second].col;
            const double colB = itWb == graph.index.end() ? 0.0 : graph.nodes[itWb->second].col;
            if (std::abs(colA - colB) > 1e-9) {
                return colA < colB;
            }
            return graph.edges[a].w < graph.edges[b].w;
        });
        for (size_t i = 0; i < ids.size(); i++) {
            outOrder[ids[i]] = i;
        }
    }

    for (auto& item : inEdgesByNode) {
        auto& ids = item.second;
        std::sort(ids.begin(), ids.end(), [&](size_t a, size_t b) {
            const auto itVa = graph.index.find(graph.edges[a].v);
            const auto itVb = graph.index.find(graph.edges[b].v);
            const double colA = itVa == graph.index.end() ? 0.0 : graph.nodes[itVa->second].col;
            const double colB = itVb == graph.index.end() ? 0.0 : graph.nodes[itVb->second].col;
            if (std::abs(colA - colB) > 1e-9) {
                return colA < colB;
            }
            return graph.edges[a].v < graph.edges[b].v;
        });
        for (size_t i = 0; i < ids.size(); i++) {
            inOrder[ids[i]] = i;
        }
    }

    const auto anchorX = [](const Node& node, size_t ordinal, size_t total) {
        if (total <= 1 || !(node.width > 0.0)) {
            return node.x;
        }
        const double spreadWidth = std::max(node.width * 1.3, node.width + 24.0);
        const double left = node.x - spreadWidth / 2.0;
        const double step = spreadWidth / static_cast<double>(total + 1);
        return left + step * static_cast<double>(ordinal + 1);
    };

    for (auto& edge : graph.edges) {
        edge.points.clear();

        const auto itV = graph.index.find(edge.v);
        const auto itW = graph.index.find(edge.w);
        if (itV == graph.index.end() || itW == graph.index.end()) {
            continue;
        }

        const auto& v = graph.nodes[itV->second];
        const auto& w = graph.nodes[itW->second];

        const size_t edgeIndex = static_cast<size_t>(&edge - &graph.edges[0]);
        const auto outCountIt = outEdgesByNode.find(edge.v);
        const auto inCountIt = inEdgesByNode.find(edge.w);
        const size_t outCount = outCountIt == outEdgesByNode.end() ? 1 : outCountIt->second.size();
        const size_t inCount = inCountIt == inEdgesByNode.end() ? 1 : inCountIt->second.size();
        const size_t outIdx = outOrder.count(edgeIndex) ? outOrder[edgeIndex] : 0;
        const size_t inIdx = inOrder.count(edgeIndex) ? inOrder[edgeIndex] : 0;
        const double sx = anchorX(v, outIdx, outCount);
        const double tx = anchorX(w, inIdx, inCount);

        const double sy = v.y + v.height / 2.0;
        const double ty = w.y - w.height / 2.0;
        const double mid = sy + (ty - sy) / 2.0;

        edge.points.push_back({ sx, sy });
        edge.points.push_back({ sx, mid });
        edge.points.push_back({ tx, mid });
        edge.points.push_back({ tx, ty });
    }
}

} // namespace dagre_fast
