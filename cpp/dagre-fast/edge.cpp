#include "edge.h"

#include <set>
#include <unordered_map>

namespace dagre_fast {

void insert_virtual_nodes(Graph& graph) {
    graph.log << "[virtual] === Virtual Node Insertion ===\n";

    int virtualCounter = 0;
    std::vector<Edge> newEdges;

    for (auto& edge : graph.edges) {
        const auto itV = graph.index.find(edge.src);
        const auto itW = graph.index.find(edge.dst);
        if (itV == graph.index.end() || itW == graph.index.end()) {
            newEdges.push_back(edge);
            continue;
        }

        const int srcRank = graph.nodes[itV->second].rank;
        const int tgtRank = graph.nodes[itW->second].rank;
        const int span = tgtRank - srcRank;

        if (span <= 1) {
            newEdges.push_back(edge);
            continue;
        }

        std::vector<std::string> chain;
        for (int r = srcRank + 1; r < tgtRank; r++) {
            std::string vid = "__virt_" + std::to_string(virtualCounter++);
            Node vnode;
            vnode.v = vid;
            vnode.width = 0;
            vnode.height = 0;
            vnode.rank = r;
            vnode.col = 0;
            vnode.isVirtual = true;
            size_t idx = graph.nodes.size();
            graph.index[vid] = idx;
            graph.nodes.push_back(vnode);
            chain.push_back(vid);
        }

        std::string prev = edge.src;
        for (const auto& vid : chain) {
            Edge seg;
            seg.src = prev;
            seg.dst = vid;
            seg.width = edge.width;
            seg.height = edge.height;
            seg.hasLabel = edge.hasLabel;
            newEdges.push_back(seg);
            prev = vid;
        }
        Edge lastSeg;
        lastSeg.src = prev;
        lastSeg.dst = edge.dst;
        lastSeg.width = edge.width;
        lastSeg.height = edge.height;
        lastSeg.hasLabel = edge.hasLabel;
        newEdges.push_back(lastSeg);

        graph.log << "  edge \"" << edge.src << "\" -> \"" << edge.dst
                  << "\" span=" << span << ": inserted " << chain.size()
                  << " virtual nodes\n";
    }

    graph.edges = std::move(newEdges);

    graph.log << "[virtual] total nodes=" << graph.nodes.size()
              << " total edges=" << graph.edges.size() << "\n";
    graph.log << "[virtual] === Virtual Node Insertion Done ===\n";
}

void collapse_virtual_nodes(Graph& graph) {
    // Remove virtual nodes and merge chain edges back into original edges.
    graph.log << "[collapse] === Collapse Virtual Nodes ===\n";

    // Build set of virtual node ids
    std::set<std::string> virtualIds;
    for (const auto& n : graph.nodes) {
        if (n.isVirtual) {
            virtualIds.insert(n.v);
        }
    }

    if (virtualIds.empty()) {
        graph.log << "[collapse] no virtual nodes, nothing to do\n";
        return;
    }

    // Build adjacency: for each node id, list of outgoing edges (index into graph.edges)
    std::unordered_map<std::string, std::vector<size_t>> outEdges;
    for (size_t i = 0; i < graph.edges.size(); i++) {
        outEdges[graph.edges[i].src].push_back(i);
    }

    // For each non-virtual source, find the original target by following
    // the chain: src -> v0 -> v1 -> ... -> tgt (non-virtual).
    // Collect all intermediate points along the way.
    // For edges that were not split (both endpoints non-virtual, not in chain),
    // keep them as-is.

    std::vector<Edge> result;

    const auto assignLabelPos = [](Edge& e) {
        const auto& pts = e.points;
        if (pts.empty()) {
            e.x = 0;
            e.y = 0;
            return;
        }
        if (pts.size() == 1) {
            e.x = pts[0].x;
            e.y = pts[0].y;
            return;
        }
        const size_t left = (pts.size() - 1) / 2;
        const size_t right = pts.size() / 2;
        e.x = (pts[left].x + pts[right].x) / 2.0;
        e.y = (pts[left].y + pts[right].y) / 2.0;
    };

    for (const auto& edge : graph.edges) {
        // Only start from non-virtual sources
        if (virtualIds.count(edge.src)) {
            continue;
        }

        Edge merged;
        merged.src = edge.src;

        // Check if this edge directly goes to a non-virtual target
        if (!virtualIds.count(edge.dst)) {
            // This edge was NOT split — keep it as-is
            merged.dst = edge.dst;
            merged.points = edge.points;
            merged.x = edge.x;
            merged.y = edge.y;
            result.push_back(merged);

            // Mark this as handled so we don't re-add it
            graph.log << "  kept edge: \"" << merged.src << "\" -> \"" << merged.dst
                      << "\" points=" << merged.points.size() << "\n";
            continue;
        }

        // This edge starts a chain: follow virtual nodes to find the real target
        std::vector<Point> points;
        std::string current = edge.src;
        std::set<std::string> visited;

        // Add points from the first segment
        for (const auto& p : edge.points) {
            points.push_back(p);
        }
        current = edge.dst;

        // Follow the chain
        while (virtualIds.count(current) && !visited.count(current)) {
            visited.insert(current);

            // Find the outgoing edge from this virtual node
            const auto& outs = outEdges[current];
            if (outs.empty()) break;

            // A virtual node should have exactly one outgoing edge
            const auto& nextEdge = graph.edges[outs[0]];
            for (const auto& p : nextEdge.points) {
                points.push_back(p);
            }
            current = nextEdge.dst;
        }

        merged.dst = current;  // The final non-virtual target
        merged.points = std::move(points);
        assignLabelPos(merged);
        result.push_back(merged);

        graph.log << "  collapsed chain: \"" << merged.src << "\" -> \"" << merged.dst
                  << "\" points=" << result.back().points.size() << "\n";
    }

    // Remove virtual nodes
    std::vector<Node> realNodes;
    for (auto& n : graph.nodes) {
        if (!n.isVirtual) {
            realNodes.push_back(std::move(n));
        }
    }
    graph.nodes = std::move(realNodes);

    // Rebuild index
    graph.index.clear();
    for (size_t i = 0; i < graph.nodes.size(); i++) {
        graph.index[graph.nodes[i].v] = i;
    }

    graph.edges = std::move(result);

    graph.log << "[collapse] total nodes=" << graph.nodes.size()
              << " total edges=" << graph.edges.size() << "\n";
    graph.log << "[collapse] === Collapse Virtual Nodes Done ===\n";
}

} // namespace dagre_fast
