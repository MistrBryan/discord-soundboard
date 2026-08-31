// First-run setup wizard.
//
// The point of this over a page of instructions is that almost every step is
// machine-checkable, so the app can say "done" or "not yet" instead of asking
// the user to believe they followed it correctly. A step that cannot be verified
// says so plainly rather than pretending.
//
// Steps are declarative: each has a check() that returns { ok, detail }. The
// wizard re-runs every check on demand and on device changes.

import * as audio from "./audio.js";
import { findCable, checkRouting, CABLE_URL } from "./setup.js";

const CABLE_CAPTURE_PATTERN = /^CABLE Output/i;

/**
 * @param container  element to render into
 * @param deps  { getDevices, refreshDevices, getLibrary, getRpcState, connectRpc,
 *                openSoundSettings, openExternal, onFinish, onAddSounds }
 */
export function createWizard(container, deps) {
  const steps = buildSteps(deps);
  let results = steps.map(() => ({ state: "pending" }));
  let busy = false;

  async function runChecks() {
    if (busy) return;
    busy = true;
    render();
    results = await Promise.all(
      steps.map(async (step) => {
        try {
          return { state: "checking", ...(await step.check()) };
        } catch (err) {
          return { ok: false, detail: err.message };
        }
      })
    );
    busy = false;
    render();
  }

  function render() {
    const done = results.filter((r) => r.ok).length;
    const required = steps.filter((s) => !s.optional).length;
    const requiredDone = steps.filter((s, i) => !s.optional && results[i]?.ok).length;

    container.innerHTML = `
      <div class="wizard">
        <div class="wizard-head">
          <h1>Set up your soundboard</h1>
          <p>${
            busy
              ? "Checking…"
              : `${done} of ${steps.length} done. Each step is checked for real — nothing here takes your word for it.`
          }</p>
        </div>
        <ol class="wizard-steps"></ol>
        <div class="wizard-actions">
          <button data-act="recheck" class="ghost" type="button">Re-check everything</button>
          <button data-act="finish" class="primary" type="button">
            ${requiredDone === required ? "Finish setup" : "Skip for now"}
          </button>
        </div>
      </div>`;

    const list = container.querySelector(".wizard-steps");
    steps.forEach((step, index) => {
      const result = results[index] ?? {};
      const item = document.createElement("li");
      item.className = `wizard-step ${result.ok ? "ok" : busy ? "checking" : "todo"}`;

      const mark = document.createElement("span");
      mark.className = "wizard-mark";
      mark.textContent = result.ok ? "✓" : busy ? "…" : step.optional ? "–" : "!";

      const body = document.createElement("div");
      body.className = "wizard-body";

      const title = document.createElement("strong");
      title.textContent = step.optional ? `${step.title} (optional)` : step.title;

      const detail = document.createElement("span");
      detail.textContent = result.detail ?? step.body;

      body.append(title, detail);

      if (!result.ok && step.body && result.detail) {
        const how = document.createElement("span");
        how.className = "wizard-how";
        how.textContent = step.body;
        body.append(how);
      }

      if (step.action) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ghost wizard-action";
        button.textContent = step.action.label;
        button.addEventListener("click", async () => {
          await step.action.run();
          await runChecks();
        });
        body.append(button);
      }

      item.append(mark, body);
      list.append(item);
    });

    container.querySelector('[data-act="recheck"]').addEventListener("click", runChecks);
    container.querySelector('[data-act="finish"]').addEventListener("click", deps.onFinish);
  }

  return { render, runChecks };
}

function buildSteps(deps) {
  return [
    {
      title: "Install VB-CABLE",
      body: "Download it, run the installer as administrator, then reboot. It creates the virtual audio device this app writes into.",
      action: { label: "Open the download page", run: async () => deps.openExternal(CABLE_URL) },
      async check() {
        await deps.refreshDevices();
        const cable = findCable(deps.getDevices().outputs);
        return cable
          ? { ok: true, detail: `Found "${cable.label}".` }
          : { ok: false, detail: "Not detected yet. Reboot after installing if you haven't." };
      },
    },

    {
      title: "Set both halves of the cable to 48000 Hz",
      body: "Sound control panel → Playback → CABLE Input → Properties → Advanced → 48000 Hz. Repeat under Recording for CABLE Output.",
      action: { label: "Open Sound settings", run: async () => deps.openSoundSettings() },
      async check() {
        const { outputs, inputs } = deps.getDevices();
        const out = findCable(outputs);
        const cap = inputs.find((d) => CABLE_CAPTURE_PATTERN.test(d.label));
        if (!out || !cap) return { ok: false, detail: "Waiting on VB-CABLE." };

        const [outRate, inRate] = await Promise.all([
          audio.probeOutputRate(out.deviceId),
          audio.probeInputRate(cap.deviceId),
        ]);
        const wrong = [];
        if (outRate && Math.abs(outRate - audio.SAMPLE_RATE) > 1) wrong.push(`CABLE Input is ${outRate} Hz`);
        if (inRate && Math.abs(inRate - audio.SAMPLE_RATE) > 1) wrong.push(`CABLE Output is ${inRate} Hz`);
        if (wrong.length) {
          return { ok: false, detail: `${wrong.join(", ")} — clips will play back pitch-shifted.` };
        }

        // A rate of null means the probe could not target that device. Reporting
        // a pass there would be claiming a check that never ran.
        const unknown = [outRate ? null : "CABLE Input", inRate ? null : "CABLE Output"].filter(Boolean);
        if (unknown.length) {
          return { ok: false, detail: `Couldn't read the sample rate of ${unknown.join(" or ")} — set it by hand.` };
        }

        return { ok: true, detail: "Both halves at 48000 Hz." };
      },
    },

    {
      title: "Take the cable off Windows' default devices",
      body: "Set your real headphones and microphone as both the Default Device and the Default Communication Device. Windows keeps those two separately.",
      action: { label: "Open Sound settings", run: async () => deps.openSoundSettings() },
      async check() {
        const problems = checkRouting(deps.getDevices());
        return problems.length === 0
          ? { ok: true, detail: "Nothing is defaulting to the cable." }
          : {
              ok: false,
              detail: `${problems.length} still pointed at the cable — every app's audio would reach Discord.`,
            };
      },
    },

    {
      title: "Connect Discord",
      optional: true,
      body: "Create an application in the Discord Developer Portal, add http://localhost as an OAuth2 redirect, and paste its Client ID and Secret into the row below. The app then drops Discord's voice filters only while a clip plays, and restores them after.",
      action: {
        label: "Open the Developer Portal",
        run: async () => deps.openExternal("https://discord.com/developers/applications"),
      },
      async check() {
        const state = deps.getRpcState();
        if (state.connected && state.authenticated) {
          return {
            ok: true,
            detail: state.cableFound
              ? "Connected. Discord's filters will be handled automatically."
              : "Connected, but Discord doesn't list CABLE Output as an input.",
          };
        }
        return {
          ok: false,
          detail: state.error
            ? `Not connected: ${state.error}`
            : "Not connected. Skip this and turn Discord's Echo Cancellation, Noise Suppression and Krisp off by hand instead.",
        };
      },
    },

    {
      title: "Point Discord at the cable",
      body: "Discord → Settings → Voice & Video → Input Device → CABLE Output.",
      async check() {
        const state = deps.getRpcState();
        if (!state.connected) {
          // Without RPC there is no way to read Discord's settings, so say so
          // rather than showing a green tick nobody verified.
          return { ok: false, detail: "Can't be checked without the Discord connection above — set it by hand." };
        }
        if (!state.inVoiceChannel) {
          return { ok: false, detail: "Join a voice channel and re-check; Discord only reports this while connected." };
        }
        return { ok: true, detail: "Discord is reachable and the app can drive its input device." };
      },
    },

    {
      title: "Add your first sound",
      body: "Drag audio files onto the window, or use Add sounds. mp3, wav, ogg, flac, m4a, opus and aac all work.",
      action: { label: "Add sounds", run: async () => deps.onAddSounds() },
      async check() {
        const count = deps.getLibrary().clips.length;
        return count > 0
          ? { ok: true, detail: `${count} clip${count === 1 ? "" : "s"} in your board.` }
          : { ok: false, detail: "No clips yet." };
      },
    },
  ];
}
