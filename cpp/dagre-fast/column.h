#pragma once

#include "layout.h"
#include <map>
#include <string>
#include <vector>

namespace dagre_fast {

struct Block {
    std::string id;
    std::vector<std::vector<std::string>> pipeNodes;
    int colNum = 0;
};

void assign_column(Graph& graph);

std::map<std::string, Block> collectBlocks(Graph& graph);

} // namespace dagre_fast
