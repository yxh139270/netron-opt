#include "edge.h"

#include <set>
#include <unordered_map>

namespace dagre_fast {

void insert_virtual_nodes(Graph& graph) {
    graph.log << "[virtual] === Virtual Node Insertion ===\n";

    int virtualCounter = 0;
    std::vector<Edge> newEdges;

    for (auto& edge : graph.edges) {
        const auto itV = graph.index.find(edge.v);
        const auto itW = graph.index.find(edge.w);
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

        std::string prev = edge.v;
        for (const auto& vid : chain) {
            Edge seg;
            seg.v = prev;
            seg.w = vid;
            seg.width = edge.width;
            seg.height = edge.height;
            seg.hasLabel = edge.hasLabel;
            newEdges.push_back(seg);
            prev = vid;
        }
        Edge lastSeg;
        lastSeg.v = prev;
        lastSeg.w = edge.w;
        lastSeg.width = edge.width;
        lastSeg.height = edge.height;
        lastSeg.hasLabel = edge.hasLabel;
        newEdges.push_back(lastSeg);

        graph.log << "  edge \"" << edge.v << "\" -> \"" << edge.w
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
        outEdges[graph.edges[i].v].push_back(i);
    }

    // For each non-virtual source, find the original target by following
    // the chain: src -> v0 -> v1 -> ... -> tgt (non-virtual).
    // Collect all intermediate points along the way.
    // For edges that were not split (both endpoints non-virtual, not in chain),
    // keep them as-is.

    std::vector<Edge> result;

    for (const auto& edge : graph.edges) {
        // Only start from non-virtual sources
        if (virtualIds.count(edge.v)) {
            continue;
        }

        Edge merged;
        merged.v = edge.v;

        // Check if this edge directly goes to a non-virtual target
        if (!virtualIds.count(edge.w)) {
            // This edge was NOT split — keep it as-is
            merged.w = edge.w;
            merged.points = edge.points;
            result.push_back(merged);

            // Mark this as handled so we don't re-add it
            graph.log << "  kept edge: \"" << merged.v << "\" -> \"" << merged.w
                      << "\" points=" << merged.points.size() << "\n";
            continue;
        }

        // This edge starts a chain: follow virtual nodes to find the real target
        std::vector<Point> points;
        std::string current = edge.v;
        std::set<std::string> visited;

        // Add points from the first segment
        for (const auto& p : edge.points) {
            points.push_back(p);
        }
        current = edge.w;

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
            current = nextEdge.w;
        }

        merged.w = current;  // The final non-virtual target
        merged.points = std::move(points);
        result.push_back(merged);

        graph.log << "  collapsed chain: \"" << merged.v << "\" -> \"" << merged.w
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
