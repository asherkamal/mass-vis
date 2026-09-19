#!/bin/bash
# Builds this demo against a real mass_cpp_core checkout. Usage:
#   MASS_DIR=/path/to/mass_cpp_core/ubuntu ./compile.sh
# (MASS_DIR must point at the directory holding libmass.so, i.e.
# mass_cpp_core/ubuntu after `make` there - see ../../cpp/README.md.)
set -e
: "${MASS_DIR:?set MASS_DIR to your mass_cpp_core/ubuntu build dir}"
MASS_SRC="$MASS_DIR/../source"
VIZ_DIR="../../cpp/include"

# 1. Build the mass-viz adapter as its own shared object, exactly once, so
#    the driver and every dlopen'd Place/Agent .so share ONE MassViz
#    singleton instance - see ../../cpp/README.md's "Build & link" section
#    for why linking mass_viz.cpp separately into each .so is a real,
#    silent-data-loss bug (two singleton instances, one of them never
#    open_).
g++ -std=c++20 -Wall -fPIC -shared -I"$VIZ_DIR" "$VIZ_DIR/mass_viz.cpp" -o libmass_viz.so

# 2. Build each Place/Agent subclass as its own dlopen'd .so, linked
#    against libmass_viz.so (not recompiling mass_viz.cpp into them).
g++ -std=c++20 -Wall HeatCell.cpp -I"$MASS_SRC" -I"$VIZ_DIR" -shared -fPIC -L. -lmass_viz -o HeatCell
g++ -std=c++20 -Wall Wanderer.cpp -I"$MASS_SRC" -I"$VIZ_DIR" -shared -fPIC -L. -lmass_viz -o Wanderer

# 3. Build the driver, linked against mass_cpp_core, libssh2, and
#    libmass_viz.so. -rdynamic matches mass_cpp_core's own build (so the
#    driver's own symbols stay visible to whatever it dlopen()s), though
#    with the libmass_viz.so restructure above it's no longer load-bearing
#    for MassViz specifically.
g++ -std=c++20 -Wall main.cpp \
    -I"$MASS_SRC" -I"$VIZ_DIR" \
    -L"$MASS_DIR" -lmass \
    -I"$MASS_DIR/ssh2/include" -L"$MASS_DIR/ssh2/lib" -lssh2 \
    -L. -lmass_viz \
    -rdynamic -o main

echo "build OK: main, HeatCell, Wanderer, libmass_viz.so"
