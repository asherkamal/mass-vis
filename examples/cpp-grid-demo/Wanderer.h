#ifndef WANDERER_H
#define WANDERER_H

#include "Agent.h"

// Grid-mode mass-viz demo Agent: requests one step (N/E/S/W or stay) per
// tick, and reports its position to mass-viz from report_, which the driver
// calls AFTER manageAll() - migrate() in step_ only requests a migration, so
// reporting there could record a position the agent never reached.
// Mirrors ../java-grid-demo/Wanderer.java.
class Wanderer : public Agent {
public:
    static const int init_ = 0;
    static const int step_ = 1;
    static const int report_ = 2;

    Wanderer(void *arg);
    void *callMethod(int functionId, void *argument) override;

private:
    void *init(void *argument);
    void *step(void *argument);
    void *report(void *argument);

    bool spawned_ = false;
    std::string id_;
};

#endif
