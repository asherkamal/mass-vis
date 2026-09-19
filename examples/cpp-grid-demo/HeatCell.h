#ifndef HEATCELL_H
#define HEATCELL_H

#include "Place.h"

// Grid-mode mass-viz demo Place, matching the shape shown in
// ../../cpp/README.md's usage example: a Heat2D-style cell whose value
// evolves each tick and self-reports via massviz::MassViz from inside
// callMethod(). Mirrors ../java-grid-demo/HeatCell.java.
class HeatCell : public Place {
public:
    static const int init_ = 0;
    static const int tick_ = 1;

    HeatCell(void *arg);
    void *callMethod(int functionId, void *argument) override;

private:
    void *init(void *argument);
    void *tick(void *argument);

    double value_ = 0.0;
};

#endif
