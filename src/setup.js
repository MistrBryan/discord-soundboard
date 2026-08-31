// VB-CABLE detection and the first-run checklist.
//
// The app never downloads or installs the driver. It is a signed kernel audio
// driver and installing one is the user's call, not a background action an app
// should take on their behalf — so this shows the steps and a link, then waits.

// Note the singular "Cable" and the explicit index.htm — the plural /Cables/
// path looks right and 404s.
export const CABLE_URL = "https://vb-audio.com/Cable/index.htm";

// VB-CABLE presents two halves. Windows names them:
//   "CABLE Input (VB-Audio Virtual Cable)"   — a playback device; we write here
//   "CABLE Output (VB-Audio Virtual Cable)"  — a capture device; Discord reads here
const CABLE_OUTPUT_PATTERN = /^CABLE Input/i;

export async function listDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return {
    outputs: devices.filter((d) => d.kind === "audiooutput"),
    inputs: devices.filter((d) => d.kind === "audioinput"),
    // An empty label means the mic permission was never granted, and no device
    // can be identified by name until it is.
    labelsVisible: devices.some((d) => d.label),
  };
}

export function findCable(outputs) {
  return outputs.find((device) => CABLE_OUTPUT_PATTERN.test(device.label)) ?? null;
}

/**
 * The single most common way this setup goes wrong: the VB-CABLE installer sets
 * CABLE Input as the Windows *default* playback device. Every application on the
 * machine then pours its audio into the cable and Discord broadcasts all of it —
 * music, browser tabs, game audio. The soundboard never needs to be the default;
 * it addresses the cable by name.
 *
 * Chromium reports a synthetic "default" device whose label embeds the real one
 * ("Default - CABLE Input (VB-Audio Virtual Cable)"), which is exactly what we
 * need to detect this without touching the OS.
 */
export function checkRouting({ outputs, inputs }) {
  const isCable = (list, deviceId, pattern) => {
    const device = list.find((d) => d.deviceId === deviceId);
    return Boolean(device && pattern.test(device.label));
  };

  const CABLE_IN = /CABLE Input/i;
  const CABLE_OUT = /CABLE Output/i;
  const problems = [];

  if (isCable(outputs, "default", CABLE_IN)) {
    problems.push({
      title: "Windows is sending every app's audio into the cable.",
      detail:
        "CABLE Input is your default playback device, so Discord will also hear your music, " +
        "browser, and games. Set your real speakers or headphones as the default instead — the " +
        "soundboard doesn't need to be the default, it writes to the cable by name.",
    });
  }

  // Windows keeps a second, separate default for the "communications" role, and
  // the VB-CABLE installer sets both. Voice apps — Discord included — follow this
  // one, so leaving it on the cable feeds call audio straight back into the cable
  // and out to everyone again.
  if (isCable(outputs, "communications", CABLE_IN)) {
    problems.push({
      title: "Call audio is being routed into the cable.",
      detail:
        "CABLE Input is your Default Communication Device. Anything using that role plays into " +
        "the cable, which can send the other people in your call back out to themselves. In the " +
        "Sound panel's Playback tab, set your headphones as the Default Communication Device too.",
    });
  }

  if (isCable(inputs, "default", CABLE_OUT)) {
    problems.push({
      title: "Windows is recording from the cable by default.",
      detail:
        "CABLE Output is your default recording device, so any app left on “Default” captures the " +
        "soundboard instead of your microphone. Set your real mic as the default instead.",
    });
  }

  if (isCable(inputs, "communications", CABLE_OUT)) {
    problems.push({
      title: "Voice apps default to recording the cable.",
      detail:
        "CABLE Output is your Default Communication Device for recording. In the Sound panel's " +
        "Recording tab, set your real microphone as the Default Communication Device.",
    });
  }

  return problems;
}

/** Sensible starting devices for a fresh install. */
export function suggestDefaults({ outputs, inputs }) {
  const cable = findCable(outputs);
  return {
    cableDeviceId: cable?.deviceId ?? null,
    // Monitor through anything that is not the cable — sending the monitor mix
    // back into the cable would double every clip in the call.
    monitorDeviceId: outputs.find((d) => d.deviceId !== cable?.deviceId)?.deviceId ?? null,
    micDeviceId: inputs.find((d) => !/^CABLE Output/i.test(d.label))?.deviceId ?? null,
  };
}
