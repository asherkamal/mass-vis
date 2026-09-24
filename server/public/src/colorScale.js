// Simple sequential blue -> yellow -> red color scale over a numeric range.
// Values outside [min, max] are clamped. Returns a THREE.Color-compatible
// 0xRRGGBB integer.

const STOPS = [
  [0.0, [33, 102, 172]], // blue
  [0.5, [255, 255, 191]], // pale yellow
  [1.0, [178, 24, 43]], // red
];

function lerp(a, b, t) {
  return a + (b - a) * t;
}

export class ColorScale {
  // With no arguments the range starts empty (min > max) and is defined by
  // the first observed values, so a field spanning 20..95 gets a 20..95
  // legend rather than one forced to include 0 and 1.
  constructor(min = Infinity, max = -Infinity) {
    this.min = min;
    this.max = max;
    this.locked = false; // true once an explicit place_range event sets bounds
  }

  get isSet() {
    return this.min <= this.max;
  }

  observe(value) {
    if (this.locked || !Number.isFinite(value)) return;
    if (value < this.min) this.min = value;
    if (value > this.max) this.max = value;
  }

  setRange(min, max) {
    this.min = min;
    this.max = max;
    this.locked = true;
  }

  colorFor(value) {
    const span = this.isSet ? this.max - this.min : 0;
    const t = span > 1e-9 ? Math.min(1, Math.max(0, (value - this.min) / span)) : 0.5;

    let lo = STOPS[0];
    let hi = STOPS[STOPS.length - 1];
    for (let i = 0; i < STOPS.length - 1; i++) {
      if (t >= STOPS[i][0] && t <= STOPS[i + 1][0]) {
        lo = STOPS[i];
        hi = STOPS[i + 1];
        break;
      }
    }
    const localT = hi[0] > lo[0] ? (t - lo[0]) / (hi[0] - lo[0]) : 0;
    const r = Math.round(lerp(lo[1][0], hi[1][0], localT));
    const g = Math.round(lerp(lo[1][1], hi[1][1], localT));
    const b = Math.round(lerp(lo[1][2], hi[1][2], localT));
    return (r << 16) | (g << 8) | b;
  }
}
