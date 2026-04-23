#pragma once

#include <string>

#include "layout.h"

namespace dagre_fast {

bool parse_input_json(const std::string& input, Graph& graph, std::string& error);
std::string serialize_output_json(const Graph& graph, const Meta& meta);

} // namespace dagre_fast
