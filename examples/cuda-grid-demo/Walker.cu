#include "Walker.h"
#include "PlaceAttributes.h"

using namespace mass;

__device__ void Walker::callMethod(int functionId, void *arg) {
    switch (functionId) {
        case INIT:
            init();
            break;
        case MOVE:
            move((unsigned int *)arg);
            break;
        case SYNC:
            sync();
            break;
        default:
            break;
    }
}

__device__ void Walker::init() {
    // getIndex() is a stable per-agent device index assigned at creation
    // (Mass::createAgents), distinct from FLAME GPU2's very different
    // "ids are 0 until the first step runs" behavior (see
    // ../flamegpu2-grid-demo/ for that story) - confirmed usable here
    // immediately after createAgents, with no extra bookkeeping needed.
    long long *wid = getAttribute<long long>(WALKER_ID, 1);
    *wid = (long long)getIndex();

    Place *residePlace = getPlace();
    int *placeIdx = getAttribute<int>(PLACE_IDX, 1);
    *placeIdx = residePlace ? (int)residePlace->getIndex() : -1;
}

__device__ void Walker::move(unsigned int *step) {
    Place *residePlace = getPlace();
    if (!residePlace) return;

    long long id = *getAttribute<long long>(WALKER_ID, 1);
    unsigned int dir = (unsigned int)((id * 7 + (long long)(*step) * 3) % 4);

    // NEIGHBORS/NEIGHBOR_PTRS are set up once by main.cu's exchangeAll call,
    // in the fixed order [north, south, east, west] - see that file.
    Place **neighborPtrs = residePlace->getNeighborsPtr();
    int *neighbors = residePlace->getNeighbors();

    if ((int)dir < MAX_NEIGHBORS && neighbors[dir] >= 0) {
        // Only a request: it takes effect at the next Agents::manageAll()
        // (mass_cuda_core's manageAll runs terminate -> migrate -> spawn as
        // separate dispatcher passes - see Agents.cu), and manageAll may
        // decline it (e.g. an occupied destination). So PLACE_IDX is NOT
        // staged here from the neighbor we asked for - that would record a
        // move the library might never have made. sync() below stages it
        // from where the agent actually is, after manageAll.
        migrate(neighborPtrs[dir]);
    }
}

// Run after Agents::manageAll(): getPlace() is now the agent's real place, so
// the recorded position can never disagree with the simulation.
__device__ void Walker::sync() {
    Place *residePlace = getPlace();
    int *placeIdx = getAttribute<int>(PLACE_IDX, 1);
    *placeIdx = residePlace ? (int)residePlace->getIndex() : -1;
}
