#ifndef MASS_VIZ_H
#define MASS_VIZ_H

#include <string>
#include <vector>
#include <fstream>
#include <mutex>

namespace massviz {

/**
 * Records mass-viz protocol events (see ../../PROTOCOL.md) to an NDJSON
 * file for MASS C++ cluster applications, so a run can be dropped into
 * mass-viz/server/recordings/ and viewed/replayed/scrubbed in the same
 * browser viewer used for MASS Java and MASS CUDA runs.
 *
 * WHY THIS IS A SELF-REPORTING SINGLETON, NOT A SNAPSHOT POLLER LIKE THE
 * JAVA ADAPTER: unlike mass_java_core (PlacesBase.getPlaces() / AgentsBase.
 * getAgents() are public), mass_cpp_core's Places_base/Agents_base expose
 * no public way to enumerate the Place and Agent pointers they own from
 * outside the library - Place::index/agents and Agent::index/agentId/place
 * are `protected`, readable only from within a Place/Agent subclass itself
 * (confirmed by reading Place.h, Places.h, Places_base.h, Agent.h directly).
 * So the only non-invasive hook available is: each Place/Agent subclass
 * reports itself, once per tick, from inside its own callMethod() override -
 * a couple of lines added to callMethod, not a rewrite. See ../README.md for
 * a worked example and exact build/link steps (this header cannot be
 * compiled in the environment that authored it - no CUDA/C++ toolchain with
 * mass_cpp_core's full dependency set (libssh2, NetCDF, ...) was available;
 * verify on your own build of mass_cpp_core).
 *
 * Only file-based recording is implemented for this first pass (matching
 * the "or file" option in the mass-viz protocol doc) rather than a
 * hand-rolled WebSocket client, since that could not be tested in the
 * authoring environment either. A recorded run is viewed via the browser's
 * Replay mode, which already exercises the full rendering pipeline
 * (snapshot, scrub, playback) - live streaming is a natural follow-up once
 * this file format is validated against a real run.
 */
class MassViz {
public:
    static MassViz& instance();

    // Opens recordings/<runId>.ndjson-shaped output at the given path and
    // writes the initial `init` event. Call once at startup.
    void openGrid(const std::string& filePath, const std::string& runId,
                  const std::string& runName, const std::vector<int>& dims);
    void openGraph(const std::string& filePath, const std::string& runId,
                   const std::string& runName);

    // Grid mode: call once per Place per tick, typically as the first line
    // of that Place subclass's callMethod() (or wherever it updates its own
    // value each step). Buffers into a flat grid internally rather than
    // writing immediately - flushed as a single compact place_grid event
    // (see ../../PROTOCOL.md) the next time step() is called, which the
    // documented per-tick usage pattern (every Place reports, then step()
    // once) already guarantees happens after every Place has reported for
    // this tick. Measured ~5x smaller than one place event per cell for a
    // dense full-grid update that changes every tick (see
    // ../../benchmark/RESULTS.md's Track B) - this is exactly that
    // workload, so every existing caller following the documented pattern
    // gets the size reduction for free, with no code changes needed.
    void reportPlace(const std::vector<int>& index, double value);

    // Graph mode: call reportVertex once per Place during setup (from
    // whatever adjacency your app already tracks - mass_cpp_core's own
    // GraphPlaces/VertexPlace/GraphModel API is one source for this, see
    // GraphModel.h/VertexModel.h), then reportPlaceValue per tick.
    void reportVertex(const std::string& id, const std::string& name,
                       const std::vector<std::string>& neighborIds);
    void reportPlaceValue(const std::string& vertexId, double value);

    // Call from within an Agent subclass's callMethod() on spawn/migration.
    void reportAgentSpawnGrid(const std::string& id, const std::vector<int>& at);
    void reportAgentSpawnGraph(const std::string& id, const std::string& at);
    void reportAgentMoveGrid(const std::string& id, const std::vector<int>& to);
    void reportAgentMoveGraph(const std::string& id, const std::string& to);
    void reportAgentRemove(const std::string& id);

    // Call once per tick, after all reportPlace/reportAgent* calls for that tick.
    void step(int stepNumber);

    void close();

private:
    MassViz() = default;
    void writeLine(const std::string& json);
    static std::string escape(const std::string& s);
    static std::string intArrayToJson(const std::vector<int>& values);
    static std::string stringArrayToJson(const std::vector<std::string>& values);
    // Caller must hold mutex_. Returns the place_grid JSON line if the grid
    // buffer has pending updates, or an empty string otherwise; clears the
    // dirty flag either way.
    std::string flushGridBufferLocked();

    std::ofstream out_;
    std::string runId_;
    std::mutex mutex_;
    bool open_ = false;

    // Grid-mode place buffer - see reportPlace()'s comment above.
    std::vector<int> dims_;
    std::vector<double> gridBuffer_;
    bool gridBufferDirty_ = false;
};

} // namespace massviz

#endif // MASS_VIZ_H
