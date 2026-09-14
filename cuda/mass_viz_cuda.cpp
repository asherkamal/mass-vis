#include "mass_viz_cuda.h"

#include <algorithm>
#include <chrono>
#include <sstream>

namespace massviz {

MassVizCuda& MassVizCuda::instance() {
    static MassVizCuda singleton;
    return singleton;
}

namespace {
long long nowMillis() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}
} // namespace

std::string MassVizCuda::escape(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (char c : s) {
        if (c == '"' || c == '\\') out += '\\';
        out += c;
    }
    return out;
}

std::string MassVizCuda::intVectorToJson(const std::vector<int>& values) {
    std::ostringstream os;
    os << '[';
    for (size_t i = 0; i < values.size(); i++) {
        if (i) os << ',';
        os << values[i];
    }
    os << ']';
    return os.str();
}

namespace {
std::string doubleArrayToJson(const double* values, size_t n) {
    std::ostringstream os;
    os << '[';
    for (size_t i = 0; i < n; i++) {
        if (i) os << ',';
        os << values[i];
    }
    os << ']';
    return os.str();
}
} // namespace

void MassVizCuda::writeLine(const std::string& json) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!open_) return;
    out_ << json << '\n';
    out_.flush();
}

void MassVizCuda::openGrid(const std::string& filePath, const std::string& runId,
                            const std::string& runName, const std::vector<int>& dims) {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        out_.open(filePath, std::ios::out | std::ios::trunc);
        runId_ = runId;
        open_ = out_.is_open();
        knownAgentIds_.clear();
    }

    std::ostringstream os;
    os << "{\"v\":1,\"runId\":\"" << escape(runId) << "\",\"type\":\"init\",\"t\":" << nowMillis()
       << ",\"mode\":\"grid\",\"runName\":\"" << escape(runName) << "\",\"source\":\"mass-cuda\""
       << ",\"dims\":" << intVectorToJson(dims) << "}";
    writeLine(os.str());
}

void MassVizCuda::reportPlaces(const double* values, size_t numPlaces) {
    std::ostringstream os;
    os << "{\"v\":1,\"runId\":\"" << escape(runId_) << "\",\"type\":\"place_grid\",\"t\":" << nowMillis()
       << ",\"values\":" << doubleArrayToJson(values, numPlaces) << "}";
    writeLine(os.str());
}

void MassVizCuda::reportAgents(mass::Places* places, const int* agentPlaceIndex,
                                const long long* agentId, int numAgents) {
    std::vector<long long> seen;
    seen.reserve(numAgents);

    for (int i = 0; i < numAgents; i++) {
        long long id = agentId[i];
        seen.push_back(id);
        std::vector<int> coord = places->getIndexVector(agentPlaceIndex[i]);
        bool known = std::find(knownAgentIds_.begin(), knownAgentIds_.end(), id) != knownAgentIds_.end();

        std::ostringstream os;
        os << "{\"v\":1,\"runId\":\"" << escape(runId_) << "\",\"type\":\""
           << (known ? "agent_move" : "agent_spawn") << "\",\"t\":" << nowMillis()
           << ",\"id\":\"" << id << "\",\"" << (known ? "to" : "at") << "\":" << intVectorToJson(coord)
           << "}";
        writeLine(os.str());
    }

    for (long long id : knownAgentIds_) {
        if (std::find(seen.begin(), seen.end(), id) == seen.end()) {
            std::ostringstream os;
            os << "{\"v\":1,\"runId\":\"" << escape(runId_) << "\",\"type\":\"agent_remove\",\"t\":"
               << nowMillis() << ",\"id\":\"" << id << "\"}";
            writeLine(os.str());
        }
    }

    knownAgentIds_ = std::move(seen);
}

void MassVizCuda::step(int stepNumber) {
    std::ostringstream os;
    os << "{\"v\":1,\"runId\":\"" << escape(runId_) << "\",\"type\":\"step\",\"t\":" << nowMillis()
       << ",\"step\":" << stepNumber << "}";
    writeLine(os.str());
}

void MassVizCuda::close() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (open_) {
        out_.close();
        open_ = false;
    }
}

} // namespace massviz
