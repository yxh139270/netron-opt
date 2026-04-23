#pragma once

#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

namespace dagre_fast {

struct Point {
    double x = 0;
    double y = 0;
};

struct Node {
    std::string v;
    double width = 0;
    double height = 0;
    int rank = 0;
    double col = 0;
    double x = 0;
    double y = 0;
};

struct Edge {
    std::string v;
    std::string w;
    int minlen = 1;
    std::vector<Point> points;
};

struct LayoutOptions {
    double nodesep = 20;
    double ranksep = 20;
    std::string rankdir = "TB";
};

struct Graph {
    std::vector<Node> nodes;
    std::vector<Edge> edges;
    LayoutOptions options;
    std::unordered_map<std::string, size_t> index;
    std::ostringstream log;
};

struct Meta {
    bool ok = true;
    std::string stage_ms;
    std::string log;
};

bool run_layout(Graph& graph, Meta& meta);

} // namespace dagre_fast

extern "C" {
const char* layout_json(const char* input);
void free_json(const char* p);
}
