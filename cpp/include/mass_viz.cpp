#include "mass_viz.h"

#include <chrono>
#include <sstream>

namespace massviz {

MassViz& MassViz::instance() {
    static MassViz singleton;
    return singleton;
}

namespace {
long long nowMillis() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}
} // namespace

std::string MassViz::escape(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (char c : s) {
        if (c == '"' || c == '\\') out += '\\';
        out += c;
    }
    return out;
}

std::string MassViz::intArrayToJson(const std::vector<int>& values) {
    std::ostringstream os;
    os << '[';
    for (size_t i = 0; i < values.size(); i++) {
        if (i) os << ',';
        os << values[i];
    }
    os << ']';
    return os.str();
}

std::string MassViz::stringArrayToJson(const std::vector<std::string>& values) {
    std::ostringstream os;
    os << '[';
    for (size_t i = 0; i < values.size(); i++) {
        if (i) os << ',';
        os << '"' << escape(values[i]) << '"';
    }
    os << ']';
    return os.str();
}

namespace {
std::string doubleArrayToJson(const std::vector<double>& values) {
    std::ostringstream os;
    os << '[';
    for (size_t i = 0; i < values.size(); i++) {
        if (i) os << ',';
        os << values[i];
    }
    os << ']';
    return os.str();
}
} // namespace

void MassViz::writeLine(const std::string& json) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!open_) return;
    out_ << json << '\n';
    out_.flush();
}

void MassViz::openGrid(const std::string& filePath, const std::string& runId,
                        const std::string& runName, const std::vector<int>& dims) {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        out_.open(filePath, std::ios::out | std::ios::trunc);
        runId_ = runId;
        open_ = out_.is_open();
        dims_ = dims;
        gridBuffer_.assign(dims.size() >= 2 ? static_cast<size_t>(dims[0]) * dims[1] : 0, 0.0);
        gridBufferDirty_ = false;
    }

    std::ostringstream os;
    os << "{\"v\":1,\"runId\":\"" << escape(runId) << "\",\"type\":\"init\",\"t\":" << nowMillis()
       << ",\"mode\":\"grid\",\"runName\":\"" << escape(runName) << "\",\"source\":\"mass-cpp\""
       << ",\"dims\":" << intArrayToJson(dims) << "}";
    writeLine(os.str());
}

void MassViz::openGraph(const std::string& filePath, const std::string& runId,
                         const std::string& runName) {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        out_.open(filePath, std::ios::out | std::ios::trunc);
        runId_ = runId;
        open_ = out_.is_open();
    }

    std::ostringstream os;
    os << "{\"v\":1,\"runId\":\"" << escape(runId) << "\",\"type\":\"init\",\"t\":" << nowMillis()
       << ",\"mode\":\"graph\",\"runName\":\"" << escape(runName) << "\",\"source\":\"mass-cpp\"}";
    writeLine(os.str());
}

void MassViz::reportPlace(const std::vector<int>& index, double value) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (index.size() >= 2 && dims_.size() >= 2) {
        size_t i = static_cast<size_t>(index[1]) * dims_[0] + index[0];
        if (i < gridBuffer_.size()) {
            gridBuffer_[i] = value;
            gridBufferDirty_ = true;
            return;
        }
    }
    // Fall back to an immediate sparse place event if dims aren't known yet
    // (openGrid not called) or the index is out of the declared grid bounds.
    if (!open_) return;
    std::ostringstream os;
    os << "{\"v\":1,\"runId\":\"" << escape(runId_) << "\",\"type\":\"place\",\"t\":" << nowMillis()
       << ",\"index\":" << intArrayToJson(index) << ",\"value\":" << value << "}";
    out_ << os.str() << '\n';
    out_.flush();
}

void MassViz::reportVertex(const std::string& id, const std::string& name,
                            const std::vector<std::string>& neighborIds) {
    std::ostringstream os;
    os << "{\"v\":1,\"runId\":\"" << escape(runId_) << "\",\"type\":\"vertex\",\"t\":" << nowMillis()
       << ",\"id\":\"" << escape(id) << "\",\"name\":\"" << escape(name) << "\""
       << ",\"neighbors\":" << stringArrayToJson(neighborIds) << "}";
    writeLine(os.str());
}

void MassViz::reportPlaceValue(const std::string& vertexId, double value) {
    std::ostringstream os;
    os << "{\"v\":1,\"runId\":\"" << escape(runId_) << "\",\"type\":\"place_value\",\"t\":" << nowMillis()
       << ",\"id\":\"" << escape(vertexId) << "\",\"value\":" << value << "}";
    writeLine(os.str());
}

void MassViz::reportAgentSpawnGrid(const std::string& id, const std::vector<int>& at) {
    std::ostringstream os;
    os << "{\"v\":1,\"runId\":\"" << escape(runId_) << "\",\"type\":\"agent_spawn\",\"t\":" << nowMillis()
       << ",\"id\":\"" << escape(id) << "\",\"at\":" << intArrayToJson(at) << "}";
    writeLine(os.str());
}

void MassViz::reportAgentSpawnGraph(const std::string& id, const std::string& at) {
    std::ostringstream os;
    os << "{\"v\":1,\"runId\":\"" << escape(runId_) << "\",\"type\":\"agent_spawn\",\"t\":" << nowMillis()
       << ",\"id\":\"" << escape(id) << "\",\"at\":\"" << escape(at) << "\"}";
    writeLine(os.str());
}

void MassViz::reportAgentMoveGrid(const std::string& id, const std::vector<int>& to) {
    std::ostringstream os;
    os << "{\"v\":1,\"runId\":\"" << escape(runId_) << "\",\"type\":\"agent_move\",\"t\":" << nowMillis()
       << ",\"id\":\"" << escape(id) << "\",\"to\":" << intArrayToJson(to) << "}";
    writeLine(os.str());
}

void MassViz::reportAgentMoveGraph(const std::string& id, const std::string& to) {
    std::ostringstream os;
    os << "{\"v\":1,\"runId\":\"" << escape(runId_) << "\",\"type\":\"agent_move\",\"t\":" << nowMillis()
       << ",\"id\":\"" << escape(id) << "\",\"to\":\"" << escape(to) << "\"}";
    writeLine(os.str());
}

void MassViz::reportAgentRemove(const std::string& id) {
    std::ostringstream os;
    os << "{\"v\":1,\"runId\":\"" << escape(runId_) << "\",\"type\":\"agent_remove\",\"t\":" << nowMillis()
       << ",\"id\":\"" << escape(id) << "\"}";
    writeLine(os.str());
}

std::string MassViz::flushGridBufferLocked() {
    if (!gridBufferDirty_) return std::string();
    gridBufferDirty_ = false;
    std::ostringstream grid;
    grid << "{\"v\":1,\"runId\":\"" << escape(runId_) << "\",\"type\":\"place_grid\",\"t\":" << nowMillis()
         << ",\"values\":" << doubleArrayToJson(gridBuffer_) << "}";
    return grid.str();
}

void MassViz::step(int stepNumber) {
    // Flush the grid buffer accumulated by reportPlace() calls this tick as
    // one compact place_grid event, before the step marker - see
    // reportPlace()'s comment in mass_viz.h for why this is safe under the
    // documented per-tick usage pattern. The buffer is read and the JSON
    // built while still holding the lock, since MASS C++ supports
    // multithreaded place processing (Mthread/initializeThreads) -
    // reportPlace() can be writing into gridBuffer_ from another thread
    // right up until this tick's calls are done, so reading its contents
    // must not happen outside the same lock reportPlace() writes under.
    std::string gridJson;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        gridJson = flushGridBufferLocked();
    }
    if (!gridJson.empty()) writeLine(gridJson);

    std::ostringstream os;
    os << "{\"v\":1,\"runId\":\"" << escape(runId_) << "\",\"type\":\"step\",\"t\":" << nowMillis()
       << ",\"step\":" << stepNumber << "}";
    writeLine(os.str());
}

void MassViz::close() {
    // Flush any grid data reported since the last step() so it isn't
    // silently lost if an app closes mid-tick without calling step() first.
    std::string gridJson;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        gridJson = flushGridBufferLocked();
    }
    if (!gridJson.empty()) writeLine(gridJson);

    std::lock_guard<std::mutex> lock(mutex_);
    if (open_) {
        out_.close();
        open_ = false;
    }
}

} // namespace massviz
