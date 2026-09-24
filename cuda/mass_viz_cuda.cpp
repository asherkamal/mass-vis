#include "mass_viz_cuda.h"

#include <chrono>
#include <cmath>
#include <iomanip>
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
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                // Raw control characters are illegal inside a JSON string
                // (RFC 8259) - see the identical note in ../cpp/include/mass_viz.cpp.
                if (static_cast<unsigned char>(c) < 0x20) {
                    static const char* HEX = "0123456789abcdef";
                    out += "\\u00";
                    out += HEX[(static_cast<unsigned char>(c) >> 4) & 0xF];
                    out += HEX[static_cast<unsigned char>(c) & 0xF];
                } else {
                    out += c;
                }
        }
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
// NaN/Infinity have no JSON literal - streaming one emits a bare `nan`/`inf`
// token, which is invalid JSON, so the server drops the whole event and the
// viewer silently stops updating. Emit `null`, which the renderers skip. See
// the fuller note in ../cpp/include/mass_viz.cpp. Precision raised from
// ostream's default 6 significant digits to 9 (float round-trip exact);
// trailing zeros are still dropped, so ordinary values cost no extra bytes.
void writeNumber(std::ostringstream& os, double value) {
    if (!std::isfinite(value)) {
        os << "null";
        return;
    }
    os << value;
}

std::string doubleArrayToJson(const double* values, size_t n) {
    std::ostringstream os;
    os << std::setprecision(9) << '[';
    for (size_t i = 0; i < n; i++) {
        if (i) os << ',';
        writeNumber(os, values[i]);
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
        dims_ = dims;
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

// A place index -> grid coordinate, with the FIRST dimension varying fastest
// (x = index % width, y = index / width). That is the order mass_cuda_core
// itself lays places out in (its relative-neighbor offsets step x by 1 and y
// by width), the order downloadAttributes returns them in, and the protocol's
// place_grid order - so agents land on the same cell as the values around them.
//
// Places::getIndexVector is deliberately NOT used: it decodes with the LAST
// dimension fastest, which only agrees on square grids. On e.g. a 16x10 grid it
// draws every agent in the wrong cell (measured: moves of "distance 7" for
// agents that only ever step to a neighbor).
std::vector<int> MassVizCuda::coordForIndex(int index) const {
    std::vector<int> coord(dims_.size());
    for (size_t d = 0; d < dims_.size(); d++) {
        coord[d] = dims_[d] > 0 ? index % dims_[d] : 0;
        index = dims_[d] > 0 ? index / dims_[d] : index;
    }
    return coord;
}

void MassVizCuda::reportAgents(mass::Places* /*places*/, const int* agentPlaceIndex,
                                const long long* agentId, int numAgents) {
    std::unordered_set<long long> seen;
    seen.reserve(static_cast<size_t>(numAgents));

    for (int i = 0; i < numAgents; i++) {
        long long id = agentId[i];
        seen.insert(id);
        std::vector<int> coord = coordForIndex(agentPlaceIndex[i]);
        bool known = knownAgentIds_.count(id) != 0;

        std::ostringstream os;
        os << "{\"v\":1,\"runId\":\"" << escape(runId_) << "\",\"type\":\""
           << (known ? "agent_move" : "agent_spawn") << "\",\"t\":" << nowMillis()
           << ",\"id\":\"" << id << "\",\"" << (known ? "to" : "at") << "\":" << intVectorToJson(coord)
           << "}";
        writeLine(os.str());
    }

    for (long long id : knownAgentIds_) {
        if (seen.count(id) == 0) {
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
