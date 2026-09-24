#include "Wanderer.h"
#include "mass_viz.h"
#include <sstream>
#include <cstdlib>

Wanderer::Wanderer(void *arg) : Agent(arg) {}

void *Wanderer::callMethod(int functionId, void *argument) {
    switch (functionId) {
        case init_: return init(argument);
        case step_: return step(argument);
        case report_: return report(argument);
    }
    return nullptr;
}

void *Wanderer::init(void * /*argument*/) {
    std::ostringstream os;
    os << "w" << agentId;
    id_ = os.str();
    return nullptr;
}

// Called by the driver after Agents::manageAll(), when `index` is where the
// agent really is: the first call reports the spawn, later calls the move.
void *Wanderer::report(void * /*argument*/) {
    if (!spawned_) {
        massviz::MassViz::instance().reportAgentSpawnGrid(id_, index);
        spawned_ = true;
    } else {
        massviz::MassViz::instance().reportAgentMoveGrid(id_, index);
    }
    return nullptr;
}

void *Wanderer::step(void *argument) {
    int tick = *static_cast<int *>(argument);

    // Deterministic pseudo-random walk (seeded by agentId + tick) so the
    // recording is reproducible run-to-run for comparison.
    int dir = (agentId * 7 + tick * 3) % 4;
    std::vector<int> dest = index;
    switch (dir) {
        case 0: dest[1] += 1; break; // N
        case 1: dest[0] += 1; break; // E
        case 2: dest[1] -= 1; break; // S
        case 3: dest[0] -= 1; break; // W
    }
    if (dest[0] >= 0 && dest[0] < place->size[0] && dest[1] >= 0 && dest[1] < place->size[1]) {
        // Only a request: the move is reported from report_, after manageAll.
        migrate(dest);
    }
    return nullptr;
}

extern "C" Agent *instantiate(void *argument) { return new Wanderer(argument); }
extern "C" void destroy(Agent *object) { delete object; }
