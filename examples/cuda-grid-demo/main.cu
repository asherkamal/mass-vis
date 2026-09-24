#include "Mass.h"
#include "HeatCell.h"
#include "Walker.h"
#include "mass_viz_cuda.h"

#include <vector>
#include <cstdio>

// Grid-mode mass-viz demo for MASS CUDA, mirroring ../cpp-grid-demo/main.cpp
// and ../java-grid-demo/GridDemo.java's shape as closely as MASS CUDA's own
// API allows - see ../../cuda/README.md for the two real constraints this
// demo exists to exercise (Place/Agent subclasses must add no data members;
// agent positions must be staged into a user-maintained attribute, not read
// from the built-in RESIDE_PLACE/getPlaceIndex()).
using namespace mass;

const int WIDTH = 16;
const int HEIGHT = 10;  // deliberately != WIDTH - see HeatCell.cu's init()
const int NUM_WALKERS = 5;
const int NUM_STEPS = 40;

int main() {
    Mass::init();

    int placesSize[2] = {WIDTH, HEIGHT};
    Places *grid = Mass::createPlaces<HeatCell>(1, 2, placesSize, Place::MemoryOrder::ROW_MAJOR);

    // Set up 4-neighbor (N/S/E/W) connectivity, in that fixed order - both
    // HeatCell::diffuse() and Walker::move() rely on this exact ordering of
    // the resulting NEIGHBORS/NEIGHBOR_PTRS attributes.
    std::vector<int *> destinations;
    int north[2] = {0, 1};
    int south[2] = {0, -1};
    int east[2] = {1, 0};
    int west[2] = {-1, 0};
    destinations.push_back(north);
    destinations.push_back(south);
    destinations.push_back(east);
    destinations.push_back(west);
    grid->exchangeAll(&destinations);

    // Register HeatCell's two custom attributes. Mass::createPlaces<T>
    // already called finalizeAttributes() once internally (for the 7
    // predefined attributes only - NEIGHBORS, AGENT_POPS, etc.), so any
    // custom attribute needs its own setAttribute<T> + a SECOND
    // finalizeAttributes() call before it is usable from callMethod -
    // confirmed against mass_cuda_core/test/main.cu's own
    // MASS_Places.Attributes test, which does exactly this. Skipping this
    // is a real, silent-until-runtime trap: every getAttribute<T> call in
    // HeatCell::init/diffuse/swap for TEMPERATURE/NEXT_TEMPERATURE reads an
    // unregistered attribute slot, and the resulting out-of-bounds device
    // access doesn't fail at the point of the bad read - it corrupts the
    // CUDA context and only surfaces later as a seemingly unrelated
    // "illegal memory access" on some later, innocent CUDA call (confirmed
    // via compute-sanitizer: the first real fault was here, but the
    // process didn't report an error until a subsequent cudaMalloc for the
    // Agents population).
    grid->setAttribute<double>(HeatCell::TEMPERATURE, 1);
    grid->setAttribute<double>(HeatCell::NEXT_TEMPERATURE, 1);
    grid->finalizeAttributes();

    int initArgs[2] = {WIDTH, HEIGHT};
    grid->callAll(HeatCell::INIT, initArgs, sizeof(int) * 2);

    Agents *walkers = Mass::createAgents<Walker>(2, NUM_WALKERS, grid);
    // Same requirement as HeatCell above - Walker's two custom attributes
    // need their own setAttribute<T> + finalizeAttributes() before INIT.
    walkers->setAttribute<long long>(Walker::WALKER_ID, 1);
    walkers->setAttribute<int>(Walker::PLACE_IDX, 1);
    walkers->finalizeAttributes();
    walkers->callAll(Walker::INIT);

    massviz::MassVizCuda::instance().openGrid(
        "cuda-grid-demo.ndjson", "cuda-grid-demo", "CUDA Grid Demo", std::vector<int>{WIDTH, HEIGHT});

    // Emit the true starting state (before any DIFFUSE/MOVE has run) - the
    // same "step -1" idea as ../flamegpu2-grid-demo/'s report_initial(),
    // done manually here since MassVizCuda has no equivalent convenience
    // method (see ../../cuda/README.md).
    {
        double *temperatures = grid->downloadAttributes<double>(HeatCell::TEMPERATURE, 1);
        massviz::MassVizCuda::instance().reportPlaces(temperatures, (size_t)grid->getNumPlaces());
        delete[] temperatures;

        int *placeIdx = walkers->downloadAttributes<int>(Walker::PLACE_IDX, 1);
        long long *walkerIds = walkers->downloadAttributes<long long>(Walker::WALKER_ID, 1);
        massviz::MassVizCuda::instance().reportAgents(grid, placeIdx, walkerIds, walkers->getNumAgents());
        delete[] placeIdx;
        delete[] walkerIds;

        // End of the initial state: without this marker these events would
        // be folded into step 0's replay frame (see PROTOCOL.md).
        massviz::MassVizCuda::instance().step(-1);
    }

    for (unsigned int step = 0; step < (unsigned int)NUM_STEPS; step++) {
        grid->callAll(HeatCell::DIFFUSE);
        grid->callAll(HeatCell::SWAP);

        walkers->callAll(Walker::MOVE, &step, sizeof(unsigned int));
        walkers->manageAll();
        // Now that migrations have actually happened, stage each walker's
        // real place for reporting (MOVE only requested the migration).
        walkers->callAll(Walker::SYNC);

        double *temperatures = grid->downloadAttributes<double>(HeatCell::TEMPERATURE, 1);
        massviz::MassVizCuda::instance().reportPlaces(temperatures, (size_t)grid->getNumPlaces());
        delete[] temperatures;  // per mass_cuda_core's downloadAttributes ownership convention

        int *placeIdx = walkers->downloadAttributes<int>(Walker::PLACE_IDX, 1);
        long long *walkerIds = walkers->downloadAttributes<long long>(Walker::WALKER_ID, 1);
        massviz::MassVizCuda::instance().reportAgents(grid, placeIdx, walkerIds, walkers->getNumAgents());
        delete[] placeIdx;
        delete[] walkerIds;

        massviz::MassVizCuda::instance().step((int)step);
    }

    massviz::MassVizCuda::instance().close();
    Mass::finish();
    printf("cuda-grid-demo: done\n");
    return 0;
}
