#pragma once

#include "layout.h"
#include <map>
#include <string>
#include <utility>
#include <vector>

namespace dagre_fast {

struct Block {
    std::string id;
    std::vector<std::vector<std::string>> pipeNodes;
    int colNum = 0;
    std::pair<double, double> colRange;
    std::pair<int, int> rankRange;
};

void assign_column(Graph& graph);

std::map<std::string, Block> collectBlocks(Graph& graph, std::map<std::string, std::string>& nodeBlockId);

} // namespace dagre_fast
