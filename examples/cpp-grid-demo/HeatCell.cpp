#include "HeatCell.h"
#include "mass_viz.h"
#include <cmath>

HeatCell::HeatCell(void *arg) : Place(arg) {}

void *HeatCell::callMethod(int functionId, void *argument) {
    switch (functionId) {
        case init_: return init(argument);
        case tick_: return tick(argument);
    }
    return nullptr;
}

void *HeatCell::init(void * /*argument*/) {
    // A deliberately asymmetric starting field (see main.cpp's WIDTH/HEIGHT)
    // so a transposed x/y axis would be visibly wrong, not accidentally
    // symmetric-and-passing.
    value_ = 50.0 + 10.0 * std::sin(index[0] * 0.3) * std::cos(index[1] * 0.5);
    // Report the starting field too (main.cpp opens the recording before
    // this runs and ends the initial state with step(-1)).
    massviz::MassViz::instance().reportPlace(index, value_);
    return nullptr;
}

void *HeatCell::tick(void *argument) {
    int step = *static_cast<int *>(argument);
    value_ = 50.0 + 45.0 * std::sin(step * 0.15 + index[0] * 0.2) * std::cos(index[1] * 0.2 - step * 0.05);
    // Self-report from inside callMethod - see ../../cpp/README.md for why
    // this is the only non-invasive hook mass_cpp_core exposes.
    massviz::MassViz::instance().reportPlace(index, value_);
    return nullptr;
}

// DllClass loads this Place subclass via dlopen(3) + dlsym(3) looking for
// these exact C-linkage factory symbols - see mass_cpp_core/source/DllClass.cpp
// and the pattern documented in mass_cpp_core/README.md.
extern "C" Place *instantiate(void *argument) { return new HeatCell(argument); }
extern "C" void destroy(Place *object) { delete object; }
