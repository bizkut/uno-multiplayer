/**
 * Sound Effects using Web Audio API
 * No external audio files needed — generates tones programmatically.
 */
class SoundFX {
  constructor() {
    this.ctx = null;
    this.enabled = true;
  }

  init() {
    if (this.ctx) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
      console.warn('Web Audio not supported');
      this.enabled = false;
    }
  }

  _tone(frequency, duration, type = 'sine', volume = 0.15) {
    if (!this.enabled) return;
    if (!this.ctx) this.init();
    if (!this.ctx) return;

    // Resume context if suspended (browser auto-play policy)
    if (this.ctx.state === 'suspended') this.ctx.resume();

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(volume, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(this.ctx.currentTime);
    osc.stop(this.ctx.currentTime + duration);
  }

  cardPlay() {
    this._tone(900, 0.08, 'square', 0.1);
    setTimeout(() => this._tone(1300, 0.06, 'square', 0.08), 60);
  }

  cardDraw() {
    this._tone(350, 0.12, 'triangle', 0.1);
    setTimeout(() => this._tone(450, 0.08, 'triangle', 0.08), 80);
  }

  yourTurn() {
    this._tone(523, 0.12, 'sine', 0.12);   // C5
    setTimeout(() => this._tone(659, 0.12, 'sine', 0.12), 130);  // E5
    setTimeout(() => this._tone(784, 0.18, 'sine', 0.15), 260);  // G5
  }

  unoCall() {
    this._tone(880, 0.08, 'square', 0.12);
    setTimeout(() => this._tone(1100, 0.08, 'square', 0.12), 80);
    setTimeout(() => this._tone(1400, 0.2, 'square', 0.15), 160);
  }

  win() {
    const notes = [523, 659, 784, 1047, 1319, 1568];
    notes.forEach((f, i) => {
      setTimeout(() => this._tone(f, 0.25, 'sine', 0.12), i * 150);
    });
  }

  error() {
    this._tone(180, 0.25, 'sawtooth', 0.08);
  }

  skip() {
    this._tone(600, 0.1, 'triangle', 0.1);
    setTimeout(() => this._tone(300, 0.15, 'triangle', 0.08), 100);
  }

  reverse() {
    this._tone(700, 0.1, 'sine', 0.1);
    setTimeout(() => this._tone(500, 0.1, 'sine', 0.1), 100);
    setTimeout(() => this._tone(700, 0.15, 'sine', 0.12), 200);
  }

  drawPenalty() {
    this._tone(300, 0.1, 'sawtooth', 0.08);
    setTimeout(() => this._tone(250, 0.1, 'sawtooth', 0.08), 120);
    setTimeout(() => this._tone(200, 0.2, 'sawtooth', 0.06), 240);
  }

  buttonClick() {
    this._tone(1000, 0.04, 'sine', 0.06);
  }
}

// Global instance
const sfx = new SoundFX();
