// Data layer: either a live WebSocket subscription to a running sim, or a
// client-side replay of a recorded .ndjson file. Both funnel through the
// same onReset/onEvent callbacks so app.js doesn't need to know which mode
// is active.
export class RunConnection {
  constructor({ onReset, onEvent }) {
    this.onReset = onReset;
    this.onEvent = onEvent;
    this.mode = null; // "live" | "replay"
    this.ws = null;
    this.replayEvents = [];
    this.stepBoundaries = []; // index into replayEvents where a "step" event lands
    this.currentStep = -1;
    this._playTimer = null;
  }

  async listRuns() {
    const res = await fetch('/recordings');
    const data = await res.json();
    return data.recordings;
  }

  connectLive(runId) {
    this.disconnect();
    this.mode = 'live';
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}`);
    this.ws.addEventListener('open', () => {
      this.ws.send(JSON.stringify({ type: 'watch', runId }));
    });
    this.ws.addEventListener('message', (msg) => {
      const event = JSON.parse(msg.data);
      if (event.type === 'snapshot') {
        this.onReset(event.state);
      } else {
        this.onEvent(event);
      }
    });
  }

  async loadReplay(runId) {
    this.disconnect();
    this.mode = 'replay';
    const res = await fetch(`/recordings/${encodeURIComponent(runId)}.ndjson`);
    const text = await res.text();
    this.replayEvents = text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
    this.stepBoundaries = [];
    this.replayEvents.forEach((e, i) => {
      if (e.type === 'step') this.stepBoundaries.push(i);
    });
    this.currentStep = -1;
    this.onReset(null);
    this.seekStep(this.stepBoundaries.length - 1);
  }

  get stepCount() {
    return this.stepBoundaries.length;
  }

  seekStep(stepIndex) {
    if (this.mode !== 'replay') return;
    stepIndex = Math.max(0, Math.min(stepIndex, this.stepBoundaries.length - 1));
    if (stepIndex === this.currentStep || this.stepBoundaries.length === 0) return;

    // Moving forward (Play advancing tick by tick, or dragging the slider
    // ahead) is the common case - the renderer already holds the correct
    // state for `currentStep`, so just apply the events between there and
    // the target on top of it, rather than rebuilding the whole scene from
    // scratch and replaying every event since 0. This is O(new steps x
    // cells) instead of O(steps-so-far x cells) per call: without this, a
    // large recording (e.g. 150x150 x 400 steps) ground to a crawl well
    // before reaching the end, because each tick was redoing all previous
    // ticks' work on top of its own. Only the newest step's own events
    // animate (agent lerp); everything skipped over while catching up is
    // fast-forwarded history, applied instantly.
    if (stepIndex > this.currentStep) {
      const from = this.currentStep >= 0 ? this.stepBoundaries[this.currentStep] + 1 : 0;
      const to = this.stepBoundaries[stepIndex];
      const lastStepStart = stepIndex > 0 ? this.stepBoundaries[stepIndex - 1] + 1 : 0;
      this.currentStep = stepIndex;
      for (let i = from; i <= to; i++) {
        this.onEvent(this.replayEvents[i], { instant: i < lastStepStart });
      }
      return;
    }

    // Backward jump - no shortcut, since state can't be incrementally
    // "undone". Rebuild from scratch and replay history up to the target.
    // Events up through the *previous* step boundary are fast-forwarded
    // history, applied instantly (no agent lerp); only the target step's
    // own events animate.
    this.currentStep = stepIndex;
    const endEventIndex = this.stepBoundaries[stepIndex];
    const historyEndIndex = stepIndex > 0 ? this.stepBoundaries[stepIndex - 1] : -1;
    this.onReset(null);
    for (let i = 0; i <= endEventIndex; i++) {
      this.onEvent(this.replayEvents[i], { instant: i <= historyEndIndex });
    }
  }

  play(stepsPerSecond = 2) {
    this.pause();
    this._playTimer = setInterval(() => {
      if (this.currentStep >= this.stepBoundaries.length - 1) {
        this.pause();
        return;
      }
      this.seekStep(this.currentStep + 1);
    }, 1000 / stepsPerSecond);
  }

  pause() {
    if (this._playTimer) {
      clearInterval(this._playTimer);
      this._playTimer = null;
    }
  }

  disconnect() {
    this.pause();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
