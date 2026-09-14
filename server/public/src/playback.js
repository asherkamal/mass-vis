// Binds the replay transport controls (play/pause, step slider, speed) to a
// RunConnection instance. Only relevant in replay mode; live mode hides
// this panel entirely since there is nothing to scrub.
export class PlaybackControls {
  constructor(connection, { panelEl, playPauseBtn, slider, stepLabel, speedSelect }) {
    this.connection = connection;
    this.panelEl = panelEl;
    this.playPauseBtn = playPauseBtn;
    this.slider = slider;
    this.stepLabel = stepLabel;
    this.speedSelect = speedSelect;
    this.playing = false;

    this.playPauseBtn.addEventListener('click', () => this.togglePlay());
    this.slider.addEventListener('input', () => {
      this.setPlaying(false);
      this.connection.seekStep(Number(this.slider.value));
      this.refreshLabel();
    });
    // Changing speed while already playing had no effect until Pause+Play
    // again - connection.play() only reads the dropdown's value at the
    // moment setPlaying(true) runs, and nothing re-invoked it on change.
    // Calls connection.play() directly (not setPlaying(true)) since that
    // would also re-create this._syncTimer without clearing the existing
    // one first, leaking an interval every time the speed is changed.
    this.speedSelect.addEventListener('change', () => {
      if (this.playing) this.connection.play(Number(this.speedSelect.value) || 2);
    });
  }

  showForReplay() {
    this.panelEl.classList.add('active');
    this.slider.max = String(Math.max(0, this.connection.stepCount - 1));
    this.slider.value = String(this.connection.currentStep);
    this.refreshLabel();
  }

  hide() {
    this.setPlaying(false);
    this.panelEl.classList.remove('active');
  }

  togglePlay() {
    this.setPlaying(!this.playing);
  }

  setPlaying(playing) {
    this.playing = playing;
    this.playPauseBtn.textContent = playing ? 'Pause' : 'Play';
    if (playing) {
      const speed = Number(this.speedSelect.value) || 2;
      this.connection.play(speed);
      this._syncTimer = setInterval(() => this.onExternalStep(), 150);
    } else {
      this.connection.pause();
      if (this._syncTimer) clearInterval(this._syncTimer);
    }
  }

  // Called on a timer while playing so the slider tracks connection.currentStep,
  // and also invoked manually after a programmatic seek.
  onExternalStep() {
    this.slider.value = String(this.connection.currentStep);
    this.refreshLabel();
    if (this.connection.currentStep >= this.connection.stepCount - 1) {
      this.setPlaying(false);
    }
  }

  refreshLabel() {
    this.stepLabel.textContent = `step ${this.connection.currentStep + 1} / ${this.connection.stepCount}`;
  }
}
