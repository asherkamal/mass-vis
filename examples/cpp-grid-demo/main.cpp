#include "MASS.h"
#include "HeatCell.h"
#include "Wanderer.h"
#include "mass_viz.h"
#include <string>

// Grid-mode mass-viz demo for MASS C++, structured like
// mass_cpp_core/ubuntu/samples/main.cpp and mirroring
// ../java-grid-demo/GridDemo.java's shape as closely as the two libraries'
// APIs allow. Runs single-process (nProc=1) - see ../../cpp/README.md for
// why MASS::init with nProc>1 is out of scope for this adapter's
// self-reporting design (Places would live in other OS processes).
int main(int argc, char *argv[]) {
    const int WIDTH = 12;
    const int HEIGHT = 9; // deliberately != WIDTH, see HeatCell::init's comment
    const int NUM_STEPS = 40;

    char *arguments[4];
    arguments[0] = (char *)"dslab";
    arguments[1] = (char *)"ignored";
    arguments[2] = (char *)"machinefile.txt";
    arguments[3] = (char *)"12345";

    MASS::init(arguments, 1, 1); // nProc=1: single local process, no SSH out

    Places *grid = new Places(1, "HeatCell", nullptr, 0, 2, WIDTH, HEIGHT);
    grid->callAll(HeatCell::init_);

    Agents *wanderers = new Agents(2, "Wanderer", nullptr, 0, grid, 4);
    wanderers->callAll(Wanderer::init_);

    massviz::MassViz::instance().openGrid(
        "cpp-grid-demo.ndjson", "cpp-grid-demo", "C++ Grid Demo", std::vector<int>{WIDTH, HEIGHT});

    for (int step = 0; step < NUM_STEPS; step++) {
        grid->callAll(HeatCell::tick_, &step, sizeof(int));
        wanderers->callAll(Wanderer::step_, &step, sizeof(int));
        wanderers->manageAll();
        massviz::MassViz::instance().step(step);
    }

    massviz::MassViz::instance().close();
    MASS::finish();
    return 0;
}
