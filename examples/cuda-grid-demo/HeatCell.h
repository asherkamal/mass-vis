#pragma once

#include "Place.h"

// Grid-mode mass-viz demo Place for MASS CUDA, matching ../../cuda/README.md's
// usage example - one attribute reported per tick via Places::downloadAttributes.
//
// IMPORTANT (see ../../cuda/README.md's "constraints this demo respects"
// section): this class must add NO extra data members. mass_cuda_core's
// Mass::createPlaces<PlaceType> placement-news the device array through a
// Place*-typed pointer (DeviceConfig.h's instantiatePlaceArrayKernel), so
// per-element addressing uses sizeof(Place), not sizeof(PlaceType) - any
// extra member here would silently corrupt every other element. All
// per-place state lives in externally-managed attributes instead - see
// TEMPERATURE/NEXT_TEMPERATURE below.
//
// TEMPERATURE is `double`, matching massviz::MassVizCuda::reportPlaces's
// `const double*` signature exactly - downloadAttributes<T> is a raw
// device->host memcpy keyed on the T you pass, so the attribute's actual
// on-device type must match what you download it as; using double
// end-to-end avoids a host-side float->double conversion pass.
class HeatCell : public mass::Place {
public:
    MASS_FUNCTION HeatCell(int index) : mass::Place(index) {}
    MASS_FUNCTION ~HeatCell() {}

    enum FUNCTION_ID {
        INIT,     // arg: int[2] = {width, height} - seeds the initial field
        DIFFUSE,  // reads TEMPERATURE of self + up to 4 neighbors into NEXT_TEMPERATURE
        SWAP,     // TEMPERATURE = NEXT_TEMPERATURE
    };

    enum ATTR_ID {
        TEMPERATURE,       // double, length 1 - downloaded each tick for the viewer
        NEXT_TEMPERATURE,  // double, length 1 - diffusion staging buffer
    };

    __device__ virtual void callMethod(int functionId, void *arg = NULL);

private:
    __device__ void init(int *dims);
    __device__ void diffuse();
    __device__ void swap();
};
