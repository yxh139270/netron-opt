#include "column.h"

#include <algorithm>
#include <cmath>
#include <functional>
#include <limits>
#include <map>
#include <set>
#include <unordered_set>
#include <vector>

namespace dagre_fast {

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
        if (pipe.empty()) return "";
        const auto& tail = pipe.back();
        const auto succIt = succs.find(tail);
        if (succIt == succs.end() || succIt->second.empty()) return "";
        std::string pipeMerge;
        for (const auto& cand : succIt->second) {
            const auto predIt = preds.find(cand);
            if (predIt != preds.end() && predIt->second.size() > 1) {
                pipeMerge = cand;
                break;
            }
        }
        if (pipeMerge.empty()) return "";
        if (commonSucc.empty()) { commonSucc = pipeMerge; continue; }
        if (commonSucc != pipeMerge) return "";
    }
    return commonSucc;
}

int calcColNum(const Block& block, const std::map<std::string, Block>& blocks) {
    int total = 0;
    for (const auto& pipe : block.pipeNodes) {
        int pipeCol = 1;
        for (const auto& nid : pipe) {
            if (blocks.count(nid)) {
                pipeCol = std::max(pipeCol, blocks.at(nid).colNum);
            }
        }
        total += pipeCol;
    }
    return total;
}

std::string collectBlocksRecursive(
    const std::string& fanoutNodeId,
    const std::map<std::string, std::vector<std::string>>& succs,
    const std::map<std::string, std::vector<std::string>>& preds,
    std::set<std::string>& visited,
    Graph& graph,
    std::map<std::string, Block>& result,
    std::map<std::string, std::string>& nodeBlockId)
{
    if (fanoutNodeId.empty()) {
        return "";
    }
    const auto it = succs.find(fanoutNodeId);
    if (it == succs.end() || it->second.size() <= 1) return "";

    Block block;
    block.id = fanoutNodeId + ":" + std::to_string(it->second.size());
    block.rankRange = { INT32_MAX, 0 };

    for (size_t i = 0; i < it->second.size(); i++) {
        const auto& succId = it->second[i];
        if (succId.empty()) continue;
        if (visited.count(succId)) continue;

        block.pipeNodes.push_back({});
        auto& pipe = block.pipeNodes.back();
        std::string current = succId;

        while (true) {
            if (visited.count(current)) break;
            visited.insert(current);
            pipe.push_back(current);
            auto nidx = graph.index.find(current);
            if (nidx != graph.index.end()) {
                block.rankRange.first = std::min(block.rankRange.first, graph.nodes[nidx->second].rank);
                block.rankRange.second = std::max(block.rankRange.second, graph.nodes[nidx->second].rank);
            }

            const auto sit = succs.find(current);
            if (sit == succs.end() || sit->second.empty()) break;
            if (sit->second.size() > 1) {
                const auto curBlockId = collectBlocksRecursive(current, succs, preds, visited, graph, result, nodeBlockId);
                if (!curBlockId.empty()) {
                    pipe.push_back(curBlockId);
                    // Expand rank range to include child block
                    const auto& child = result[curBlockId];
                    block.rankRange.first = std::min(block.rankRange.first, child.rankRange.first);
                    block.rankRange.second = std::max(block.rankRange.second, child.rankRange.second);
                }
                const auto mergeNode = findMergeNodeFromSubBlock(curBlockId, result, succs, preds);
                if (mergeNode.empty()) break;
                current = mergeNode;
                continue;
            }

            const std::string& next = sit->second[0];
            const auto predIt = preds.find(next);
            if (predIt != preds.end() && predIt->second.size() > 1) break;
            current = next;
        }
    }

    block.colNum = calcColNum(block, result);
    if (block.pipeNodes.empty() || block.colNum <= 0) {
        return "";
    }
    block.colRange = { 0.0, static_cast<double>(block.colNum) };

    graph.log << "  block id=" << block.id << " colNum=" << block.colNum
              << " pipes=" << block.pipeNodes.size()
              << " rank=[" << block.rankRange.first << "," << block.rankRange.second << "] [";
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
    for (const auto& entry : result[block.id].pipeNodes) {
        for (const auto& nid : entry) {
            if (nid.empty()) continue;
            nodeBlockId[nid] = block.id;
        }
    }
    return block.id;
}

void shiftBlockRange(const std::string& blockId, double offset,
                     std::map<std::string, Block>& blocks) {
    auto& block = blocks[blockId];
    block.colRange.first += offset;
    block.colRange.second += offset;
    for (const auto& pipe : block.pipeNodes) {
        for (const auto& item : pipe) {
            if (blocks.count(item)) {
                shiftBlockRange(item, offset, blocks);
            }
        }
    }
}

bool ranksOverlap(const std::pair<int, int>& a, const std::pair<int, int>& b) {
    return a.first < b.second && b.first < a.second;
}

bool colsOverlap(const std::pair<double, double>& a, const std::pair<double, double>& b) {
    return a.first < b.second && b.first < a.second;
}

double blockWidth(const Block& block) {
    return block.colRange.second - block.colRange.first;
}

double blockCenter(const Block& block) {
    const double span = std::max(0, block.colNum - 1);
    return block.colRange.first + span / 2.0;
}

void collectConcreteNodesRecursive(const std::string& blockId,
                                   const std::map<std::string, Block>& blocks,
                                   std::unordered_set<std::string>& out) {
    const auto it = blocks.find(blockId);
    if (it == blocks.end()) {
        return;
    }
    for (const auto& pipe : it->second.pipeNodes) {
        for (const auto& item : pipe) {
            if (blocks.count(item)) {
                collectConcreteNodesRecursive(item, blocks, out);
            } else {
                out.insert(item);
            }
        }
    }
}

std::vector<std::vector<std::string>> buildRootLayersByRankOverlap(
    const std::vector<std::string>& rootBlocks,
    const std::map<std::string, Block>& blocks) {
    std::vector<std::string> sorted = rootBlocks;
    std::sort(sorted.begin(), sorted.end(), [&](const std::string& a, const std::string& b) {
        const auto& ra = blocks.at(a).rankRange;
        const auto& rb = blocks.at(b).rankRange;
        if (ra.first != rb.first) {
            return ra.first < rb.first;
        }
        if (ra.second != rb.second) {
            return ra.second < rb.second;
        }
        return a < b;
    });

    std::vector<std::vector<std::string>> layers;
    int activeEnd = std::numeric_limits<int>::min();
    for (const auto& id : sorted) {
        const auto& rr = blocks.at(id).rankRange;
        if (layers.empty() || rr.first > activeEnd) {
            layers.push_back({ id });
            activeEnd = rr.second;
        } else {
            layers.back().push_back(id);
            activeEnd = std::max(activeEnd, rr.second);
        }
    }
    return layers;
}

void placeLayerCompact(
    const std::vector<std::string>& layer,
    const std::map<std::string, double>& desiredCenters,
    std::map<std::string, Block>& blocks) {
    if (layer.empty()) {
        return;
    }
    std::vector<std::string> ordered = layer;
    std::sort(ordered.begin(), ordered.end(), [&](const std::string& a, const std::string& b) {
        const auto ita = desiredCenters.find(a);
        const auto itb = desiredCenters.find(b);
        const bool hasA = ita != desiredCenters.end();
        const bool hasB = itb != desiredCenters.end();
        if (hasA && hasB && std::abs(ita->second - itb->second) > 1e-9) {
            return ita->second < itb->second;
        }
        if (hasA != hasB) {
            return hasA;
        }
        return a < b;
    });

    double cursor = 0.0;
    for (const auto& id : ordered) {
        const double shift = cursor - blocks[id].colRange.first;
        if (std::abs(shift) > 1e-12) {
            shiftBlockRange(id, shift, blocks);
        }
        cursor = blocks[id].colRange.second;
    }

    if (desiredCenters.empty()) {
        return;
    }
    double targetSum = 0.0;
    double currentSum = 0.0;
    int count = 0;
    for (const auto& id : ordered) {
        const auto it = desiredCenters.find(id);
        if (it == desiredCenters.end()) {
            continue;
        }
        targetSum += it->second;
        currentSum += blockCenter(blocks[id]);
        count++;
    }
    if (count == 0) {
        return;
    }
    const double offset = (targetSum / static_cast<double>(count)) -
                          (currentSum / static_cast<double>(count));
    if (std::abs(offset) <= 1e-12) {
        return;
    }
    for (const auto& id : ordered) {
        shiftBlockRange(id, offset, blocks);
    }
}

} // anonymous namespace

// ---------------------------------------------------------------------------

void assign_column(Graph& graph) {
    graph.log << "[column] === Column Assignment ===\n";
    graph.log << "[column] mode=fanout-average-v3-20260427\n";

    if (graph.nodes.empty()) {
        graph.log << "[column] empty graph\n";
        graph.log << "[column] === Column Assignment Done ===\n";
        return;
    }

    const auto succs = buildSuccessors(graph);
    const auto preds = buildPredecessors(graph);

    int maxRank = 0;
    for (const auto& node : graph.nodes) {
        maxRank = std::max(maxRank, node.rank);
    }

    std::vector<std::vector<size_t>> rankNodes(static_cast<size_t>(maxRank + 1));
    for (size_t i = 0; i < graph.nodes.size(); i++) {
        const int rank = graph.nodes[i].rank;
        if (rank >= 0 && rank <= maxRank) {
            rankNodes[static_cast<size_t>(rank)].push_back(i);
        }
    }

    for (auto& ids : rankNodes) {
        std::sort(ids.begin(), ids.end(), [&](size_t a, size_t b) {
            return graph.nodes[a].v < graph.nodes[b].v;
        });
    }

    std::vector<size_t> allIds(graph.nodes.size());
    for (size_t i = 0; i < graph.nodes.size(); i++) {
        allIds[i] = i;
    }
    std::sort(allIds.begin(), allIds.end(), [&](size_t a, size_t b) {
        return graph.nodes[a].v < graph.nodes[b].v;
    });

    std::vector<size_t> sortedNodes;
    sortedNodes.reserve(graph.nodes.size());
    std::unordered_set<std::string> visited;

    std::function<void(size_t)> dfs = [&](size_t idx) {
        const auto& id = graph.nodes[idx].v;
        if (visited.count(id)) {
            return;
        }
        visited.insert(id);
        sortedNodes.push_back(idx);

        const auto sit = succs.find(id);
        if (sit == succs.end()) {
            return;
        }
        for (const auto& next : sit->second) {
            const auto it = graph.index.find(next);
            if (it == graph.index.end()) {
                continue;
            }
            dfs(it->second);
        }
    };

    for (const auto& id : graph.inputNodes) {
        const auto it = graph.index.find(id);
        if (it == graph.index.end()) {
            continue;
        }
        dfs(it->second);
    }
    for (const auto idx : rankNodes[0]) {
        dfs(idx);
    }
    for (const auto idx : allIds) {
        dfs(idx);
    }

    std::vector<char> hasCol(graph.nodes.size(), 0);
    int sourceCol = 0;
    for (const auto idx : sortedNodes) {
        if (graph.nodes[idx].rank == 0) {
            graph.nodes[idx].col = static_cast<double>(sourceCol++);
            hasCol[idx] = 1;
        }
    }
    for (size_t i = 0; i < graph.nodes.size(); i++) {
        if (!hasCol[i]) {
            graph.nodes[i].col = 0.0;
        }
    }

    auto resolveRankCollisions = [&](int rank) {
        if (rank < 0 || rank > maxRank) {
            return;
        }
        auto& ids = rankNodes[static_cast<size_t>(rank)];
        if (ids.size() <= 1) {
            return;
        }
        std::sort(ids.begin(), ids.end(), [&](size_t a, size_t b) {
            if (std::abs(graph.nodes[a].col - graph.nodes[b].col) <= 1e-9) {
                return graph.nodes[a].v < graph.nodes[b].v;
            }
            return graph.nodes[a].col < graph.nodes[b].col;
        });

        std::vector<double> original(ids.size());
        std::vector<double> placed(ids.size());
        for (size_t i = 0; i < ids.size(); i++) {
            original[i] = graph.nodes[ids[i]].col;
            placed[i] = original[i];
        }

        for (size_t i = 1; i < placed.size(); i++) {
            placed[i] = std::max(placed[i], placed[i - 1] + 1.0);
        }

        double sumOriginal = 0.0;
        double sumPlaced = 0.0;
        for (size_t i = 0; i < placed.size(); i++) {
            sumOriginal += original[i];
            sumPlaced += placed[i];
        }
        const double shift = (sumOriginal - sumPlaced) / static_cast<double>(placed.size());
        for (size_t i = 0; i < ids.size(); i++) {
            graph.nodes[ids[i]].col = placed[i] + shift;
        }
    };

    for (int rank = 0; rank < maxRank; rank++) {
        std::map<std::string, std::vector<double>> proposals;

        for (const auto idx : rankNodes[static_cast<size_t>(rank)]) {
            const auto& node = graph.nodes[idx];
            const auto sit = succs.find(node.v);
            if (sit == succs.end() || sit->second.empty()) {
                continue;
            }

            const auto& outEdges = sit->second;
            const int k = static_cast<int>(outEdges.size());

            for (int i = 0; i < k; i++) {
                const std::string& w = outEdges[static_cast<size_t>(i)];
                const auto it = graph.index.find(w);
                if (it == graph.index.end()) {
                    continue;
                }

                double desired = (k == 1)
                    ? node.col
                    : node.col + (static_cast<double>(i) - (k - 1) / 2.0);

                proposals[w].push_back(desired);
            }
        }

        const int nextRank = rank + 1;
        for (const auto idx : rankNodes[static_cast<size_t>(nextRank)]) {
            auto& node = graph.nodes[idx];
            const auto fit = proposals.find(node.v);

            const auto pit = preds.find(node.v);
            const int indeg = (pit == preds.end()) ? 0 : static_cast<int>(pit->second.size());

            if (indeg > 1) {
                double sum = 0.0;
                int count = 0;
                for (const auto& p : pit->second) {
                    const auto it = graph.index.find(p);
                    if (it == graph.index.end()) {
                        continue;
                    }
                    sum += graph.nodes[it->second].col;
                    count++;
                }
                if (count > 0) {
                    node.col = sum / static_cast<double>(count);
                }
                continue;
            }

            if (fit != proposals.end() && !fit->second.empty()) {
                double sum = 0.0;
                for (double value : fit->second) {
                    sum += value;
                }
                node.col = sum / static_cast<double>(fit->second.size());
            } else if (indeg == 1) {
                const auto ip = graph.index.find(pit->second[0]);
                if (ip != graph.index.end()) {
                    node.col = graph.nodes[ip->second].col;
                }
            }
        }

        resolveRankCollisions(nextRank);
    }

    // Post-pass for lantern style: collect each virtual chain, then set all
    // virtual nodes in that chain to the maximum col on that chain.
    std::unordered_set<std::string> virtualVisited;
    for (const auto& node : graph.nodes) {
        if (!node.isVirtual || virtualVisited.count(node.v)) {
            continue;
        }

        std::string head = node.v;
        while (true) {
            const auto pit = preds.find(head);
            if (pit == preds.end() || pit->second.size() != 1) {
                break;
            }
            const auto ip = graph.index.find(pit->second[0]);
            if (ip == graph.index.end() || !graph.nodes[ip->second].isVirtual) {
                break;
            }
            head = pit->second[0];
        }

        std::vector<size_t> chain;
        std::string cur = head;
        while (true) {
            if (virtualVisited.count(cur)) {
                break;
            }
            const auto ic = graph.index.find(cur);
            if (ic == graph.index.end() || !graph.nodes[ic->second].isVirtual) {
                break;
            }

            virtualVisited.insert(cur);
            chain.push_back(ic->second);

            const auto sit = succs.find(cur);
            if (sit == succs.end() || sit->second.size() != 1) {
                break;
            }
            const auto inext = graph.index.find(sit->second[0]);
            if (inext == graph.index.end() || !graph.nodes[inext->second].isVirtual) {
                break;
            }
            cur = sit->second[0];
        }

        if (chain.empty()) {
            continue;
        }
        double maxCol = graph.nodes[chain[0]].col;
        for (const auto idx : chain) {
            maxCol = std::max(maxCol, graph.nodes[idx].col);
        }
        for (const auto idx : chain) {
            graph.nodes[idx].col = maxCol;
        }
    }

    graph.log << "[column] final placement by rank:\n";
    for (int rank = 0; rank <= maxRank; rank++) {
        auto ids = rankNodes[static_cast<size_t>(rank)];
        std::sort(ids.begin(), ids.end(), [&](size_t a, size_t b) {
            if (std::abs(graph.nodes[a].col - graph.nodes[b].col) <= 1e-9) {
                return graph.nodes[a].v < graph.nodes[b].v;
            }
            return graph.nodes[a].col < graph.nodes[b].col;
        });
        graph.log << "  rank=" << rank << ": ";
        for (size_t i = 0; i < ids.size(); i++) {
            if (i > 0) {
                graph.log << ", ";
            }
            graph.log << graph.nodes[ids[i]].v << "@" << graph.nodes[ids[i]].col;
        }
        graph.log << "\n";
    }
    graph.log << "[column] === Column Assignment Done ===\n";
}

// ---------------------------------------------------------------------------

std::map<std::string, Block> collectBlocks(Graph& graph, std::map<std::string, std::string>& nodeBlockId) {
    graph.log << "[blocks] === Collect Blocks ===\n";
    const auto succs = buildSuccessors(graph);
    const auto preds = buildPredecessors(graph);

    std::map<std::string, Block> result;
    std::set<std::string> visited;

    for (const auto& [nodeId, successors] : succs) {
        if (nodeId.empty()) continue;
        if (successors.size() <= 1) continue;
        collectBlocksRecursive(nodeId, succs, preds, visited, graph, result, nodeBlockId);
    }

    result.erase("");
    nodeBlockId.erase("");

    graph.log << "[blocks] total blocks=" << result.size() << "\n";
    graph.log << "[blocks] === Collect Blocks Done ===\n";
    return result;
}

} // namespace dagre_fast
