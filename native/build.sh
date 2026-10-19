#!/usr/bin/env bash
# Build the dependencies and the COLMAP subset for wasm32 (single-threaded) after fetch.sh.
# Output: $COLMAP_WASM_DIR/build/colmap/: colmap.{mjs,wasm} (browser, src/worker.ts) and the
# Node tools colmap_sift / colmap_gm (NODERAWFS, for comparisons with native COLMAP).
set -e
R=${COLMAP_WASM_DIR:?set COLMAP_WASM_DIR}; H=$(cd "$(dirname "$0")" && pwd); S=$R/src; P=$R/prefix; B=$R/build
BOOST_INC=${BOOST_INC:-/opt/homebrew/include}
export EMSDK_PYTHON=${PYTHON:-python3} EMSDK_QUIET=1; source $R/emsdk/emsdk_env.sh
export PATH=$R/venv/bin:$PATH
mkdir -p $B $P/lib $P/include $R/inc; ln -sfn $BOOST_INC/boost $R/inc/boost
FLAGS="-O3 -fexceptions"
common=(-G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=$P -DCMAKE_PREFIX_PATH=$P -DCMAKE_FIND_ROOT_PATH=$P
        -DBUILD_SHARED_LIBS=OFF -DBUILD_TESTING=OFF "-DCMAKE_C_FLAGS=$FLAGS" "-DCMAKE_CXX_FLAGS=$FLAGS"
        -DCMAKE_POLICY_VERSION_MINIMUM=3.5)
dep() { local name=$1 src=$2; shift 2; [ -f $B/$name.done ] && return
  echo "== $name"; emcmake cmake -S $src -B $B/$name "${common[@]}" "$@" > $B/$name.log 2>&1
  cmake --build $B/$name --target install >> $B/$name.log 2>&1; touch $B/$name.done; }
dep eigen $S/eigen-3.4.0 -DEIGEN_BUILD_DOC=OFF -DEIGEN_BUILD_PKGCONFIG=OFF
dep glog $S/glog-0.7.1 -DWITH_GFLAGS=OFF -DWITH_GTEST=OFF -DWITH_UNWIND=none -DWITH_PKGCONFIG=OFF
dep ceres $S/ceres-solver-2.2.0 -DMINIGLOG=OFF -DGFLAGS=OFF -DSUITESPARSE=OFF -DLAPACK=OFF -DEIGENSPARSE=ON -DUSE_CUDA=OFF \
  -DBUILD_EXAMPLES=OFF -DBUILD_BENCHMARKS=OFF -DEigen3_DIR=$P/share/eigen3/cmake -Dglog_DIR=$P/lib/cmake/glog
dep poselib $S/PoseLib-fa7280fee27f97aff31ae7f98bab7f583fac7d08 -DMARCH_NATIVE=OFF -DEigen3_DIR=$P/share/eigen3/cmake
if [ ! -f $P/lib/libsqlite3.a ]; then echo "== sqlite"; mkdir -p $B/sqlite
  emcc -O3 -DSQLITE_THREADSAFE=0 -DSQLITE_OMIT_LOAD_EXTENSION -c $S/sqlite-amalgamation-3460100/sqlite3.c -o $B/sqlite/sqlite3.o
  emar rcs $P/lib/libsqlite3.a $B/sqlite/sqlite3.o; cp $S/sqlite-amalgamation-3460100/sqlite3.h $P/include/; fi
echo "== colmap"
sed -e 's/${COLMAP_VERSION}/4.2.1/; s/${GIT_COMMIT_ID}/4.2.1/; s/${GIT_COMMIT_DATE}//; s/${COLMAP_VERSION_MAJOR}/4/; s/${COLMAP_VERSION_MINOR}/2/; s/${COLMAP_VERSION_PATCH}/1/' \
  $S/colmap/src/colmap/util/version.cc.in > $B/version.cc
emcmake cmake -S $H/entry -B $B/colmap -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_PREFIX_PATH=$P -DCMAKE_FIND_ROOT_PATH=$P \
  "-DCMAKE_CXX_FLAGS=$FLAGS" "-DCMAKE_C_FLAGS=$FLAGS" -DCOLMAP_SRC=$S/colmap -DPREFIX=$P -DBOOST_INC=$R/inc -DVERSION_CC=$B/version.cc \
  -DEigen3_DIR=$P/share/eigen3/cmake -Dglog_DIR=$P/lib/cmake/glog -DCeres_DIR=$P/lib/cmake/Ceres -DPoseLib_DIR=$P/lib/cmake/PoseLib > $B/colmap.log 2>&1
cmake --build $B/colmap >> $B/colmap.log 2>&1 || { grep -E "error" $B/colmap.log | head -20; exit 1; }
ls -la $B/colmap/colmap.wasm
