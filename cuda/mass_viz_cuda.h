#ifndef MASS_VIZ_CUDA_H
#define MASS_VIZ_CUDA_H

#include <cstddef>
#include <string>
#include <vector>
#include <fstream>
#include <mutex>
#include <unordered_set>

// Only a forward declaration: reportAgents() takes a mass::Places* for source
// compatibility but does not use it (coordinates are decoded from the dims
// given to openGrid), so this adapter needs no mass_cuda_core header - and
// none of the Boost.Log/nvcc machinery Places.h drags in - to build or call.
namespace mass {
class Places;
}

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
 * Places::downloadAttributes<T>(tag, length),
 * Places::getNumPlaces(), Agents::downloadAttributes<T>(tag, length),
 * Agents::getNumAgents() (all confirmed by reading Place.h/Places.h/
 * Agents.h directly) - the same shape of hook mass_java_core's
 * PlacesBase.getPlaces()/AgentsBase.getAgents() provide, just reached via
 * attribute download instead of direct object references.
 *
 * You control what "value" and agent position mean by choosing which
 * attribute tag(s) to download and pass in - this header does not assume
 * any predefined attribute layout beyond what MASS CUDA itself guarantees
 * (row-major place indices, first dimension fastest).
 *
 * This adapter is plain C++: it includes no mass_cuda_core header, so it
 * builds with g++ and pulls in no CUDA or Boost. It has been compiled and run
 * against a real mass_cuda_core on a real GPU (see the README's Status
 * section).
 *
 * Two usage rules that keep the recording faithful:
 *  - Stage the position you pass to reportAgents() from AFTER
 *    Agents::manageAll(), not at the moment an agent calls migrate():
 *    migrate() only requests a migration, and manageAll() may not carry it
 *    out (e.g. an occupied destination), so a position recorded at request
 *    time can differ from where the agent really is. See
 *    ../examples/cuda-grid-demo/Walker.cu (its SYNC function, run after
 *    manageAll) for the pattern.
 *  - End the initial-state report (Place values and agent positions before
 *    any step has run) with step(-1), see ../PROTOCOL.md.
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
    // (see ../benchmark/RESULTS.md).
    void reportPlaces(const double* values, size_t numPlaces);

    // Call once per tick: `agentPlaceIndex` and `agentId` must each have
    // `numAgents` entries (e.g. from Agents::downloadAttributes<T>() on
    // whatever attribute tags your app uses to track an agent's current
    // Place row-major index and identifier). Each place index is converted
    // to a grid coordinate from the dims given to openGrid (first dimension
    // fastest, matching place_grid's order; see coordForIndex in the .cpp for
    // why Places::getIndexVector is not used). `places` is unused - it stays
    // so existing callers keep compiling - and may be nullptr.
    void reportAgents(mass::Places* places, const int* agentPlaceIndex,
                       const long long* agentId, int numAgents);

    void step(int stepNumber);
    void close();

private:
    MassVizCuda() = default;
    void writeLine(const std::string& json);
    static std::string escape(const std::string& s);
    static std::string intVectorToJson(const std::vector<int>& values);
    // See the definition for why this doesn't just call Places::getIndexVector.
    std::vector<int> coordForIndex(int index) const;

    std::vector<int> dims_;
    std::ofstream out_;
    std::string runId_;
    std::mutex mutex_;
    bool open_ = false;

    // Tracks which agent ids were reported last call, so spawn vs move can
    // be inferred the same way the Java adapter's snapshotAgents does.
    // A set, since it is membership-tested once per agent per tick.
    std::unordered_set<long long> knownAgentIds_;
};

} // namespace massviz

#endif // MASS_VIZ_CUDA_H
