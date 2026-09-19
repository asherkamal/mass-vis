#!/bin/bash
set -e
export LD_LIBRARY_PATH="$LD_LIBRARY_PATH:${MASS_DIR:?set MASS_DIR}:${MASS_DIR}/ssh2/lib:."
./main
