#include "json_io.h"

#include <cctype>
#include <sstream>

namespace dagre_fast {

namespace {

struct JsonScanner {
    const std::string& src;
    size_t pos = 0;

    explicit JsonScanner(const std::string& text)
        : src(text) {
    }

    void skip_ws() {
        while (pos < src.size() && std::isspace(static_cast<unsigned char>(src[pos]))) {
            pos++;
        }
    }

    bool consume(char c) {
        skip_ws();
        if (pos < src.size() && src[pos] == c) {
            pos++;
            return true;
        }
        return false;
    }

    bool peek(char c) {
        skip_ws();
        return pos < src.size() && src[pos] == c;
    }

    bool parse_string(std::string& out) {
        skip_ws();
        if (pos >= src.size() || src[pos] != '"') {
            return false;
        }
        pos++;
        out.clear();
        while (pos < src.size()) {
            char ch = src[pos++];
            if (ch == '\\') {
                if (pos >= src.size()) {
                    return false;
                }
                char escaped = src[pos++];
                switch (escaped) {
                    case '"': out.push_back('"'); break;
                    case '\\': out.push_back('\\'); break;
                    case '/': out.push_back('/'); break;
                    case 'b': out.push_back('\b'); break;
                    case 'f': out.push_back('\f'); break;
                    case 'n': out.push_back('\n'); break;
                    case 'r': out.push_back('\r'); break;
                    case 't': out.push_back('\t'); break;
                    default: return false;
                }
            } else if (ch == '"') {
                return true;
            } else {
                out.push_back(ch);
            }
        }
        return false;
    }

    bool parse_number(double& out) {
        skip_ws();
        if (pos >= src.size()) {
            return false;
        }
        const size_t start = pos;
        if (src[pos] == '-') {
            pos++;
        }
        bool has_digit = false;
        while (pos < src.size() && std::isdigit(static_cast<unsigned char>(src[pos]))) {
            has_digit = true;
            pos++;
        }
        if (pos < src.size() && src[pos] == '.') {
            pos++;
            while (pos < src.size() && std::isdigit(static_cast<unsigned char>(src[pos]))) {
                has_digit = true;
                pos++;
            }
        }
        if (!has_digit) {
            pos = start;
            return false;
        }
        out = std::stod(src.substr(start, pos - start));
        return true;
    }

    bool skip_value() {
        skip_ws();
        if (pos >= src.size()) {
            return false;
        }
        char ch = src[pos];
        if (ch == '{') {
            pos++;
            skip_ws();
            if (consume('}')) {
                return true;
            }
            while (true) {
                std::string key;
                if (!parse_string(key)) {
                    return false;
                }
                if (!consume(':')) {
                    return false;
                }
                if (!skip_value()) {
                    return false;
                }
                if (consume('}')) {
                    return true;
                }
                if (!consume(',')) {
                    return false;
                }
            }
        }
        if (ch == '[') {
            pos++;
            skip_ws();
            if (consume(']')) {
                return true;
            }
            while (true) {
                if (!skip_value()) {
                    return false;
                }
                if (consume(']')) {
                    return true;
                }
                if (!consume(',')) {
                    return false;
                }
            }
        }
        if (ch == '"') {
            std::string tmp;
            return parse_string(tmp);
        }
        if (std::isdigit(static_cast<unsigned char>(ch)) || ch == '-') {
            double number = 0;
            return parse_number(number);
        }
        if (src.compare(pos, 4, "true") == 0) {
            pos += 4;
            return true;
        }
        if (src.compare(pos, 5, "false") == 0) {
            pos += 5;
            return true;
        }
        if (src.compare(pos, 4, "null") == 0) {
            pos += 4;
            return true;
        }
        return false;
    }
};

std::string escape_json(const std::string& value) {
    std::string out;
    out.reserve(value.size() + 8);
    for (char ch : value) {
        switch (ch) {
            case '\\': out += "\\\\"; break;
            case '"': out += "\\\""; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default: out.push_back(ch); break;
        }
    }
    return out;
}

bool parse_node_object(JsonScanner& s, Node& node) {
    if (!s.consume('{')) {
        return false;
    }
    while (!s.consume('}')) {
        std::string key;
        if (!s.parse_string(key) || !s.consume(':')) {
            return false;
        }
        if (key == "v") {
            if (!s.parse_string(node.v)) {
                return false;
            }
        } else if (key == "width") {
            if (!s.parse_number(node.width)) {
                return false;
            }
        } else if (key == "height") {
            if (!s.parse_number(node.height)) {
                return false;
            }
        } else {
            if (!s.skip_value()) {
                return false;
            }
        }
        if (!s.peek('}')) {
            if (!s.consume(',')) {
                return false;
            }
        }
    }
    return !node.v.empty();
}

bool parse_edge_object(JsonScanner& s, Edge& edge) {
    if (!s.consume('{')) {
        return false;
    }
    while (!s.consume('}')) {
        std::string key;
        if (!s.parse_string(key) || !s.consume(':')) {
            return false;
        }
        if (key == "v") {
            if (!s.parse_string(edge.v)) {
                return false;
            }
        } else if (key == "w") {
            if (!s.parse_string(edge.w)) {
                return false;
            }
        } else {
            if (!s.skip_value()) {
                return false;
            }
        }
        if (!s.peek('}')) {
            if (!s.consume(',')) {
                return false;
            }
        }
    }
    return !edge.v.empty() && !edge.w.empty();
}

bool parse_layout_object(JsonScanner& s, LayoutOptions& options) {
    if (!s.consume('{')) {
        return false;
    }
    while (!s.consume('}')) {
        std::string key;
        if (!s.parse_string(key) || !s.consume(':')) {
            return false;
        }
        if (key == "nodesep") {
            if (!s.parse_number(options.nodesep)) {
                return false;
            }
        } else if (key == "ranksep") {
            if (!s.parse_number(options.ranksep)) {
                return false;
            }
        } else if (key == "rankdir") {
            if (!s.parse_string(options.rankdir)) {
                return false;
            }
        } else {
            if (!s.skip_value()) {
                return false;
            }
        }
        if (!s.peek('}')) {
            if (!s.consume(',')) {
                return false;
            }
        }
    }
    return true;
}

} // namespace

bool parse_input_json(const std::string& input, Graph& graph, std::string& error) {
    JsonScanner s(input);
    if (!s.consume('{')) {
        error = "input should be an object";
        return false;
    }

    while (!s.consume('}')) {
        std::string key;
        if (!s.parse_string(key) || !s.consume(':')) {
            error = "invalid json key/value";
            return false;
        }

        if (key == "nodes") {
            if (!s.consume('[')) {
                error = "nodes should be an array";
                return false;
            }
            size_t idx = 0;
            while (!s.consume(']')) {
                Node node;
                if (!parse_node_object(s, node)) {
                    error = "invalid node object";
                    return false;
                }
                graph.index[node.v] = idx++;
                graph.nodes.push_back(node);
                if (!s.peek(']') && !s.consume(',')) {
                    error = "invalid nodes array separator";
                    return false;
                }
            }
        } else if (key == "edges") {
            if (!s.consume('[')) {
                error = "edges should be an array";
                return false;
            }
            while (!s.consume(']')) {
                Edge edge;
                if (!parse_edge_object(s, edge)) {
                    error = "invalid edge object";
                    return false;
                }
                graph.edges.push_back(edge);
                if (!s.peek(']') && !s.consume(',')) {
                    error = "invalid edges array separator";
                    return false;
                }
            }
        } else if (key == "layout") {
            if (!parse_layout_object(s, graph.options)) {
                error = "invalid layout object";
                return false;
            }
        } else {
            if (!s.skip_value()) {
                error = "invalid extra field";
                return false;
            }
        }

        if (!s.peek('}') && !s.consume(',')) {
            error = "invalid object separator";
            return false;
        }
    }

    return true;
}

std::string serialize_output_json(const Graph& graph, const Meta& meta) {
    std::ostringstream out;
    out << "{\"nodes\":[";
    for (size_t i = 0; i < graph.nodes.size(); i++) {
        const auto& n = graph.nodes[i];
        if (i > 0) {
            out << ',';
        }
        out << "{\"v\":\"" << escape_json(n.v) << "\",\"width\":" << n.width
            << ",\"height\":" << n.height << ",\"x\":" << n.x << ",\"y\":" << n.y << "}";
    }
    out << "],\"edges\":[";
    for (size_t i = 0; i < graph.edges.size(); i++) {
        const auto& e = graph.edges[i];
        if (i > 0) {
            out << ',';
        }
        out << "{\"v\":\"" << escape_json(e.v) << "\",\"w\":\"" << escape_json(e.w) << "\",\"points\":[";
        for (size_t j = 0; j < e.points.size(); j++) {
            if (j > 0) {
                out << ',';
            }
            out << "{\"x\":" << e.points[j].x << ",\"y\":" << e.points[j].y << "}";
        }
        out << "]}";
    }
    out << "],\"meta\":{\"ok\":" << (meta.ok ? "true" : "false")
        << ",\"stage_ms\":\"" << escape_json(meta.stage_ms)
        << "\",\"log\":\"" << escape_json(meta.log) << "\"}}";
    return out.str();
}

} // namespace dagre_fast
