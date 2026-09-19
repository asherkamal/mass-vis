#!/bin/bash
set -e
: "${BOOST_DIR:?set BOOST_DIR (same as compile.sh)}"
export LD_LIBRARY_PATH="$LD_LIBRARY_PATH:$BOOST_DIR/lib"
./cuda-grid-demo
