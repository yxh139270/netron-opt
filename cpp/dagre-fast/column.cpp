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

// Infer merge node from a collected sub-block: take the last node of each
// pipe, then find a common direct successor.
std::string findMergeNodeFromSubBlock(
    const std::string& blockId,
    const std::map<std::string, Block>& blocks,
    const std::map<std::string, std::vector<std::string>>& succs,
    const std::map<std::string, std::vector<std::string>>& preds)
{
    const auto blockIt = blocks.find(blockId);
    if (blockIt == blocks.end() || blockIt->second.pipeNodes.empty()) {
        return "";
    }

    std::string commonSucc;
    for (const auto& pipe : blockIt->second.pipeNodes) {
        if (pipe.empty()) {
            return "";
        }

        const auto& tail = pipe.back();
        const auto succIt = succs.find(tail);
        if (succIt == succs.end() || succIt->second.empty()) {
            return "";
        }

        std::string pipeMerge;
        for (const auto& cand : succIt->second) {
            const auto predIt = preds.find(cand);
            if (predIt != preds.end() && predIt->second.size() > 1) {
                pipeMerge = cand;
                break;
            }
        }
        if (pipeMerge.empty()) {
            return "";
        }

        if (commonSucc.empty()) {
            commonSucc = pipeMerge;
            continue;
        }
        if (commonSucc != pipeMerge) {
            return "";
        }
    }

    return commonSucc;
}

// Calculate colNum for a block: range of cols spanned by its nodes,
// plus any sub-block ids that appear as nodes in this block.
int calcColNum(const Block& block, const Graph& graph, const std::map<std::string, Block>& blocks) {
    int maxCol = 0;
    for (const auto& pipe : block.pipeNodes) {
        int pipeCol = 1;
        for (const auto& nid : pipe) {
            if (blocks.count(nid)) {
                pipeCol = std::max(pipeCol, blocks.at(nid).colNum);
            }
        }
        maxCol += pipeCol;
    }

    return maxCol;
}

// Recursively collect blocks. Returns blocks keyed by their id.
// Each fan-out node gets a block per successor branch. If a branch
// itself contains a fan-out, that fan-out node gets its own blocks too.
std::string collectBlocksRecursive(
    const std::string& fanoutNodeId,
    const std::map<std::string, std::vector<std::string>>& succs,
    const std::map<std::string, std::vector<std::string>>& preds,
    std::set<std::string>& visited,
    Graph& graph,
    std::map<std::string, Block>& result,
    std::map<std::string, std::string>& nodeBlockId)
{
    const auto it = succs.find(fanoutNodeId);
    if (it == succs.end() || it->second.size() <= 1) {
        return "";
    }

    Block block;
    block.id = fanoutNodeId + ":" + std::to_string(it->second.size());
    for (size_t i = 0; i < it->second.size(); i++) {
        const auto& succId = it->second[i];
        if (visited.count(succId)) {
            continue;
        }

        block.pipeNodes.push_back({});
        auto& pipe = block.pipeNodes.back();
        std::string current = succId;

        while (true) {
            if (visited.count(current)) {
                break;
            }
            visited.insert(current);
            pipe.push_back(current);

            const auto it = succs.find(current);
            if (it == succs.end() || it->second.empty()) {
                break;
            }
            if (it->second.size() > 1) {
                // Fan-out: stop here, the fan-out node itself is in chain,
                // its successors will be handled as sub-blocks.
                const auto curBlockId = collectBlocksRecursive(current, succs, preds, visited, graph, result, nodeBlockId);
                if (!curBlockId.empty()) {
                    pipe.push_back(curBlockId);
                }
                const auto mergeNode = findMergeNodeFromSubBlock(curBlockId, result, succs, preds);
                if (mergeNode.empty()) {
                    break;
                }
                current = mergeNode;
                continue;
            }

            const std::string& next = it->second[0];

            // Stop at merge points
            const auto predIt = preds.find(next);
            if (predIt != preds.end() && predIt->second.size() > 1) {
                break;
            }

            current = next;
        }
    }
    block.colNum = calcColNum(block, graph, result);

    graph.log << "  block id=" << block.id << " colNum=" << block.colNum
              << " pipes=" << block.pipeNodes.size() << " [";
    for (size_t i = 0; i < block.pipeNodes.size(); i++) {
        if (i > 0) graph.log << ";";
        graph.log << "pipe" << i << "=";
        for (size_t j = 0; j < block.pipeNodes[i].size(); j++) {
            if (j > 0) graph.log << ",";
            graph.log << block.pipeNodes[i][j];
        }
    }
    graph.log << "]\n";

    result[block.id] = std::move(block);
    // Map each node in this block's pipes to the block id
    for (const auto& entry : result[block.id].pipeNodes) {
        for (const auto& nid : entry) {
            nodeBlockId[nid] = block.id;
        }
    }
    return block.id;
}

} // anonymous namespace

std::map<std::string, Block> collectBlocks(Graph& graph, std::map<std::string, std::string>& nodeBlockId) {
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
        collectBlocksRecursive(nodeId, succs, preds, visited, graph, result, nodeBlockId);
    }

    graph.log << "[blocks] total blocks=" << result.size() << "\n";
    graph.log << "[blocks] === Collect Blocks Done ===\n";

    return result;
}

} // namespace dagre_fast
