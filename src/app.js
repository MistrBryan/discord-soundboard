// UI shell: device pickers, the button grid, import, and the clip editor.
// All audio decisions live in audio.js; this file only decides what the user
// sees and when.

import * as audio from "./audio.js";
import { Library } from "./library.js";
import { listDevices, findCable, suggestDefaults, checkRouting } from "./setup.js";
import { createWizard } from "./wizard.js";
import { accelFromEvent, formatAccelerator } from "./hotkeys.js";
import { createTrimEditor } from "./waveform.js";

const $ = (selector) => document.querySelector(selector);

const setupEl = $("#setup");
const appEl = $("#app");
const boardEl = $("#board");
const toastEl = $("#toast");
const dropHintEl = $("#drop-hint");
const editorEl = $("#editor");

let library = null;
let devices = { outputs: [], inputs: [] };
let conflicts = new Set(); // accelerators another application already owns
let recording = null; // { onAccelerator } while a hotkey is being captured
let trimEditor = null;
let editingId = null;
let calibrationSamples = null; // collecting meter levels while calibrating
let rpcEnabled = false;
let rpcState = { connected: false };
let wizard = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- small helpers ----------------------------------------------------------

let toastTimer = null;
function toast(message, ms = 5000) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), ms);
}

function formatSeconds(value) {
  return `${value.toFixed(2)}s`;
}

function percent(value) {
  return `${Math.round(value * 100)}%`;
}

// --- theme ------------------------------------------------------------------

// "system" leaves the attribute off entirely and lets prefers-color-scheme
// decide, so the window follows Windows switching itself light or dark live.
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

function applyTheme(theme) {
  const resolved = theme === "system" ? (systemDark.matches ? "dark" : "light") : theme;
  document.documentElement.setAttribute("data-theme", resolved);
  // The waveform paints to a canvas, which can't inherit CSS variables, so it
  // has to be told to repaint whenever the palette changes.
  trimEditor?.refresh();
}

systemDark.addEventListener("change", () => {
  if (library?.settings.theme === "system") applyTheme("system");
});

// Meter scale. Anything below -70 dBFS is inaudible room tone, so stretching the
// visible range over it would waste most of the bar.
const METER_FLOOR = -70;

function meterPercent(db) {
  return Math.min(100, Math.max(0, ((db - METER_FLOOR) / -METER_FLOOR) * 100));
}

// The marker shows where the gate opens, so you can set the threshold by eye:
// put it just above where the bar sits when you are silent.
function positionThresholdMarker() {
  $("#meter-threshold").style.left = `${meterPercent(library.settings.gateThreshold)}%`;
}

// Device ids can be reissued between launches, so a remembered label is the more
// durable handle. Prefer the id when it still resolves, fall back to the name.
function resolveDevice(list, savedId, savedLabel) {
  return (
    list.find((d) => d.deviceId === savedId) ??
    (savedLabel ? list.find((d) => d.label === savedLabel) : null) ??
    null
  );
}

function fillSelect(select, list, selectedId) {
  select.innerHTML = list
    .map(
      (device) =>
        `<option value="${device.deviceId}"${device.deviceId === selectedId ? " selected" : ""}>${
          device.label || "(unnamed device)"
        }</option>`
    )
    .join("");
  if (list.length === 0) select.innerHTML = `<option value="">No devices found</option>`;
}

// --- devices ----------------------------------------------------------------

async function refreshDevices() {
  devices = await listDevices();

  // Exactly one of the two screens must be revealed on every path through here.
  // #app starts hidden in the markup, so forgetting the else branch leaves a
  // blank window with no error anywhere — which is precisely what happened.
  const cableDevice = findCable(devices.outputs);
  if (!cableDevice || !library.settings.setupComplete) {
    showWizard();
    // No cable means nothing below can be configured; the wizard is all there is.
    if (!cableDevice) return;
  } else {
    setupEl.hidden = true;
    appEl.hidden = false;
  }

  const settings = library.settings;
  const defaults = suggestDefaults(devices);

  const cable = resolveDevice(devices.outputs, settings.cableDeviceId, settings.cableDeviceLabel);
  const monitor = resolveDevice(devices.outputs, settings.monitorDeviceId, settings.monitorDeviceLabel);
  const mic = resolveDevice(devices.inputs, settings.micDeviceId, settings.micDeviceLabel);

  library.updateSettings({
    cableDeviceId: cable?.deviceId ?? defaults.cableDeviceId,
    cableDeviceLabel: cable?.label ?? devices.outputs.find((d) => d.deviceId === defaults.cableDeviceId)?.label ?? null,
    monitorDeviceId: monitor?.deviceId ?? defaults.monitorDeviceId,
    monitorDeviceLabel:
      monitor?.label ?? devices.outputs.find((d) => d.deviceId === defaults.monitorDeviceId)?.label ?? null,
    micDeviceId: mic?.deviceId ?? defaults.micDeviceId,
    micDeviceLabel: mic?.label ?? devices.inputs.find((d) => d.deviceId === defaults.micDeviceId)?.label ?? null,
  });

  renderRoutingWarning();
  fillSelect($("#device-cable"), devices.outputs, settings.cableDeviceId);
  fillSelect($("#device-monitor"), devices.outputs, settings.monitorDeviceId);
  fillSelect($("#device-mic"), devices.inputs, settings.micDeviceId);

  await reconfigure();
}

// --- setup wizard -----------------------------------------------------------

function showWizard() {
  appEl.hidden = true;
  setupEl.hidden = false;

  wizard ??= createWizard(setupEl, {
    getDevices: () => devices,
    refreshDevices: async () => {
      devices = await listDevices();
    },
    getLibrary: () => library,
    getRpcState: () => rpcState,
    openSoundSettings: () => window.api.openSoundSettings(),
    openExternal: (url) => window.api.openExternal(url),
    onAddSounds: () => addSounds(),
    onFinish: async () => {
      library.updateSettings({ setupComplete: true });
      setupEl.hidden = true;
      appEl.hidden = false;
      // Devices and routing may have changed while the user worked through it.
      await refreshDevices();
      renderBoard();
      await applyHotkeys();
    },
  });

  wizard.runChecks();
}

// A persistent banner rather than a toast: this is a standing misconfiguration,
// not a momentary failure, and it stays wrong until the user goes and fixes it.
function renderRoutingWarning() {
  const problems = checkRouting(devices);
  const banner = $("#routing-warning");
  const list = $("#routing-list");

  list.innerHTML = "";
  banner.hidden = problems.length === 0;

  for (const problem of problems) {
    const row = document.createElement("div");
    row.className = "banner-item";
    const title = document.createElement("strong");
    title.textContent = problem.title;
    const detail = document.createElement("span");
    detail.textContent = problem.detail;
    row.append(title, detail);
    list.append(row);
  }
}

// --- Discord RPC ------------------------------------------------------------

function renderRpcStatus() {
  const element = $("#rpc-status");
  const parts = [];

  if (!rpcEnabled) parts.push("off");
  else if (rpcState.error) parts.push(`error: ${rpcState.error}`);
  else if (!rpcState.connected) parts.push("not connected");
  else if (!rpcState.cableFound) parts.push("connected — Discord doesn't list CABLE Output");
  else if (!rpcState.inVoiceChannel) parts.push("connected — waiting for a call");
  else parts.push(rpcState.engaged ? "on the cable, filters off" : "ready — your mic, filters on");

  // Discord's own voice activity detection can cut a clip off partway through,
  // which is indistinguishable from a filter doing it. We never change this —
  // showing it just means you don't have to guess.
  const mode = rpcState.voiceMode;
  if (rpcState.connected && mode?.type === "PUSH_TO_TALK") {
    parts.push("⚠ push-to-talk — clips won't transmit unless you hold the key");
  } else if (rpcState.connected && mode?.type === "VOICE_ACTIVITY" && mode.autoThreshold === false) {
    parts.push(`voice activity, manual threshold ${Math.round(mode.threshold)} dB`);
  }

  if (rpcState.lastSwitchMs != null && rpcState.connected) parts.push(`switch ${rpcState.lastSwitchMs} ms`);

  element.textContent = parts.join(" · ");
  element.classList.toggle("engaged", Boolean(rpcState.engaged));
  element.classList.toggle("bad", Boolean(rpcState.error) || mode?.type === "PUSH_TO_TALK");
  $("#rpc-connect").textContent = rpcState.connected ? "Disconnect" : "Connect";
}

async function connectRpc() {
  const clientId = $("#rpc-client-id").value.trim();
  const clientSecret = $("#rpc-client-secret").value;
  if (!clientId) {
    toast("Enter your Discord application's client ID first.");
    return;
  }

  await window.api.rpcSaveConfig({ clientId, clientSecret });
  // Never keep the secret sitting in a DOM node once it has been handed over.
  $("#rpc-client-secret").value = "";

  const result = await window.api.rpcConnect(library.settings.rpcHangoverMs);
  rpcState = result.state;
  if (!result.ok) toast(`Could not connect to Discord: ${result.error}`, 9000);
  else toast("Connected to Discord. It will switch automatically while clips play.", 6000);
  renderRpcStatus();
}

async function reconfigure() {
  try {
    await audio.configure(library.settings);
  } catch (err) {
    toast(`Audio setup failed: ${err.message}`);
  }
  renderStatus();
}

function renderStatus() {
  const status = audio.getStatus();
  const cableName = library.settings.cableDeviceLabel ?? "not set";
  const parts = [
    status.cableOpen ? `→ ${cableName}` : "no output to Discord",
    status.micLive ? "mic live" : "mic off",
  ];
  if (status.cableSampleRate && Math.abs(status.cableSampleRate - audio.SAMPLE_RATE) > 1) {
    parts.push(`⚠ ${status.cableSampleRate} Hz`);
  }
  // Occasional limiting is the limiter doing its job. Deep, sustained reduction
  // means the per-clip volumes are set too hot for the number being layered.
  //
  // Gated on something actually playing: DynamicsCompressorNode.reduction does
  // not rest at zero with no input, so without this the warning sits on screen
  // permanently and means nothing.
  if (status.playing > 0 && status.limiterReductionDb < -6) {
    parts.push(`limiting ${Math.round(status.limiterReductionDb)} dB — lower clip volumes`);
  }
  $("#status-text").textContent = parts.join(" · ");
  $("#status-dot").classList.toggle("live", status.cableOpen && status.micLive);

  // The tray is the only status indicator visible once the window is hidden.
  window.api.reportState({ micLive: status.micLive, cableOpen: status.cableOpen });
}

// --- board ------------------------------------------------------------------

function renderBoard() {
  boardEl.innerHTML = "";

  if (library.clips.length === 0) {
    boardEl.innerHTML = `
      <div class="empty">
        <h2>No sounds yet</h2>
        <p>Drop audio files anywhere in this window, or use <b>Add sounds</b>.<br />
           mp3, wav, ogg, flac, m4a, opus all work.</p>
      </div>`;
    return;
  }

  for (const clip of library.clips) boardEl.appendChild(padFor(clip));
}

function padFor(clip) {
  const pad = document.createElement("div");
  pad.className = "pad";
  pad.dataset.id = clip.id;
  pad.style.setProperty("--accent", clip.color);

  const conflicted = clip.hotkey && conflicts.has(clip.hotkey);
  // The hotkey is its own button, a sibling of the pad rather than a child —
  // nesting a button inside a button is invalid and the inner one never fires.
  pad.innerHTML = `
    <button class="pad-fire" type="button">
      <span class="pad-name"></span>
    </button>
    <button class="pad-key ${conflicted ? "conflict" : ""}" type="button"
            title="Click to set a global hotkey"></button>
    <button class="pad-edit" type="button" title="Edit clip">⋯</button>`;

  // textContent rather than interpolation: clip names come from filenames and
  // are renamable, so they must never be parsed as markup.
  pad.querySelector(".pad-name").textContent = clip.name;
  pad.querySelector(".pad-fire").title = clip.name;

  const keyButton = pad.querySelector(".pad-key");
  keyButton.textContent = conflicted
    ? `${formatAccelerator(clip.hotkey)} — taken`
    : formatAccelerator(clip.hotkey) || "+ hotkey";
  keyButton.classList.toggle("unset", !clip.hotkey);

  // Bind straight from the grid. Going through the editor for this was the whole
  // reason six clips ended up with no hotkeys at all.
  keyButton.addEventListener("click", (event) => {
    event.stopPropagation();
    startRecording(event.currentTarget, async (accelerator) => {
      const taken = library.clips.find((c) => c.id !== clip.id && c.hotkey === accelerator);
      if (taken) library.update(taken.id, { hotkey: null });
      library.update(clip.id, { hotkey: accelerator });
      await applyHotkeys();
      if (taken) toast(`Unbound "${taken.name}" — it had the same combination`);
    });
  });

  pad.querySelector(".pad-fire").addEventListener("click", () => fire(clip.id));
  pad.querySelector(".pad-edit").addEventListener("click", () => openEditor(clip.id));
  pad.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openEditor(clip.id);
  });
  return pad;
}

function setPadPlaying(id, playing) {
  boardEl.querySelector(`.pad[data-id="${id}"]`)?.classList.toggle("playing", playing);
}

async function fire(id) {
  const clip = library.find(id);
  if (!clip) return;
  setPadPlaying(id, true);

  // Wait for Discord to actually be listening to the cable before any audio
  // starts, or the input switch would eat the opening of the clip. Returns
  // immediately when RPC is off, or when a previous clip already engaged it.
  if (rpcEnabled) {
    try {
      await window.api.rpcClipStarting();
    } catch (err) {
      toast(`Discord switch failed: ${err.message}`);
    }
  }

  try {
    await audio.play(clip, {
      onEnded: () => {
        setPadPlaying(id, false);
        if (rpcEnabled) window.api.rpcClipEnded();
      },
    });
  } catch (err) {
    setPadPlaying(id, false);
    if (rpcEnabled) window.api.rpcClipEnded();
    toast(`Could not play ${clip.name}: ${err.message}`);
  }
  renderStatus();
}

// --- import -----------------------------------------------------------------

async function importFiles(files) {
  const failures = [];

  for (const file of files) {
    let record = null;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      record = await window.api.importClip(file.name, bytes);
      // Decoding here doubles as validation: if Chromium cannot read it, the
      // button would be dead anyway, so fail now rather than at press time.
      const buffer = await audio.getBuffer(record.file);
      library.add({ ...record, durationSec: buffer.duration });
    } catch (err) {
      // Don't leave an undecodable file sitting in the clips directory.
      if (record) await window.api.deleteClip(record.file).catch(() => {});
      failures.push(`${file.name}: ${err.message || "could not be decoded"}`);
    }
  }

  renderBoard();
  await applyHotkeys();
  if (failures.length) toast(failures.join(" · "), 8000);
}

// Named rather than inline, because the wizard's "Add sounds" step calls it too.
async function addSounds() {
  const picked = await window.api.pickClips();
  const failures = picked.filter((entry) => entry.error).map((entry) => entry.error);

  for (const record of picked.filter((entry) => !entry.error)) {
    try {
      const buffer = await audio.getBuffer(record.file);
      library.add({ ...record, durationSec: buffer.duration });
    } catch {
      await window.api.deleteClip(record.file).catch(() => {});
      failures.push(`${record.name}: could not be decoded`);
    }
  }

  renderBoard();
  await applyHotkeys();
  if (failures.length) toast(failures.join(" · "), 8000);
}

function wireDragAndDrop() {
  let depth = 0;

  window.addEventListener("dragenter", (event) => {
    event.preventDefault();
    depth += 1;
    dropHintEl.hidden = false;
  });
  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) dropHintEl.hidden = true;
  });
  window.addEventListener("drop", async (event) => {
    event.preventDefault();
    depth = 0;
    dropHintEl.hidden = true;
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length) await importFiles(files);
  });
}

// --- hotkeys ----------------------------------------------------------------

async function applyHotkeys() {
  const failed = await window.api.applyHotkeys(library.hotkeyBindings(), library.settings.stopAllHotkey);
  conflicts = new Set(failed);
  renderStopAllHotkey();
  renderBoard();
  if (failed.length) {
    toast(`Already in use by another app: ${failed.map(formatAccelerator).join(", ")}`, 8000);
  }
}

// Capture happens on the renderer side because a global shortcut cannot be
// listened for — it can only be registered. Escape cancels, so a mistake is
// never sticky.
function startRecording(button, onAccelerator) {
  stopRecording();
  button.classList.add("recording");
  button.textContent = "Press a combination…";

  const onKeyDown = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.code === "Escape") {
      stopRecording();
      return;
    }
    const result = accelFromEvent(event);
    if (result.error) {
      button.textContent = result.error;
      return;
    }
    stopRecording();
    onAccelerator(result.accelerator);
  };

  recording = { button, onKeyDown };
  window.addEventListener("keydown", onKeyDown, true);
}

function stopRecording() {
  if (!recording) return;
  window.removeEventListener("keydown", recording.onKeyDown, true);
  recording.button.classList.remove("recording");
  recording = null;
  renderStopAllHotkey();
  if (editingId) renderEditorHotkey();
}

function renderStopAllHotkey() {
  if (recording?.button === $("#stop-all-hotkey")) return;
  $("#stop-all-hotkey").textContent = formatAccelerator(library.settings.stopAllHotkey) || "Set…";
}

// --- editor -----------------------------------------------------------------

function renderEditorHotkey() {
  if (recording?.button === $("#editor-hotkey")) return;
  const clip = library.find(editingId);
  $("#editor-hotkey").textContent = clip?.hotkey ? formatAccelerator(clip.hotkey) : "Set…";
}

async function openEditor(id) {
  const clip = library.find(id);
  if (!clip) return;
  editingId = id;

  $("#editor-name").value = clip.name;
  $("#editor-volume").value = clip.volume;
  $("#editor-volume-value").textContent = percent(clip.volume);
  renderEditorHotkey();
  editorEl.showModal();

  // The canvas has no width until the dialog is on screen, and peak buckets are
  // computed from that width — so the editor is built after showModal().
  try {
    const buffer = await audio.getBuffer(clip.file);
    trimEditor?.destroy();
    trimEditor = createTrimEditor($("#editor-wave"), buffer, clip, {
      onChange: ({ startSec, endSec }) => {
        $("#editor-trim").textContent = `${formatSeconds(startSec)} → ${formatSeconds(endSec)}`;
      },
      onCommit: ({ startSec, endSec }) => {
        library.update(id, { startSec, endSec });
        $("#editor-trim").textContent = `${formatSeconds(startSec)} → ${formatSeconds(endSec)}`;
      },
    });
    $("#editor-trim").textContent = `${formatSeconds(clip.startSec ?? 0)} → ${formatSeconds(
      clip.endSec ?? buffer.duration
    )}`;
  } catch (err) {
    toast(`Could not read ${clip.name}: ${err.message}`);
  }
}

function closeEditor() {
  trimEditor?.destroy();
  trimEditor = null;
  editingId = null;
  stopRecording();
}

function wireEditor() {
  editorEl.addEventListener("close", closeEditor);

  $("#editor-name").addEventListener("input", (event) => {
    const name = event.target.value.trim() || "Untitled";
    library.update(editingId, { name });
    renderBoard();
  });

  $("#editor-volume").addEventListener("input", (event) => {
    const volume = Number(event.target.value);
    $("#editor-volume-value").textContent = percent(volume);
    library.update(editingId, { volume });
  });

  $("#editor-reset-trim").addEventListener("click", () => trimEditor?.reset());

  $("#editor-hotkey").addEventListener("click", (event) => {
    startRecording(event.currentTarget, async (accelerator) => {
      // Two pads on the same combination would mean one silently never fires.
      const taken = library.clips.find((c) => c.id !== editingId && c.hotkey === accelerator);
      if (taken) library.update(taken.id, { hotkey: null });
      library.update(editingId, { hotkey: accelerator });
      renderEditorHotkey();
      await applyHotkeys();
      if (taken) toast(`Unbound "${taken.name}" — it had the same combination`);
    });
  });

  $("#editor-clear-hotkey").addEventListener("click", async () => {
    library.update(editingId, { hotkey: null });
    renderEditorHotkey();
    await applyHotkeys();
  });

  // Preview never touches the cable, so a clip can be tuned mid-call without
  // blasting the fiddling into the conversation.
  $("#editor-preview").addEventListener("click", () => {
    const clip = library.find(editingId);
    if (clip) audio.play(clip, { toCable: false, toMonitor: true }).catch((err) => toast(err.message));
  });

  $("#editor-delete").addEventListener("click", async () => {
    const clip = library.find(editingId);
    if (!clip) return;
    audio.stopClip(clip.id);
    audio.forgetBuffer(clip.file);
    await library.remove(clip.id);
    editorEl.close();
    renderBoard();
    await applyHotkeys();
  });
}

// --- toolbar ----------------------------------------------------------------

function wireToolbar() {
  const bindDevice = (selector, idKey, labelKey, list) => {
    $(selector).addEventListener("change", async (event) => {
      const deviceId = event.target.value;
      const label = list().find((d) => d.deviceId === deviceId)?.label ?? null;
      library.updateSettings({ [idKey]: deviceId, [labelKey]: label });
      await reconfigure();
    });
  };

  bindDevice("#device-cable", "cableDeviceId", "cableDeviceLabel", () => devices.outputs);
  bindDevice("#device-monitor", "monitorDeviceId", "monitorDeviceLabel", () => devices.outputs);
  bindDevice("#device-mic", "micDeviceId", "micDeviceLabel", () => devices.inputs);

  $("#theme").addEventListener("change", (event) => {
    library.updateSettings({ theme: event.target.value });
    applyTheme(event.target.value);
  });

  $("#overlap-mode").addEventListener("change", (event) => {
    library.updateSettings({ overlapMode: event.target.value });
  });

  const bindVolume = (selector, valueSelector, key) => {
    const input = $(selector);
    input.addEventListener("input", (event) => {
      const value = Number(event.target.value);
      $(valueSelector).textContent = percent(value);
      library.updateSettings({ [key]: value });
      audio.applyVolumes(library.settings);
    });
  };

  bindVolume("#master-volume", "#master-volume-value", "masterVolume");
  bindVolume("#monitor-volume", "#monitor-volume-value", "monitorVolume");

  $("#monitor-enabled").addEventListener("change", (event) => {
    library.updateSettings({ monitorEnabled: event.target.checked });
    audio.applyVolumes(library.settings);
  });

  // Turning passthrough off releases the mic entirely rather than muting a gain
  // node, so the OS mic indicator goes dark and nothing is being captured.
  $("#mic-passthrough").addEventListener("change", async (event) => {
    library.updateSettings({ micPassthrough: event.target.checked });
    await reconfigure();
  });

  $("#start-at-login").addEventListener("change", (event) => {
    window.api.setLoginItem(event.target.checked);
  });

  $("#stop-all-hotkey").addEventListener("click", (event) => {
    startRecording(event.currentTarget, async (accelerator) => {
      library.updateSettings({ stopAllHotkey: accelerator });
      await applyHotkeys();
    });
  });

  $("#add-sounds").addEventListener("click", addSounds);
  $("#open-wizard").addEventListener("click", showWizard);

  $("#routing-fix").addEventListener("click", () => window.api.openSoundSettings());

  $("#rpc-enabled").addEventListener("change", async (event) => {
    rpcEnabled = event.target.checked;
    library.updateSettings({ rpcEnabled });
    if (rpcEnabled) await connectRpc();
    else {
      await window.api.rpcDisconnect();
      rpcState = { connected: false };
    }
    renderRpcStatus();
  });

  $("#rpc-connect").addEventListener("click", async () => {
    if (rpcState.connected) {
      await window.api.rpcDisconnect();
      rpcState = { connected: false };
      renderRpcStatus();
    } else {
      await connectRpc();
    }
  });

  $("#rpc-hangover").addEventListener("input", (event) => {
    const value = Number(event.target.value);
    $("#rpc-hangover-value").textContent = `${value} ms`;
    library.updateSettings({ rpcHangoverMs: value });
    window.api.rpcSetHangover(value);
  });

  $("#gate-enabled").addEventListener("change", (event) => {
    library.updateSettings({ gateEnabled: event.target.checked });
    audio.applyGate(library.settings);
  });

  const bindGate = (selector, valueSelector, key, format) => {
    $(selector).addEventListener("input", (event) => {
      const value = Number(event.target.value);
      $(valueSelector).textContent = format(value);
      library.updateSettings({ [key]: value });
      audio.applyGate(library.settings);
      if (key === "gateThreshold") positionThresholdMarker();
    });
  };

  // A hardcoded threshold cannot know your room or your mic gain — measure it
  // instead. Whatever the loudest thing heard while you are silent, put the gate
  // a little above it.
  $("#gate-calibrate").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const label = button.textContent;
    button.disabled = true;
    calibrationSamples = [];

    for (let remaining = 3; remaining > 0; remaining--) {
      button.textContent = `Stay quiet… ${remaining}`;
      await sleep(1000);
    }

    const samples = calibrationSamples;
    calibrationSamples = null;
    button.disabled = false;
    button.textContent = label;

    if (!samples.length) {
      toast("No microphone signal to measure — is passthrough on?");
      return;
    }

    const floor = Math.max(...samples);
    const threshold = Math.round(Math.min(-10, Math.max(-90, floor + 8)));
    library.updateSettings({ gateThreshold: threshold });
    $("#gate-threshold").value = threshold;
    $("#gate-threshold-value").textContent = `${threshold} dB`;
    positionThresholdMarker();
    audio.applyGate(library.settings);
    toast(`Noise floor measured at ${Math.round(floor)} dB. Threshold set to ${threshold} dB.`, 7000);
  });

  const ms = (value) => `${value} ms`;
  bindGate("#gate-threshold", "#gate-threshold-value", "gateThreshold", (v) => `${v} dB`);
  bindGate("#gate-release", "#gate-release-value", "gateReleaseMs", ms);
  bindGate("#gate-attack", "#gate-attack-value", "gateAttackMs", ms);
  bindGate("#gate-hold", "#gate-hold-value", "gateHoldMs", ms);

  $("#stop-all").addEventListener("click", () => {
    audio.stopAll();
    boardEl.querySelectorAll(".pad.playing").forEach((pad) => pad.classList.remove("playing"));
  });
}

function paintSettings() {
  const settings = library.settings;
  $("#theme").value = settings.theme;
  applyTheme(settings.theme);
  $("#overlap-mode").value = settings.overlapMode;
  $("#master-volume").value = settings.masterVolume;
  $("#master-volume-value").textContent = percent(settings.masterVolume);
  $("#monitor-volume").value = settings.monitorVolume;
  $("#monitor-volume-value").textContent = percent(settings.monitorVolume);
  $("#monitor-enabled").checked = settings.monitorEnabled;
  $("#mic-passthrough").checked = settings.micPassthrough;

  $("#gate-enabled").checked = settings.gateEnabled;
  $("#gate-threshold").value = settings.gateThreshold;
  $("#gate-threshold-value").textContent = `${settings.gateThreshold} dB`;
  $("#gate-release").value = settings.gateReleaseMs;
  $("#gate-release-value").textContent = `${settings.gateReleaseMs} ms`;
  $("#gate-attack").value = settings.gateAttackMs;
  $("#gate-attack-value").textContent = `${settings.gateAttackMs} ms`;
  rpcEnabled = Boolean(settings.rpcEnabled);
  $("#rpc-enabled").checked = rpcEnabled;
  $("#rpc-hangover").value = settings.rpcHangoverMs;
  $("#rpc-hangover-value").textContent = `${settings.rpcHangoverMs} ms`;

  $("#gate-hold").value = settings.gateHoldMs;
  $("#gate-hold-value").textContent = `${settings.gateHoldMs} ms`;
  positionThresholdMarker();

  renderStopAllHotkey();
}

// --- boot -------------------------------------------------------------------

async function boot() {
  audio.onWarning(toast);

  // Must happen before enumerateDevices: without a granted mic permission every
  // device label comes back empty and VB-CABLE cannot be found by name.
  await audio.unlockDeviceLabels();

  library = await Library.load();
  paintSettings();

  const fill = $("#meter-fill");
  audio.onMicMeter(({ level, open }) => {
    if (calibrationSamples) calibrationSamples.push(level);
    fill.style.width = `${meterPercent(level)}%`;
    const passing = open || !library.settings.gateEnabled;
    fill.classList.toggle("open", passing);
    $("#gate-state").textContent = !library.settings.gateEnabled ? "bypassed" : open ? "open" : "gated";
  });

  wireToolbar();
  wireEditor();
  wireDragAndDrop();

  const rpcConfig = await window.api.rpcGetConfig();
  $("#rpc-client-id").value = rpcConfig.clientId;
  $("#rpc-client-secret").placeholder = rpcConfig.hasSecret ? "stored — leave blank to keep" : "";
  rpcState = rpcConfig.state;
  window.api.onRpcState((state) => {
    rpcState = state;
    renderRpcStatus();
  });
  renderRpcStatus();
  // Reconnecting on launch is what makes it "fully automated" — the settings
  // switch themselves from the moment the app starts.
  if (rpcEnabled && rpcConfig.clientId) await connectRpc();

  // Windows is the source of truth for autostart, not our settings file — the
  // user can remove it from Task Manager's startup list behind our back.
  $("#start-at-login").checked = await window.api.getLoginItem();
  window.api.onLoginItemChanged((enabled) => ($("#start-at-login").checked = enabled));

  window.api.onTrayToggleMic(async () => {
    $("#mic-passthrough").checked = !library.settings.micPassthrough;
    library.updateSettings({ micPassthrough: !library.settings.micPassthrough });
    await reconfigure();
  });

  window.api.onHotkeyFire((id) => fire(id));
  window.api.onHotkeyStopAll(() => {
    audio.stopAll();
    boardEl.querySelectorAll(".pad.playing").forEach((pad) => pad.classList.remove("playing"));
  });

  navigator.mediaDevices.addEventListener("devicechange", () => {
    refreshDevices().catch((err) => toast(err.message));
  });

  await refreshDevices();
  renderBoard();
  await applyHotkeys();
}

boot().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<div class="setup"><h1>Failed to start</h1><p>${err.message}</p></div>`;
});
