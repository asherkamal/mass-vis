#include "HeatCell.h"
#include "PlaceAttributes.h"

using namespace mass;

__device__ void HeatCell::callMethod(int functionId, void *arg) {
    switch (functionId) {
        case INIT:
            init((int *)arg);
            break;
        case DIFFUSE:
            diffuse();
            break;
        case SWAP:
            swap();
            break;
        default:
            break;
    }
}

__device__ void HeatCell::init(int *dims) {
    int width = dims[0];
    int index = (int)getIndex();
    int x = index % width;
    int y = index / width;

    // Deliberately asymmetric field (see main.cu's WIDTH/HEIGHT and the
    // asymmetric sin/cos args) so a transposed x/y axis - e.g. getting
    // ROW_MAJOR vs. COL_MAJOR wrong when reading this back on the host -
    // would be visibly wrong, not accidentally symmetric-and-passing.
    double temp = 50.0 + 10.0 * sin(x * 0.3) * cos(y * 0.5);

    double *t = getAttribute<double>(TEMPERATURE, 1);
    *t = temp;
    double *nt = getAttribute<double>(NEXT_TEMPERATURE, 1);
    *nt = temp;
}

__device__ void HeatCell::diffuse() {
    double self = *getAttribute<double>(TEMPERATURE, 1);

    // NEIGHBORS is a predefined Place attribute (see PlaceAttributes.h):
    // MAX_NEIGHBORS row-major place indices, -1 where unset (fewer than
    // MAX_NEIGHBORS neighbors, or exchangeAll wasn't given that many
    // destinations - see main.cu's exchangeAll call, which sets up
    // exactly 4: N/S/E/W).
    int *neighbors = getAttribute<int>(PlacePreDefinedAttr::NEIGHBORS, MAX_NEIGHBORS);

    double sum = self;
    int count = 1;
    for (int i = 0; i < MAX_NEIGHBORS; i++) {
        int nIdx = neighbors[i];
        if (nIdx < 0) continue;
        // Read a NEIGHBOR PLACE's own TEMPERATURE attribute directly by its
        // index - Place::getAttribute(size_t desIndex, int tag, int length)
        // (see ../../../mass_cuda_core/test/TestPlaces/AttributeSpace.h's
        // printNextPlaceAttr for the same pattern), rather than any kind of
        // message passing.
        double neighborTemp = *getAttribute<double>((size_t)nIdx, TEMPERATURE, 1);
        sum += neighborTemp;
        count++;
    }

    double *next = getAttribute<double>(NEXT_TEMPERATURE, 1);
    *next = self * 0.5 + (sum / count) * 0.5;
}

__device__ void HeatCell::swap() {
    double *t = getAttribute<double>(TEMPERATURE, 1);
    double *next = getAttribute<double>(NEXT_TEMPERATURE, 1);
    *t = *next;
}
