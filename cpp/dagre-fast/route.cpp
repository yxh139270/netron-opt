#include "route.h"

namespace dagre_fast {

void route_edges(Graph& graph) {
    for (auto& edge : graph.edges) {
        edge.points.clear();

        const auto itV = graph.index.find(edge.v);
        const auto itW = graph.index.find(edge.w);
        if (itV == graph.index.end() || itW == graph.index.end()) {
            continue;
        }

        const auto& v = graph.nodes[itV->second];
        const auto& w = graph.nodes[itW->second];

        const double sy = v.y + v.height / 2.0;
        const double ty = w.y - w.height / 2.0;
        const double mid = sy + (ty - sy) / 2.0;

        edge.points.push_back({ v.x, sy });
        edge.points.push_back({ v.x, mid });
        edge.points.push_back({ w.x, mid });
        edge.points.push_back({ w.x, ty });
    }
}

} // namespace dagre_fast
