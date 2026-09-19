#!/bin/bash
# Builds this demo against a real mass_cuda_core checkout. Usage:
#   MASS_CUDA_DIR=/path/to/mass_cuda_core BOOST_DIR=/path/to/boost ./compile.sh
# (MASS_CUDA_DIR must point at a directory holding lib/mass/mass_cuda.a and
# src/*.h, i.e. mass_cuda_core after running its build target - see
# ../../cuda/README.md. Needs nvcc on PATH.)
set -e
: "${MASS_CUDA_DIR:?set MASS_CUDA_DIR to a mass_cuda_core checkout, already built}"

# mass_cuda_core Places.h/Agents.h (pulled in by mass_viz_cuda.cpp - see
# that file and ../../cuda/mass_viz_cuda.h for why the header itself does
# not need this) transitively include Logger.h, which pulls in Boost log
# and Boost format - a compiled Boost library, not header-only. BOOST_DIR
# must point at a prefix with include/boost and lib/libboost_log*.{a,so} -
# mass_cuda_core own install-boost Makefile target builds exactly this
# (lib/boost-1.84.0 under the mass_cuda_core checkout).
: "${BOOST_DIR:?set BOOST_DIR to a Boost 1.84 install with program_options and log built}"

VIZ_DIR="../../cuda"
: "${CUDA_HOME_DEFAULT:=/usr/local/cuda}"
# -rdc=true (relocatable device code) is required, matching
# mass_cuda_core own build flags exactly (see its Makefile): our .cu files
# define __device__ functions that call device-side helpers compiled into
# mass_cuda.a (e.g. mass::getGlobalIdx_1D_1D) from a DIFFERENT translation
# unit. Without -rdc=true here, ptxas fails at the final link step with
# "Unresolved extern function" for exactly that symbol - confirmed.
NVCC_FLAGS="-std=c++14 -Wno-deprecated-gpu-targets -rdc=true"
MASS_INC="-I$MASS_CUDA_DIR/src"
# BOOST_LOG_DYN_LINK is required whenever Boost.Log itself was built as a
# shared library (which b2's default install target produces, alongside the
# static .a - see mass_cuda_core own install-boost Makefile target).
# Boost.Log headers switch which linkage convention their inline glue code
# assumes based on this macro; without it, EVERY boost::log symbol -
# including totally ordinary ones like core::get() - comes up as an
# undefined reference at link time no matter how the libraries are ordered
# or grouped (confirmed by isolating this down to a two-line boost::log
# program with zero CUDA/mass_cuda_core involvement - reordering, whole-
# archive, and static-vs-shared linking all failed identically; only this
# macro fixed it).
BOOST_INC="-isystem $BOOST_DIR/include -DBOOST_LOG_DYN_LINK"
BOOST_LIB="-L$BOOST_DIR/lib -lboost_log -lboost_log_setup -lboost_thread -lboost_filesystem -lpthread"
# 1. mass_viz_cuda.cpp is the one translation unit that includes Places.h
#    (see the forward-declaration comment in mass_viz_cuda.h), so it alone
#    needs mass_cuda_core and Boost include paths. Despite containing no
#    device code of its own, it must still be compiled with nvcc, not a
#    plain C++ compiler: Places.h pulls in DeviceConfig.h, which contains
#    real __global__ kernels and <<<...>>> launch syntax that only nvcc's
#    frontend parses - g++ fails outright on that header (confirmed).
nvcc $NVCC_FLAGS -x cu -c "$VIZ_DIR/mass_viz_cuda.cpp" $MASS_INC $BOOST_INC -o mass_viz_cuda.o

# 2. Place/Agent subclasses and the driver - all real device (.cu) code,
#    built with nvcc against mass_cuda_core headers.
nvcc $NVCC_FLAGS $MASS_INC -c HeatCell.cu -o HeatCell.o
nvcc $NVCC_FLAGS $MASS_INC -c Walker.cu -o Walker.o
nvcc $NVCC_FLAGS $MASS_INC -I. -I"$VIZ_DIR" $BOOST_INC -c main.cu -o main.o

# 3. Link. With -rdc=true, this is a two-phase process:
#
#    3a. nvcc -dlink resolves cross-translation-unit __device__ references
#        (see NVCC_FLAGS's comment) into one additional relocatable object -
#        this step only needs the CUDA device runtime, not Boost.
CUDA_LIB_DIR="-L$CUDA_HOME_DEFAULT/lib64"
nvcc $NVCC_FLAGS main.o HeatCell.o Walker.o mass_viz_cuda.o \
    "$MASS_CUDA_DIR/lib/mass/mass_cuda.a" \
    -dlink -o device_link.o

#    3b. The actual host link, via g++ directly rather than nvcc - nvcc's
#        own driver rejected -Wl,--start-group outright ("Unknown option"),
#        and passing the equivalent -Xlinker --start-group/--end-group
#        through nvcc compiled but left the exact same boost::log symbols
#        unresolved (nvcc restructures/reorders host-linker arguments
#        internally for its own -dlink/fatbinary machinery, which appears to
#        not preserve an explicit group boundary - confirmed empirically,
#        not guessed). g++ needs no special CUDA flags here: all device code
#        is already resolved into device_link.o by step 3a; only the CUDA
#        and C++ runtime libraries need linking, plus Boost.
#
#    The --start-group/--end-group IS load-bearing here (removing it
#    reproduces the undefined-boost::log-symbol failures) - mass_cuda.a's
#    object files reference boost::log symbols, but plain left-to-right
#    static-archive resolution only pulls in a .a member once, on the first
#    pass, even when a later archive in the same command line would have
#    satisfied a still-outstanding reference.
g++ main.o HeatCell.o Walker.o mass_viz_cuda.o device_link.o \
    -Wl,--start-group \
    "$MASS_CUDA_DIR/lib/mass/mass_cuda.a" \
    $BOOST_LIB \
    -Wl,--end-group \
    $CUDA_LIB_DIR -lcudart \
    -o cuda-grid-demo

echo "build OK: cuda-grid-demo"
