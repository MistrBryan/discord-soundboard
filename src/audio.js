// The mixer.
//
// Discord has no API for injecting audio into your own microphone, so the trick
// is to become the microphone. This module blends your real mic with any playing
// clips and writes the blend to a virtual audio device (VB-CABLE's "CABLE Input").
// Discord is pointed at the other end of that cable and cannot tell the
// difference from real hardware.
//
// Two separate outputs, because they carry different things:
//
//   cable   →  mic + clips   →  what the call hears
//   monitor →  clips only    →  what YOU hear
//
// The mic is deliberately absent from the monitor path. Routing it there would
// play your own voice back into your headphones a few milliseconds late, which
// is maddening to talk over.

export const SAMPLE_RATE = 48000;

// A short fade on every start and stop. Cutting a waveform mid-cycle — which
// trimming guarantees you will do — produces an audible click otherwise.
const FADE = 0.008;

// Chromium ships AudioContext.setSinkId() and the constructor's `sinkId` option
// together, so probing for one tells us whether the other is usable.
const NATIVE_SINK = typeof AudioContext !== "undefined" && "setSinkId" in AudioContext.prototype;

// decodeAudioData resamples to the sample rate of whatever context decodes, so
// decoding happens in one fixed 48 kHz context and nowhere else. Every output
// context also runs at 48 kHz, which lets a single decoded AudioBuffer be played
// through both of them. Get this wrong and clips play back pitch-shifted.
const decodeCtx = new OfflineAudioContext(2, 1, SAMPLE_RATE);

const buffers = new Map(); // clip file name -> AudioBuffer

const state = {
  cable: null,
  monitor: null,
  micStream: null,
  micSource: null,
  micChain: null, // { highPass, gate } — mic-only processing, upstream of the clips
  micDeviceId: null,
  settings: null,
  voices: new Set(),
};

// addModule() re-evaluates the module, and registerProcessor() throws if the
// name is already taken, so each context may only be given it once.
const workletLoaded = new WeakSet();

let onMeter = null;

let warn = (message) => console.warn("[soundboard]", message);

/** Register a callback that surfaces engine problems in the UI. */
export function onWarning(fn) {
  warn = (message) => {
    console.warn("[soundboard]", message);
    fn(message);
  };
}

// --- outputs ----------------------------------------------------------------

async function openContext(deviceId) {
  const options = { sampleRate: SAMPLE_RATE, latencyHint: "interactive" };

  if (NATIVE_SINK && deviceId) {
    try {
      const ctx = new AudioContext({ ...options, sinkId: deviceId });
      return { ctx, terminal: ctx.destination, audioEl: null };
    } catch (err) {
      warn(`could not open output directly (${err.name}); falling back to element routing`);
    }
  }

  // Fallback for builds without constructor sinkId support: render into a
  // MediaStream and let an <audio> element — which has had setSinkId for years —
  // carry it to the chosen device.
  const ctx = new AudioContext(options);
  if (!deviceId) return { ctx, terminal: ctx.destination, audioEl: null };

  const terminal = ctx.createMediaStreamDestination();
  const audioEl = new Audio();
  audioEl.srcObject = terminal.stream;
  await audioEl.setSinkId(deviceId);
  await audioEl.play();
  return { ctx, terminal, audioEl };
}

// Layered clips sum. Measured on a real board: one clip peaks around 0.47, two
// around 0.93, three around 1.32 — and everything past 1.0 is squared off into
// hard clipping, which is heard as static and as a loss of level.
//
// The ceiling sits below full scale on purpose: the microphone joins this signal
// downstream of here, so the clips have to leave room for a voice on top.
//
// This is on the clip bus only. Putting it across the whole mix would pump the
// voice every time a pad fired.
function createClipLimiter(ctx) {
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -4.5; // ~0.6 linear, leaving headroom for the mic
  limiter.knee.value = 0;
  limiter.ratio.value = 20; // effectively limiting rather than compressing
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;

  // Safety net for transients the 3 ms attack lets past.
  //
  // The curve must be exactly unity below the knee. A plain scaled tanh is not:
  // tanh(x*d)/tanh(d) has slope d/tanh(d) at zero, which quietly applies ~3 dB of
  // makeup gain to every signal passing through — measured, a single clip went
  // from 0.442 to 0.734 before this was fixed. So: straight line up to the knee,
  // and only past it does the curve bend, saturating instead of squaring off.
  const shaper = ctx.createWaveShaper();
  const curve = new Float32Array(1024);
  const knee = 0.7;
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    const magnitude = Math.abs(x);
    const shaped =
      magnitude <= knee ? magnitude : knee + (1 - knee) * Math.tanh((magnitude - knee) / (1 - knee));
    curve[i] = Math.sign(x) * shaped;
  }
  shaper.curve = curve;
  shaper.oversample = "4x";

  // Chromium's DynamicsCompressorNode applies an implicit makeup gain derived
  // from threshold and ratio, so even a signal that never reaches the threshold
  // comes out louder. Measured with these exact settings: a solo clip peaking at
  // 0.442 emerged at 0.593, a fixed factor of 1.342. Left uncorrected that both
  // changes the level of every single-clip press and spends the headroom this
  // limiter exists to protect. The factor is constant for constant parameters,
  // so it is simply divided back out here — re-measure if the settings above change.
  const MAKEUP_COMPENSATION = 1 / 1.342;
  const makeup = ctx.createGain();
  makeup.gain.value = MAKEUP_COMPENSATION;

  limiter.connect(makeup);
  makeup.connect(shaper);
  return { input: limiter, output: shaper, node: limiter };
}

class Output {
  static async open(deviceId, { withMicBus = false } = {}) {
    const { ctx, terminal, audioEl } = await openContext(deviceId);
    const out = new Output();
    out.deviceId = deviceId;
    out.ctx = ctx;
    out.terminal = terminal;
    out.audioEl = audioEl;

    out.clipMaster = ctx.createGain();
    out.limiter = createClipLimiter(ctx);
    out.clipMaster.connect(out.limiter.input);
    out.limiter.output.connect(terminal);

    if (withMicBus) {
      // The mic bypasses clipMaster on purpose. Master volume and stop-all are
      // soundboard controls; neither should ever be able to cut your voice.
      out.micGain = ctx.createGain();
      out.micGain.connect(terminal);
    }

    if (Math.abs(ctx.sampleRate - SAMPLE_RATE) > 1) {
      warn(
        `output is running at ${ctx.sampleRate} Hz instead of ${SAMPLE_RATE} Hz — ` +
          `set that device to 48000 Hz in Windows Sound settings or clips will be pitch-shifted`
      );
    }
    return out;
  }

  async close() {
    if (this.audioEl) {
      this.audioEl.pause();
      this.audioEl.srcObject = null;
    }
    await this.ctx.close().catch(() => {});
  }
}

// --- microphone -------------------------------------------------------------

function detachMic() {
  state.micSource?.disconnect();
  state.micSource = null;
  if (state.micChain) {
    state.micChain.highPass.disconnect();
    state.micChain.gate.port.onmessage = null;
    state.micChain.gate.disconnect();
    state.micChain = null;
  }
  state.micStream?.getTracks().forEach((track) => track.stop());
  state.micStream = null;
}

async function attachMic(deviceId) {
  if (!state.cable) return;

  detachMic();
  state.micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      // echoCancellation must be off: it treats clip audio on the monitor output
      // as far-end signal and ducks your voice every time a clip fires.
      //
      // Chromium then refuses to apply noiseSuppression or autoGainControl at
      // all — disabling the echo canceller drops the whole WebRTC processing
      // module, silently, with the constraints still reporting as accepted.
      // Verified: {ec: true, ns: true} applies, {ec: false, ns: true} does not.
      // That is why the gate below exists.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });

  const ctx = state.cable.ctx;
  state.micDeviceId = deviceId;
  state.micSource = ctx.createMediaStreamSource(state.micStream);

  if (!workletLoaded.has(ctx)) {
    await ctx.audioWorklet.addModule("src/noise-gate.worklet.js");
    workletLoaded.add(ctx);
  }

  // Rumble, desk bumps, and plosives live below ~85 Hz and carry a lot of
  // energy, so filtering first also stops them from tripping the gate open.
  const highPass = ctx.createBiquadFilter();
  highPass.type = "highpass";
  highPass.Q.value = 0.7;

  const gate = new AudioWorkletNode(ctx, "noise-gate");
  gate.port.onmessage = (event) => onMeter?.(event.data);

  state.micSource.connect(highPass).connect(gate).connect(state.cable.micGain);
  state.micChain = { highPass, gate };
  applyGate(state.settings);
}

/** Register a callback for the input meter: { level: dBFS, open: boolean }. */
export function onMicMeter(fn) {
  onMeter = fn;
}

export function applyGate(settings) {
  if (!state.micChain || !settings) return;
  const { highPass, gate } = state.micChain;
  const at = gate.context.currentTime;

  highPass.frequency.setValueAtTime(settings.highPassHz, at);
  const set = (name, value) => gate.parameters.get(name).setValueAtTime(value, at);
  set("threshold", settings.gateThreshold);
  set("hysteresis", settings.gateHysteresis);
  set("attackMs", settings.gateAttackMs);
  set("releaseMs", settings.gateReleaseMs);
  set("holdMs", settings.gateHoldMs);
  set("bypass", settings.gateEnabled ? 0 : 1);
}

/**
 * The sample rate Windows has the playback side of a device configured at.
 *
 * Deliberately does NOT request a rate: asking for 48000 makes Chromium resample
 * and report 48000 back regardless of the device's real format, which would make
 * this check always pass and always be worthless. Opening with no rate reports
 * the device's actual mix format.
 */
export async function probeOutputRate(deviceId) {
  // Without constructor sinkId support there is no way to target a specific
  // device, and opening a default context would report the DEFAULT output's
  // rate as though it were the cable's — a check that silently passes while
  // measuring the wrong device is worse than no check, so say "unknown".
  if (!NATIVE_SINK || !deviceId) return null;

  let ctx = null;
  try {
    ctx = new AudioContext({ sinkId: deviceId });
    return ctx.sampleRate;
  } catch {
    return null;
  } finally {
    await ctx?.close().catch(() => {});
  }
}

/** Same, for the capture side of a device. */
export async function probeInputRate(deviceId) {
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    return stream.getAudioTracks()[0]?.getSettings().sampleRate ?? null;
  } catch {
    return null;
  } finally {
    stream?.getTracks().forEach((track) => track.stop());
  }
}

/**
 * Ask for microphone access once so that enumerateDevices() returns real labels.
 * Until a mic permission is granted every label is an empty string, which makes
 * finding "CABLE Input" by name impossible.
 */
export async function unlockDeviceLabels() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    return true;
  } catch (err) {
    warn(`microphone permission denied (${err.name}); device names will be hidden`);
    return false;
  }
}

// --- configuration ----------------------------------------------------------

/** Open, close, or re-point the outputs to match the current settings. */
export async function configure(settings) {
  const previous = state.settings;
  state.settings = settings;

  if (!state.cable || state.cable.deviceId !== settings.cableDeviceId) {
    stopAll();
    await state.cable?.close();
    state.cable = settings.cableDeviceId
      ? await Output.open(settings.cableDeviceId, { withMicBus: true })
      : null;
    // The mic source node belongs to the old context and died with it.
    detachMic();
  }

  if (!state.monitor || state.monitor.deviceId !== settings.monitorDeviceId) {
    await state.monitor?.close();
    state.monitor = settings.monitorDeviceId ? await Output.open(settings.monitorDeviceId) : null;
  }

  const micChanged = !state.micStream || state.micDeviceId !== settings.micDeviceId;
  if (settings.micPassthrough && state.cable && micChanged) {
    try {
      await attachMic(settings.micDeviceId);
    } catch (err) {
      warn(`could not open microphone (${err.name}) — your voice is not reaching Discord`);
    }
  } else if (!settings.micPassthrough && state.micStream) {
    detachMic();
  }

  applyVolumes(settings);
  applyGate(settings);

  // Contexts start suspended until a gesture. Nudging them here means the very
  // first hotkey press is not swallowed.
  if (previous) await resumeAll();
}

export function applyVolumes(settings) {
  if (state.cable) {
    state.cable.clipMaster.gain.value = settings.masterVolume;
    if (state.cable.micGain) state.cable.micGain.gain.value = settings.micPassthrough ? 1 : 0;
  }
  if (state.monitor) {
    state.monitor.clipMaster.gain.value = settings.monitorEnabled ? settings.monitorVolume : 0;
  }
}

async function resumeAll() {
  for (const out of [state.cable, state.monitor]) {
    if (out && out.ctx.state === "suspended") await out.ctx.resume().catch(() => {});
  }
}

/** What the status bar reports. */
export function getStatus() {
  return {
    cableOpen: Boolean(state.cable),
    monitorOpen: Boolean(state.monitor),
    micLive: Boolean(state.micStream),
    cableSampleRate: state.cable?.ctx.sampleRate ?? null,
    // Negative dB while the limiter is holding layered clips down. Surfaced so
    // heavy, sustained limiting is visible rather than just audible.
    limiterReductionDb: state.cable?.limiter.node.reduction ?? 0,
    playing: state.voices.size,
  };
}

// --- decoding ---------------------------------------------------------------

export async function getBuffer(file) {
  const cached = buffers.get(file);
  if (cached) return cached;

  const bytes = await window.api.readClip(file);
  // decodeAudioData detaches the ArrayBuffer it is given, so hand over a copy —
  // otherwise a second decode of the same clip would see an empty buffer.
  const buffer = await decodeCtx.decodeAudioData(bytes.slice().buffer);
  buffers.set(file, buffer);
  return buffer;
}

export function forgetBuffer(file) {
  buffers.delete(file);
}

// --- playback ---------------------------------------------------------------

function stopVoice(voice, fade = FADE) {
  if (voice.stopping) return;
  voice.stopping = true;
  for (const part of voice.parts) {
    const now = part.ctx.currentTime;
    try {
      part.gain.gain.cancelScheduledValues(now);
      part.gain.gain.setValueAtTime(part.gain.gain.value, now);
      part.gain.gain.linearRampToValueAtTime(0, now + fade);
      part.src.stop(now + fade);
    } catch {
      // Already ended; nothing to unwind.
    }
  }
  state.voices.delete(voice);
  voice.onEnded?.();
}

export function stopAll() {
  for (const voice of [...state.voices]) stopVoice(voice);
}

export function stopClip(clipId) {
  for (const voice of [...state.voices]) if (voice.clipId === clipId) stopVoice(voice);
}

/**
 * Fire a clip. `toCable` is what reaches the call; `toMonitor` is what you hear.
 * The trim editor previews with toCable false so you can tune a clip without
 * broadcasting the fiddling into a live conversation.
 */
export async function play(clip, { toCable = true, toMonitor = true, onEnded } = {}) {
  const buffer = await getBuffer(clip.file);
  const mode = state.settings?.overlapMode ?? "layer";

  if (mode === "choke") stopAll();
  else if (mode === "restart") stopClip(clip.id);

  await resumeAll();

  const start = Math.min(Math.max(clip.startSec ?? 0, 0), buffer.duration);
  const end = Math.min(Math.max(clip.endSec ?? buffer.duration, start), buffer.duration);
  const duration = end - start;
  if (duration <= 0.01) {
    onEnded?.();
    return;
  }

  const targets = [];
  if (toCable && state.cable) targets.push(state.cable);
  if (toMonitor && state.monitor && state.settings?.monitorEnabled) targets.push(state.monitor);
  if (targets.length === 0) {
    onEnded?.();
    return;
  }

  const voice = { clipId: clip.id, parts: [], stopping: false, onEnded };
  const volume = clip.volume ?? 1;

  for (const out of targets) {
    const ctx = out.ctx;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = buffer;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(volume, now + FADE);
    // Only fade the tail when there is a tail long enough to fade.
    if (duration > FADE * 3) {
      gain.gain.setValueAtTime(volume, now + duration - FADE);
      gain.gain.linearRampToValueAtTime(0, now + duration);
    }

    src.connect(gain).connect(out.clipMaster);
    src.start(now, start, duration);
    voice.parts.push({ ctx, src, gain });
  }

  // One source drives cleanup. onended also fires for an explicit stop(), and
  // stopVoice() already ran the callback in that case — so guard on `stopping`
  // to keep the caller from being notified twice.
  voice.parts[0].src.onended = () => {
    state.voices.delete(voice);
    if (!voice.stopping) voice.onEnded?.();
  };
  state.voices.add(voice);
  return voice;
}
