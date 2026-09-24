import { RunState } from './runState.js';
import { parseJsonTolerant } from './json.js';

// Steps between full-state keyframes built while loading a replay.
const KEYFRAME_EVERY = 50;

// Data layer: either a live WebSocket subscription to a running sim, or a
// client-side replay of a recorded .ndjson file. Both funnel through the
// same onReset/onEvent callbacks so app.js doesn't need to know which mode
// is active.
//
// A live run can be paused/stopped into a replay of what the server has
// recorded so far (the server records every event and flushes before serving
// a recording), and returned to live by reconnecting - the client never
// buffers a live stream itself, so memory stays constant however long it runs.
export class RunConnection {
  constructor({ onReset, onEvent, onLiveClosed }) {
    this.onReset = onReset;
    this.onEvent = onEvent;
    this.onLiveClosed = onLiveClosed || (() => {});
    this.mode = null; // "live" | "replay"
    this.runId = null;
    this.ws = null;
    this.replayEvents = [];
    // frameEnds[k] = index into replayEvents of the k-th `step` marker (the
    // last event of frame k). A recording with no step markers is one frame.
    this.frameEnds = [];
    this.keyframes = new Map(); // frame index -> RunState after that frame
    this.baseState = null; // windowed load: the server's snapshot preceding replayEvents
    this.windowInfo = null; // windowed load: {baseFrame, totalFrames}
    this.tail = 0;
    this.skippedLines = 0;
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
    this.runId = runId;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
    this.ws = ws;
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'watch', runId }));
    });
    ws.addEventListener('message', (msg) => {
      let event;
      try {
        event = JSON.parse(msg.data);
      } catch (e) {
        return; // never let one bad frame kill the live view
      }
      if (event.type === 'snapshot') {
        this.onReset(event.state);
      } else {
        this.onEvent(event);
      }
    });
    ws.addEventListener('close', () => {
      if (this.ws === ws) {
        this.ws = null;
        this.onLiveClosed();
      }
    });
  }

  // Loads the server's recording of `runId`, then seeks to `frame` (a frame of
  // what was loaded), or `absoluteFrame` (a frame counted from the start of
  // the run), defaulting to the last completed step. Builds keyframes in the
  // same pass.
  //
  // `tail` > 0 asks the server for only about the last `tail` steps: it
  // answers with a leading `snapshot` line (the state at some earlier frame)
  // followed by the events after it, so a long run doesn't have to be shipped
  // whole. A run no longer than `tail` steps, or one the server can't window,
  // comes back complete. `windowInfo` says which happened.
  async loadReplay(runId, { frame, absoluteFrame, tail } = {}) {
    this.disconnect();
    this.mode = 'replay';
    this.runId = runId;
    this.tail = tail || 0;
    const query = this.tail > 0 ? `?tail=${this.tail}` : '';
    const res = await fetch(`/recordings/${encodeURIComponent(runId)}.ndjson${query}`);
    if (!res.ok) throw new Error(`no recording for ${runId}`);
    const text = await res.text();

    this.replayEvents = [];
    this.baseState = null;
    this.windowInfo = null;
    this.skippedLines = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let event;
      try {
        event = parseJsonTolerant(line);
      } catch (e) {
        this.skippedLines++; // one corrupt line must not fail the whole recording
        continue;
      }
      if (event.type === 'snapshot' && !this.baseState && this.replayEvents.length === 0) {
        this.baseState = RunState.fromSnapshot(event.state);
        this.windowInfo = { baseFrame: event.baseFrame, totalFrames: event.totalFrames };
        continue;
      }
      this.replayEvents.push(event);
    }
    if (this.replayEvents.length === 0 && !this.baseState) throw new Error(`recording for ${runId} has no readable events`);

    await this._indexFrames();
    let target = frame;
    if (absoluteFrame !== undefined) target = absoluteFrame - (this.windowInfo ? this.windowInfo.baseFrame : 0);
    this.currentStep = -1; // forces the first seek to restore a keyframe (a full scene reset)
    this.seekStep(target === undefined ? this.frameEnds.length - 1 : target);
  }

  // A frame's index counted from the start of the run rather than from the
  // start of the loaded window.
  absoluteFrame(localFrame) {
    return localFrame + (this.windowInfo ? this.windowInfo.baseFrame : 0);
  }

  // "step 12 / 340", counted from the start of the run even when windowed.
  frameLabel() {
    const total = this.windowInfo ? this.windowInfo.totalFrames : this.frameEnds.length;
    const shown = this.absoluteFrame(this.currentStep) + 1;
    return this.windowInfo ? `step ${shown} / ${total} (last ${this.frameEnds.length} loaded)` : `step ${shown} / ${total}`;
  }

  // One pass over the events: locate frame boundaries and snapshot the run
  // state every KEYFRAME_EVERY frames. Yields to the event loop periodically
  // so a very large recording doesn't freeze the page while indexing.
  async _indexFrames() {
    this.frameEnds = [];
    this.keyframes = new Map();
    const events = this.replayEvents;
    const state = this.baseState ? this.baseState.clone() : new RunState();
    if (this.baseState) {
      // Windowed load: frame 0 is the server's snapshot itself (no events).
      this.frameEnds.push(-1);
      this.keyframes.set(0, state.clone());
    }
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      state.apply(e);
      if (e.type === 'step') {
        const frame = this.frameEnds.length;
        this.frameEnds.push(i);
        if (frame % KEYFRAME_EVERY === 0) this.keyframes.set(frame, state.clone());
      }
      if (i % 200000 === 199999) await new Promise((r) => setTimeout(r, 0));
    }
    if (this.frameEnds.length === 0) {
      // No step markers at all: treat the whole recording as a single frame.
      this.frameEnds.push(events.length - 1);
      this.keyframes.set(0, state.clone());
    }
  }

  get stepCount() {
    return this.frameEnds.length;
  }

  _frameStart(frame) {
    return frame > 0 ? this.frameEnds[frame - 1] + 1 : 0;
  }

  seekStep(stepIndex) {
    if (this.mode !== 'replay' || this.frameEnds.length === 0) return;
    stepIndex = Math.max(0, Math.min(stepIndex, this.frameEnds.length - 1));
    if (stepIndex === this.currentStep) return;

    // Nearest keyframe at or before the target. Going forward from a
    // position that is already close, just apply the events in between on
    // top of the current scene (the common Play case); anything else - a
    // backward jump, or a forward jump longer than a keyframe interval -
    // restores the keyframe and replays at most KEYFRAME_EVERY frames.
    const kf = Math.floor(stepIndex / KEYFRAME_EVERY) * KEYFRAME_EVERY;
    let from;
    if (stepIndex > this.currentStep && this.currentStep >= kf) {
      from = this._frameStart(this.currentStep + 1);
    } else {
      this.onReset(this.keyframes.get(kf).toSnapshot());
      from = this._frameStart(kf + 1);
    }

    // Only the target frame's own events animate (agent lerp); everything
    // skipped over while catching up is fast-forwarded history, applied instantly.
    const to = this.frameEnds[stepIndex];
    const lastFrameStart = this._frameStart(stepIndex);
    this.currentStep = stepIndex;
    for (let i = from; i <= to; i++) {
      this.onEvent(this.replayEvents[i], { instant: i < lastFrameStart });
    }
  }

  play(stepsPerSecond = 2) {
    this.pause();
    this._playTimer = setInterval(() => {
      if (this.currentStep >= this.frameEnds.length - 1) {
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
      const ws = this.ws;
      this.ws = null; // cleared first so the close handler doesn't report a drop
      ws.close();
    }
  }
}
