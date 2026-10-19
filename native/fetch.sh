#!/usr/bin/env bash
# Fetch the toolchain and pinned sources into $COLMAP_WASM_DIR (outside the repo).
# Every download is pinned: archives by SHA-256, git checkouts by commit.
# patches/*.patch are reapplied to a clean COLMAP checkout whenever they change.
set -e
H=$(cd "$(dirname "$0")" && pwd)
R=${COLMAP_WASM_DIR:?set COLMAP_WASM_DIR to a work directory}; mkdir -p $R/src; cd $R
PY=${PYTHON:-python3}  # emsdk needs Python >= 3.10

EMSDK_COMMIT=3b3963d86a5c97adaf6eaa845cdfe0b811c2f960
EMSDK_VERSION=6.0.12
COLMAP_TAG=4.2.1
COLMAP_COMMIT=bd1fcf654d2dd8fefa1466999c190a246f83f4b9

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

# Pinned shallow checkout of `commit` from `repo` in `dir`.
checkout() {
  local repo=$1 dir=$2 commit=$3
  if [ ! -d "$dir/.git" ]; then
    git init -q "$dir"
    git -C "$dir" remote add origin "$repo"
  fi
  if [ "$(git -C "$dir" rev-parse -q --verify HEAD 2>/dev/null)" != "$commit" ]; then
    git -C "$dir" fetch -q --depth 1 origin "$commit"
    git -C "$dir" checkout -q --force "$commit"
  fi
}

[ -x venv/bin/cmake ] || { $PY -m venv venv && venv/bin/pip install -q cmake==4.4.4 ninja==1.13.2; }

checkout https://github.com/emscripten-core/emsdk.git emsdk $EMSDK_COMMIT
(cd emsdk && EMSDK_PYTHON=$PY ./emsdk install $EMSDK_VERSION && EMSDK_PYTHON=$PY ./emsdk activate $EMSDK_VERSION) > /dev/null

cd src

# COLMAP at the pinned commit (tag $COLMAP_TAG) with our patches; reset and
# reapplied only when the patch set changes, so unchanged builds stay incremental.
checkout https://github.com/colmap/colmap.git colmap $COLMAP_COMMIT
patches_id=$(cat "$H"/patches/*.patch | sha256 /dev/stdin)
if [ "$(cat colmap/.patches-applied 2>/dev/null)" != "$patches_id" ]; then
  echo "applying patches to COLMAP $COLMAP_TAG"
  git -C colmap reset -q --hard "$COLMAP_COMMIT"
  git -C colmap clean -q -fd
  for p in "$H"/patches/*.patch; do git -C colmap apply "$p"; done
  echo "$patches_id" > colmap/.patches-applied
fi

# Archive at `url` saved as `file`, checked against `sum`, unpacked once into `dir`.
get() {
  local url=$1 file=$2 sum=$3 dir=$4
  if [ ! -e "$file" ] || [ "$(sha256 "$file")" != "$sum" ]; then
    curl -sSL --fail -o "$file.tmp" "$url"
    local got; got=$(sha256 "$file.tmp")
    if [ "$got" != "$sum" ]; then
      rm -f "$file.tmp"
      echo "checksum mismatch for $url: expected $sum, got $got" >&2
      exit 1
    fi
    mv "$file.tmp" "$file"
    rm -rf "$dir"
  fi
  if [ ! -d "$dir" ]; then
    case "$file" in *.zip) unzip -qo "$file" ;; *) tar xzf "$file" ;; esac
  fi
}
get https://gitlab.com/libeigen/eigen/-/archive/3.4.0/eigen-3.4.0.tar.gz eigen.tgz \
  8586084f71f9bde545ee7fa6d00288b264a2b7ac3607b974e54d13e7162c1c72 eigen-3.4.0
get https://github.com/ceres-solver/ceres-solver/archive/refs/tags/2.2.0.tar.gz ceres.tgz \
  12efacfadbfdc1bbfa203c236e96f4d3c210bed96994288b3ff0c8e7c6f350d4 ceres-solver-2.2.0
get https://github.com/google/glog/archive/refs/tags/v0.7.1.tar.gz glog.tgz \
  00e4a87e87b7e7612f519a41e491f16623b12423620006f59f5688bfd8d13b08 glog-0.7.1
get https://github.com/PoseLib/PoseLib/archive/fa7280fee27f97aff31ae7f98bab7f583fac7d08.zip poselib.zip \
  5408d4ae8ce367cb2f076bc6c5f0f6f78abd3573d2c015304b04e46f23455f5b PoseLib-fa7280fee27f97aff31ae7f98bab7f583fac7d08
get https://www.sqlite.org/2024/sqlite-amalgamation-3460100.zip sqlite.zip \
  77823cb110929c2bcb0f5d48e4833b5c59a8a6e40cdea3936b99e199dbbe5784 sqlite-amalgamation-3460100
