#ifndef WANDERER_H
#define WANDERER_H

#include "Agent.h"

// Grid-mode mass-viz demo Agent: wanders one step (N/E/S/W or stay) per
// tick and self-reports spawn/migration. Mirrors ../java-grid-demo/Wanderer.java.
class Wanderer : public Agent {
public:
    static const int init_ = 0;
    static const int step_ = 1;

    Wanderer(void *arg);
    void *callMethod(int functionId, void *argument) override;

private:
    void *init(void *argument);
    void *step(void *argument);

    bool spawned_ = false;
    std::string id_;
};

#endif
