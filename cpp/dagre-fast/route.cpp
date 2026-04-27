#include "route.h"

#include <algorithm>
#include <cmath>
#include <unordered_map>
#include <vector>

namespace dagre_fast {

void route_edges(Graph& graph) {
    std::unordered_map<std::string, std::vector<size_t>> outEdgesByNode;
    std::unordered_map<std::string, std::vector<size_t>> inEdgesByNode;
    for (size_t i = 0; i < graph.edges.size(); i++) {
        outEdgesByNode[graph.edges[i].src].push_back(i);
        inEdgesByNode[graph.edges[i].dst].push_back(i);
    }

    std::unordered_map<size_t, size_t> outOrder;
    std::unordered_map<size_t, size_t> inOrder;

    for (auto& item : outEdgesByNode) {
        auto& ids = item.second;
        std::sort(ids.begin(), ids.end(), [&](size_t a, size_t b) {
            const auto itWa = graph.index.find(graph.edges[a].dst);
            const auto itWb = graph.index.find(graph.edges[b].dst);
            const double colA = itWa == graph.index.end() ? 0.0 : graph.nodes[itWa->second].col;
            const double colB = itWb == graph.index.end() ? 0.0 : graph.nodes[itWb->second].col;
            if (std::abs(colA - colB) > 1e-9) {
                return colA < colB;
            }
            return graph.edges[a].dst < graph.edges[b].dst;
        });
        for (size_t i = 0; i < ids.size(); i++) {
            outOrder[ids[i]] = i;
        }
    }

    for (auto& item : inEdgesByNode) {
        auto& ids = item.second;
        std::sort(ids.begin(), ids.end(), [&](size_t a, size_t b) {
            const auto itVa = graph.index.find(graph.edges[a].src);
            const auto itVb = graph.index.find(graph.edges[b].src);
            const double colA = itVa == graph.index.end() ? 0.0 : graph.nodes[itVa->second].col;
            const double colB = itVb == graph.index.end() ? 0.0 : graph.nodes[itVb->second].col;
            if (std::abs(colA - colB) > 1e-9) {
                return colA < colB;
            }
            return graph.edges[a].src < graph.edges[b].src;
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

        const auto itV = graph.index.find(edge.src);
        const auto itW = graph.index.find(edge.dst);
        if (itV == graph.index.end() || itW == graph.index.end()) {
            continue;
        }

        const auto& v = graph.nodes[itV->second];
        const auto& w = graph.nodes[itW->second];

        const size_t edgeIndex = static_cast<size_t>(&edge - &graph.edges[0]);
        const auto outCountIt = outEdgesByNode.find(edge.src);
        const auto inCountIt = inEdgesByNode.find(edge.dst);
        const size_t outCount = outCountIt == outEdgesByNode.end() ? 1 : outCountIt->second.size();
        const size_t inCount = inCountIt == inEdgesByNode.end() ? 1 : inCountIt->second.size();
        const size_t outIdx = outOrder.count(edgeIndex) ? outOrder[edgeIndex] : 0;
        const size_t inIdx = inOrder.count(edgeIndex) ? inOrder[edgeIndex] : 0;
        const double sx = anchorX(v, outIdx, outCount);
        const double tx = anchorX(w, inIdx, inCount);

        double sy = v.y + v.height / 2.0;
        double ty = w.y - w.height / 2.0;
        if (v.height == 0 && w.height != 0) {
            sy = ty - 15;
        } else if (v.height != 0 && w.height == 0) {
            ty = sy + 15;
        }
        const double dx = tx - sx;
        const double dy = ty - sy;

        const bool multiOutput = outCount > 1;
        const bool multiInput = inCount > 1;

        edge.points.push_back({ sx, sy });

        if (multiOutput && !multiInput) {
            edge.points.push_back({
                sx + 0.3 * dx,
                sy + std::pow(0.3, 3.0) * (0.9 * dy)
            });
            edge.points.push_back({
                sx + 0.7 * dx,
                sy + std::pow(0.7, 3.0) * (0.9 * dy)
            });
            edge.points.push_back({
                tx - 0.1 * dx,
                ty - 0.1 * dy
            });
        } else if (multiInput && !multiOutput) {
            edge.points.push_back({
                sx + 0.1 * dx,
                sy + 0.1 * dy
            });
            edge.points.push_back({
                tx - 0.7 * dx,
                ty - std::pow(0.7, 3.0) * (0.9 * dy)
            });
            edge.points.push_back({
                tx - 0.3 * dx,
                ty - std::pow(0.3, 3.0) * (0.9 * dy)
            });
        } else if (multiOutput && multiInput) {
            edge.points.push_back({
                sx + 0.3 * dx,
                sy + std::pow(0.3, 3.0) * (0.9 * dy)
            });
            edge.points.push_back({
                sx + 0.7 * dx,
                sy + std::pow(0.7, 3.0) * (0.9 * dy)
            });
            edge.points.push_back({
                tx - std::pow(0.7, 3.0) * dx,
                ty - 0.7 * (0.9 * dy)
            });
            edge.points.push_back({
                tx - std::pow(0.3, 3.0) * dx,
                ty - 0.3 * (0.9 * dy)
            });
        } else {
            const double mid = sy + (ty - sy) / 2.0;
            edge.points.push_back({ sx, mid });
            edge.points.push_back({ tx, mid });
        }

        edge.points.push_back({ tx, ty });

        const size_t n = edge.points.size();
        const size_t left = (n - 1) / 2;
        const size_t right = n / 2;
        edge.x = (edge.points[left].x + edge.points[right].x) / 2.0;
        edge.y = (edge.points[left].y + edge.points[right].y) / 2.0;
    }
}

} // namespace dagre_fast
