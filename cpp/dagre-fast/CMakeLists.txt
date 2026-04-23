cmake_minimum_required(VERSION 3.20)
project(dagre_fast_wasm LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable(dagre_fast
    layout.cpp
    json_io.cpp
    edge.cpp
    rank.cpp
    column.cpp
    coord.cpp
    route.cpp)

set_target_properties(dagre_fast PROPERTIES OUTPUT_NAME "dagre_fast")

target_link_options(dagre_fast PRIVATE
    "-sWASM=1"
    "-sALLOW_MEMORY_GROWTH=1"
    "-sEXPORTED_FUNCTIONS=['_layout_json','_free_json']"
    "-sEXPORTED_RUNTIME_METHODS=['cwrap','UTF8ToString','stringToUTF8','lengthBytesUTF8']"
    "-sMODULARIZE=1"
    "-sEXPORT_ES6=1"
    "-sENVIRONMENT=web,worker,node")
