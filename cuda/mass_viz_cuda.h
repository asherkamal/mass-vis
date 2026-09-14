#ifndef MASS_VIZ_CUDA_H
#define MASS_VIZ_CUDA_H

#include <cstddef>
#include <string>
#include <vector>
#include <fstream>
#include <mutex>

#include "Places.h"
#include "Agents.h"

/**
 * Records mass-viz protocol events (see ../PROTOCOL.md) to an NDJSON file
 * for MASS CUDA applications, so a run can be dropped into
 * mass-viz/server/recordings/ and viewed/replayed/scrubbed in the browser
 * viewer - grid mode only, since mass_cuda_core (unlike mass_cpp_core /
 * mass_java_core) has no graph/vertex API at all (confirmed: no
 * graph/vertex references anywhere under mass_cuda_core/src).
 *
 * Unlike the C++ cluster adapter (../cpp), this one polls from the host
 * driver loop rather than self-reporting from inside callMethod, because
 * mass::Places/mass::Agents expose real public host-side accessors -
 * Places::downloadAttributes<T>(tag, length), Places::getIndexVector(i),
 * Places::getNumPlaces(), Agents::downloadAttributes<T>(tag, length),
 * Agents::getNumAgents() (all confirmed by reading Place.h/Places.h/
 * Agents.h directly) - the same shape of hook mass_java_core's
 * PlacesBase.getPlaces()/AgentsBase.getAgents() provide, just reached via
 * attribute download instead of direct object references.
 *
 * You control what "value" and agent position mean by choosing which
 * attribute tag(s) to download and pass in - this header does not assume
 * any predefined attribute layout beyond what MASS CUDA itself guarantees
 * (Places::getIndexVector for place coordinates).
 *
 * Not compiled/linked in the environment that authored it (no CUDA
 * toolchain was available there) - build alongside the rest of your
 * application with nvcc, using mass_cuda_core's own include/lib paths
 * (see ../cpp/README.md's C++ adapter README for the analogous C++ story;
 * see this directory's README.md for build notes specific to this file).
 */
namespace massviz {

class MassVizCuda {
public:
    static MassVizCuda& instance();

    void openGrid(const std::string& filePath, const std::string& runId,
                  const std::string& runName, const std::vector<int>& dims);

    // Call once per tick: `values` must have exactly numPlaces entries
    // (e.g. straight from `places->downloadAttributes<double>(YOUR_VALUE_TAG,
    // 1)`), in the same row-major order mass_cuda_core itself downloads
    // them in - which matches this protocol's place_grid ordering (see
    // ../PROTOCOL.md) directly, so this forwards the buffer as-is with no
    // per-cell iteration or coordinate lookup needed. This emits a single
    // place_grid event instead of one place event per cell - measured
    // ~5x smaller for a dense full-grid update that changes every tick
    // (see ../benchmark/RESULTS.md); this was in fact the exact workload
    // (a CUDA Heat2D-style grid) that benchmark was modeling.
    void reportPlaces(const double* values, size_t numPlaces);

    // Call once per tick: `agentPlaceIndex` and `agentId` must each have
    // `numAgents` entries (e.g. from Agents::downloadAttributes<T>() on
    // whatever attribute tags your app uses to track an agent's current
    // Place row-major index and identifier). `places` is used to convert
    // each agent's place index into a grid coordinate via getIndexVector.
    void reportAgents(mass::Places* places, const int* agentPlaceIndex,
                       const long long* agentId, int numAgents);

    void step(int stepNumber);
    void close();

private:
    MassVizCuda() = default;
    void writeLine(const std::string& json);
    static std::string escape(const std::string& s);
    static std::string intVectorToJson(const std::vector<int>& values);

    std::ofstream out_;
    std::string runId_;
    std::mutex mutex_;
    bool open_ = false;

    // Tracks which agent ids were reported last call, so spawn vs move can
    // be inferred the same way the Java adapter's snapshotAgents does.
    std::vector<long long> knownAgentIds_;
};

} // namespace massviz

#endif // MASS_VIZ_CUDA_H
