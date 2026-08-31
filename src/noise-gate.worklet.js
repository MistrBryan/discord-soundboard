// Noise gate, running on the audio thread.
//
// This sits on the microphone path only — upstream of where the mic meets the
// clips — which is the thing Discord cannot do. Discord receives one blended
// stream and cannot tell your voice from a clip, so its noise suppression has to
// be off or it mangles the clips. Here the clips are simply not in this signal.
//
// A gate is not spectral suppression: it removes room tone, fan, and keyboard
// noise *between* words rather than during them. That covers most of what a
// condenser mic in a quiet room actually needs.

const SILENCE = 1e-7; // floor for the dB conversion, well below any real signal

class NoiseGateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // Signal below this opens nothing; above it, the gate opens.
      { name: "threshold", defaultValue: -50, minValue: -100, maxValue: 0, automationRate: "k-rate" },
      // Re-close is deliberately lower than `threshold` so a voice hovering near
      // the threshold does not chatter the gate open and shut on every syllable.
      { name: "hysteresis", defaultValue: 6, minValue: 0, maxValue: 30, automationRate: "k-rate" },
      { name: "attackMs", defaultValue: 5, minValue: 0.1, maxValue: 200, automationRate: "k-rate" },
      { name: "releaseMs", defaultValue: 180, minValue: 10, maxValue: 2000, automationRate: "k-rate" },
      // How long the gate stays open after the signal drops. Without this, the
      // quiet tail of a word gets chopped off.
      { name: "holdMs", defaultValue: 120, minValue: 0, maxValue: 1000, automationRate: "k-rate" },
      { name: "bypass", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    this.envelope = 0; // smoothed signal level, linear
    this.gain = 0; // current gate gain, 0..1
    this.holdRemaining = 0; // seconds
    this.meterCounter = 0;
    this.meterPeak = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;

    const frames = input[0].length;
    const dt = 1 / sampleRate;

    const bypass = parameters.bypass[0] >= 0.5;
    const openLevel = 10 ** (parameters.threshold[0] / 20);
    const closeLevel = 10 ** ((parameters.threshold[0] - parameters.hysteresis[0]) / 20);
    const hold = parameters.holdMs[0] / 1000;

    // Per-sample coefficients for exponential approach to the target gain.
    const attack = Math.exp(-dt / Math.max(0.0001, parameters.attackMs[0] / 1000));
    const release = Math.exp(-dt / Math.max(0.0001, parameters.releaseMs[0] / 1000));
    // Envelope follower: fast up, slow down, so a transient opens the gate
    // immediately but a brief pause does not slam it shut.
    const envAttack = Math.exp(-dt / 0.002);
    const envRelease = Math.exp(-dt / 0.08);

    for (let frame = 0; frame < frames; frame++) {
      // Detect on the loudest channel so a quiet side of a stereo mic cannot
      // hold the gate closed over speech.
      let level = 0;
      for (let ch = 0; ch < input.length; ch++) {
        const v = Math.abs(input[ch][frame]);
        if (v > level) level = v;
      }

      const coefficient = level > this.envelope ? envAttack : envRelease;
      this.envelope = level + (this.envelope - level) * coefficient;

      if (this.meterPeak < this.envelope) this.meterPeak = this.envelope;

      let target;
      if (this.envelope >= openLevel) {
        target = 1;
        this.holdRemaining = hold;
      } else if (this.envelope >= closeLevel || this.holdRemaining > 0) {
        // Inside the hysteresis band, or still holding: keep whatever the gate
        // is currently doing rather than forcing a decision.
        target = this.gain > 0.5 ? 1 : 0;
        if (this.holdRemaining > 0) this.holdRemaining -= dt;
      } else {
        target = 0;
      }

      const gainCoefficient = target > this.gain ? attack : release;
      this.gain = target + (this.gain - target) * gainCoefficient;

      const applied = bypass ? 1 : this.gain;
      for (let ch = 0; ch < output.length; ch++) {
        output[ch][frame] = (input[ch] ? input[ch][frame] : 0) * applied;
      }
    }

    // Report roughly 20 times a second — enough for a smooth meter, far less
    // traffic than posting on every 128-sample render quantum.
    this.meterCounter += frames;
    if (this.meterCounter >= sampleRate / 20) {
      this.meterCounter = 0;
      this.port.postMessage({
        level: this.meterPeak > SILENCE ? 20 * Math.log10(this.meterPeak) : -100,
        open: this.gain > 0.5,
      });
      this.meterPeak = 0;
    }

    return true;
  }
}

registerProcessor("noise-gate", NoiseGateProcessor);
