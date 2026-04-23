#include "column.h"

#include <algorithm>
#include <limits>
#include <map>
#include <set>
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

namespace {

std::map<std::string, std::vector<std::string>> buildSuccessors(const Graph& graph) {
    std::map<std::string, std::vector<std::string>> succs;
    for (const auto& edge : graph.edges) {
        succs[edge.v].push_back(edge.w);
    }
    return succs;
}

std::map<std::string, std::vector<std::string>> buildPredecessors(const Graph& graph) {
    std::map<std::string, std::vector<std::string>> preds;
    for (const auto& edge : graph.edges) {
        preds[edge.w].push_back(edge.v);
    }
    return preds;
}

// Collect a single branch: follow single-successor chain starting from startId.
// Stop at: fan-out (multiple successors), merge (multiple predecessors), visited node.
// Returns node ids in the chain (including startId).
std::vector<std::string> collectBranch(
    const std::string& startId,
    const std::map<std::string, std::vector<std::string>>& succs,
    const std::map<std::string, std::vector<std::string>>& preds,
    std::set<std::string>& visited)
{
    std::vector<std::string> chain;
    std::string current = startId;

    while (true) {
        if (visited.count(current)) {
            break;
        }
        visited.insert(current);
        chain.push_back(current);

        const auto it = succs.find(current);
        if (it == succs.end() || it->second.empty()) {
            break;
        }
        if (it->second.size() > 1) {
            // Fan-out: stop here, the fan-out node itself is in chain,
            // its successors will be handled as sub-blocks.
            break;
        }

        const std::string& next = it->second[0];

        // Stop at merge points
        const auto predIt = preds.find(next);
        if (predIt != preds.end() && predIt->second.size() > 1) {
            break;
        }

        current = next;
    }

    return chain;
}

// Calculate colNum for a block: range of cols spanned by its nodes,
// plus any sub-block ids that appear as nodes in this block.
int calcColNum(const Block& block, const Graph& graph) {
    double minCol = std::numeric_limits<double>::max();
    double maxCol = std::numeric_limits<double>::lowest();

    for (const auto& nid : block.nodes) {
        const auto idx = graph.index.find(nid);
        if (idx != graph.index.end()) {
            const double c = graph.nodes[idx->second].col;
            minCol = std::min(minCol, c);
            maxCol = std::max(maxCol, c);
        }
    }

    return (minCol <= maxCol) ? static_cast<int>(maxCol - minCol + 1) : 1;
}

// Recursively collect blocks. Returns blocks keyed by their id.
// Each fan-out node gets a block per successor branch. If a branch
// itself contains a fan-out, that fan-out node gets its own blocks too.
void collectBlocksRecursive(
    const std::string& fanoutNodeId,
    const std::map<std::string, std::vector<std::string>>& succs,
    const std::map<std::string, std::vector<std::string>>& preds,
    std::set<std::string>& visited,
    Graph& graph,
    std::map<std::string, Block>& result)
{
    const auto it = succs.find(fanoutNodeId);
    if (it == succs.end() || it->second.size() <= 1) {
        return;
    }

    for (size_t i = 0; i < it->second.size(); i++) {
        const auto& succId = it->second[i];
        if (visited.count(succId)) {
            continue;
        }

        Block block;
        block.id = fanoutNodeId + ":" + std::to_string(i);
        block.nodes = collectBranch(succId, succs, preds, visited);

        for (const auto& nid : block.nodes) {
            const auto succIt = succs.find(nid);
            if (succIt != succs.end() && succIt->second.size() > 1) {
                collectBlocksRecursive(nid, succs, preds, visited, graph, result);
            }
        }

        block.colNum = calcColNum(block, graph);

        graph.log << "  block id=" << block.id << " colNum=" << block.colNum
                  << " nodes=" << block.nodes.size() << " [";
        for (size_t j = 0; j < block.nodes.size(); j++) {
            if (j > 0) graph.log << ",";
            graph.log << block.nodes[j];
        }
        graph.log << "]\n";

        result[block.id] = std::move(block);
    }
}

} // anonymous namespace

std::map<std::string, Block> collectBlocks(Graph& graph) {
    graph.log << "[blocks] === Collect Blocks ===\n";

    const auto succs = buildSuccessors(graph);
    const auto preds = buildPredecessors(graph);

    std::map<std::string, Block> result;
    std::set<std::string> visited;

    // Find all fan-out nodes and collect blocks
    for (const auto& [nodeId, successors] : succs) {
        if (successors.size() <= 1) {
            continue;
        }
        collectBlocksRecursive(nodeId, succs, preds, visited, graph, result);
    }

    graph.log << "[blocks] total blocks=" << result.size() << "\n";
    graph.log << "[blocks] === Collect Blocks Done ===\n";

    return result;
}

} // namespace dagre_fast
