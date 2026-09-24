// Client-side mirror of server.js's RunState/applyEvent. Replay uses it to
// build keyframes (full-state snapshots every N steps) while loading a
// recording, so a backward seek restores the nearest keyframe and replays at
// most N steps of events instead of the entire history since step 0.
//
// toSnapshot() produces the same shape as the server's `snapshot` message
// state, except dense grid values stay a flat `gridValues` array (the
// renderer's setPlaceGrid takes exactly that) instead of one object per cell.
export class RunState {
  constructor() {
    this.mode = null;
    this.dims = null;
    this.source = null;
    this.runName = null;
    this.runId = null;
    this.placeRange = null;
    this.gridValues = null; // flat row-major array, from place_grid
    this.places = new Map(); // "x,y" -> {index, value}, from sparse place events
    this.vertices = new Map(); // id -> vertex event (never mutated once stored)
    this.placeValues = new Map(); // id -> value
    this.agents = new Map(); // id -> {id, at, color, shape, name, attrs}
    this.lastStep = null;
  }

  // Rebuilds a state from a server-side snapshot (a windowed replay's leading
  // `snapshot` line, see server.js): cells arrive as a `places` list.
  static fromSnapshot(st) {
    const r = new RunState();
    r.mode = st.mode;
    r.dims = st.dims || null;
    r.source = st.source || null;
    r.runId = st.runId;
    r.runName = st.runName;
    r.placeRange = st.placeRange ? { ...st.placeRange } : null;
    r.lastStep = st.lastStep ?? null;
    if (st.gridValues) r.gridValues = st.gridValues.slice();
    const places = st.places || [];
    if (r.mode === 'grid' && r.dims && places.length) {
      const [w, h] = r.dims;
      if (!r.gridValues) r.gridValues = new Array(w * h).fill(null);
      for (const p of places) {
        if (Array.isArray(p.index) && Number.isFinite(p.value)) r.gridValues[p.index[1] * w + p.index[0]] = p.value;
      }
    } else {
      for (const p of places) if (Array.isArray(p.index)) r.places.set(p.index.join(','), p);
    }
    for (const v of st.vertices || []) r.vertices.set(String(v.id), v);
    for (const pv of st.placeValues || []) r.placeValues.set(String(pv.id), pv.value);
    for (const a of st.agents || []) r.agents.set(String(a.id), { ...a });
    return r;
  }

  apply(event) {
    switch (event.type) {
      case 'init':
        this.mode = event.mode;
        this.dims = event.dims || null;
        this.source = event.source || null;
        this.runId = event.runId;
        this.runName = event.runName || event.runId;
        this.placeRange = null;
        this.gridValues = null;
        this.places.clear();
        this.vertices.clear();
        this.placeValues.clear();
        this.agents.clear();
        this.lastStep = null;
        break;
      case 'place':
        if (Array.isArray(event.places)) {
          for (const p of event.places) {
            if (p && Array.isArray(p.index)) this.places.set(p.index.join(','), p);
          }
        } else if (Array.isArray(event.index)) {
          this.places.set(event.index.join(','), { index: event.index, value: event.value });
        }
        break;
      case 'place_grid':
        if (Array.isArray(event.values)) {
          if (!this.gridValues || this.gridValues.length !== event.values.length) {
            this.gridValues = new Array(event.values.length).fill(null);
          }
          // A null/non-finite entry carries no information; keep the last known value.
          for (let i = 0; i < event.values.length; i++) {
            if (Number.isFinite(event.values[i])) this.gridValues[i] = event.values[i];
          }
        }
        break;
      case 'place_range':
        this.placeRange = { min: event.min, max: event.max };
        break;
      case 'vertex':
        this.vertices.set(String(event.id), event);
        break;
      case 'place_value':
        this.placeValues.set(String(event.id), event.value);
        break;
      case 'agent_spawn':
        this.agents.set(String(event.id), {
          id: event.id,
          at: event.at,
          color: event.color,
          shape: event.shape,
          name: event.name,
          attrs: event.attrs,
        });
        break;
      case 'agent_move': {
        const agent = this.agents.get(String(event.id));
        if (agent) agent.at = event.to;
        break;
      }
      case 'agent_update': {
        const agent = this.agents.get(String(event.id));
        if (agent) {
          if (event.color !== undefined) agent.color = event.color;
          if (event.name !== undefined) agent.name = event.name;
          if (event.attrs) agent.attrs = Object.assign({}, agent.attrs, event.attrs);
        }
        break;
      }
      case 'agent_remove':
        this.agents.delete(String(event.id));
        break;
      case 'step':
        this.lastStep = event.step;
        break;
      default:
        break;
    }
  }

  // Independent copy: later apply() calls on this instance must not leak into
  // a stored keyframe. Vertex events are immutable once stored, so the Map is
  // copied but its values are shared; agents are mutated in place, so those
  // objects are copied too.
  clone() {
    const c = new RunState();
    c.mode = this.mode;
    c.dims = this.dims;
    c.source = this.source;
    c.runName = this.runName;
    c.runId = this.runId;
    c.placeRange = this.placeRange ? { ...this.placeRange } : null;
    c.gridValues = this.gridValues ? this.gridValues.slice() : null;
    c.places = new Map(this.places);
    c.vertices = new Map(this.vertices);
    c.placeValues = new Map(this.placeValues);
    for (const [id, a] of this.agents) c.agents.set(id, { ...a });
    c.lastStep = this.lastStep;
    return c;
  }

  toSnapshot() {
    return {
      runId: this.runId,
      mode: this.mode,
      dims: this.dims,
      source: this.source,
      runName: this.runName,
      placeRange: this.placeRange,
      gridValues: this.gridValues,
      places: Array.from(this.places.values()),
      vertices: Array.from(this.vertices.values()),
      placeValues: Array.from(this.placeValues.entries()).map(([id, value]) => ({ id, value })),
      agents: Array.from(this.agents.values()),
      lastStep: this.lastStep,
    };
  }
}
