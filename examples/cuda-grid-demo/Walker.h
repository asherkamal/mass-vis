#pragma once

#include "Agent.h"
#include "Place.h"

// Grid-mode mass-viz demo Agent for MASS CUDA, matching ../../cuda/README.md's
// usage example - stages its own place-index and id into attributes each
// tick so the host driver can downloadAttributes() them for
// MassVizCuda::reportAgents().
//
// Same "no extra data members" constraint as HeatCell.h - see that file's
// comment.
//
// WHY THIS CLASS EXISTS (see ../../cuda/README.md and
// ../../cuda/mass_viz_cuda.h's own comments): mass_cuda_core's built-in
// RESIDE_PLACE agent attribute holds a raw device Place* (not usable from
// the host), and Agent::getPlaceIndex() is __device__-only - confirmed by
// reading Agent.h directly - so there is no host-callable way to ask "what
// place index is this agent at". PLACE_IDX below is exactly the
// user-maintained attribute mass_viz_cuda.h's reportAgents() doc comment
// says every caller must provide.
class Walker : public mass::Agent {
public:
    MASS_FUNCTION Walker(int index) : mass::Agent(index) {}
    MASS_FUNCTION ~Walker() {}

    enum FUNCTION_ID {
        INIT,  // no arg - derives a stable id from this agent's own getIndex()
        MOVE,  // arg: unsigned int* = current step number
        SYNC,  // no arg - call AFTER Agents::manageAll(): stages the place the agent really is on
    };

    enum ATTR_ID {
        WALKER_ID,  // long long, length 1 - stable identity for mass-viz
        PLACE_IDX,  // int, length 1 - current Place's row-major index
    };

    __device__ virtual void callMethod(int functionId, void *arg = NULL);

private:
    __device__ void init();
    __device__ void move(unsigned int *step);
    __device__ void sync();
};
