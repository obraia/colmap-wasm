# colmap-wasm PoC: only the COLMAP parts needed by geometric verification and the
# global mapper, compiled with emscripten (single-threaded, no OpenMP/OIIO/faiss).
cmake_minimum_required(VERSION 3.20)
project(colmap_wasm CXX C)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(COLMAP_SRC "" CACHE PATH "COLMAP source root")
set(PREFIX "" CACHE PATH "wasm dependency prefix")
set(BOOST_INC "" CACHE PATH "directory containing boost/")
set(VERSION_CC "" CACHE FILEPATH "version.cc generated from COLMAP's version.cc.in")

find_package(Eigen3 REQUIRED NO_MODULE)
find_package(glog REQUIRED)
find_package(Ceres REQUIRED)
find_package(PoseLib REQUIRED)

set(C ${COLMAP_SRC}/src/colmap)
file(GLOB SRCS
  ${C}/util/*.cc ${C}/math/*.cc ${C}/geometry/*.cc ${C}/sensor/*.cc ${C}/scene/*.cc
  ${C}/optim/*.cc ${C}/estimators/*.cc ${C}/estimators/solvers/*.cc
  ${C}/estimators/cost_functions/*.cc ${C}/sfm/*.cc ${C}/feature/*.cc)
list(FILTER SRCS EXCLUDE REGEX "_test\\.cc$|/util/(cuda|cudacc|opengl_utils|oiio_utils|testing|gtest_main)\\.cc$|caspar|/sensor/bitmap\\.cc$|/scene/synthetic\\.cc$|/math/graph_cut\\.cc$|/estimators/coordinate_frame\\.cc$|_benchmark\\.cc$|/feature/(index|loma|onnx_matchers|onnx_utils)\\.cc$")
list(APPEND SRCS ${C}/controllers/global_pipeline.cc
     ${VERSION_CC} ${CMAKE_CURRENT_SOURCE_DIR}/stubs.cc)

# VLFeat (SIFT), scalar code paths only
set(V ${COLMAP_SRC}/src/thirdparty/VLFeat)
add_library(colmap_vlfeat STATIC ${V}/generic.c ${V}/host.c ${V}/imopv.c ${V}/mathop.c ${V}/random.c
  ${V}/scalespace.c ${V}/sift.c ${V}/covdet.c)
target_compile_definitions(colmap_vlfeat PUBLIC VL_DISABLE_AVX VL_DISABLE_SSE2 VL_DISABLE_OPENMP VL_DISABLE_THREADS)

add_library(colmap_wasm STATIC ${SRCS})
target_include_directories(colmap_wasm PUBLIC ${COLMAP_SRC}/src ${CMAKE_CURRENT_SOURCE_DIR}/include ${BOOST_INC} ${PREFIX}/include)
target_compile_definitions(colmap_wasm PUBLIC COLMAP_HASH_STD COLMAP_NO_CHOLMOD GLOG_VERSION_MAJOR=0 GLOG_VERSION_MINOR=7 GLOG_USE_GLOG_EXPORT)
target_link_libraries(colmap_wasm PUBLIC colmap_vlfeat Ceres::ceres PoseLib::PoseLib glog::glog Eigen3::Eigen ${PREFIX}/lib/libsqlite3.a)

add_executable(colmap_gm main.cc)
target_link_libraries(colmap_gm colmap_wasm)
target_link_options(colmap_gm PRIVATE -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB -sNODERAWFS=1
  -sEXIT_RUNTIME=1 -sSTACK_SIZE=8MB -fexceptions)

add_executable(colmap_sift sift_main.cc)
target_link_libraries(colmap_sift colmap_wasm)
target_link_options(colmap_sift PRIVATE -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB -sNODERAWFS=1
  -sEXIT_RUNTIME=1 -sSTACK_SIZE=8MB -fexceptions)

# Browser build: ES module for a Web Worker (src/worker.ts).
add_executable(colmap_web web.cc)
target_link_libraries(colmap_web colmap_wasm)
set_target_properties(colmap_web PROPERTIES OUTPUT_NAME colmap SUFFIX ".mjs")
target_link_options(colmap_web PRIVATE -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=worker
  -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=8MB -fexceptions -sFILESYSTEM=0
  -sEXPORTED_FUNCTIONS=_malloc,_free,_cw_error,_cw_extract,_cw_keypoints,_cw_descriptors,_cw_map_begin,_cw_map_image,_cw_map_matches,_cw_map_run,_cw_res_camera,_cw_res_poses,_cw_res_num_points,_cw_res_points,_cw_res_tracks_size,_cw_res_tracks,_cw_map_end
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPF32,HEAPF64,HEAP32,HEAPU32,UTF8ToString,stringToNewUTF8)
