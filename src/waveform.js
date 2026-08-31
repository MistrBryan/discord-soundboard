// Waveform rendering and the drag-to-trim editor.
//
// Peaks are bucketed per output pixel rather than per sample: a three second
// clip is 144,000 frames and the canvas is a few hundred pixels wide, so drawing
// every frame would be thousands of redundant strokes.

const HANDLE_HIT_PX = 10;

/** min/max pair per pixel column, mixed down across channels. */
function computePeaks(buffer, width) {
  const peaks = new Float32Array(width * 2);
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));

  const step = buffer.length / width;
  for (let x = 0; x < width; x++) {
    const from = Math.floor(x * step);
    const to = Math.min(Math.floor((x + 1) * step), buffer.length);
    let min = 0;
    let max = 0;
    for (let i = from; i < to; i++) {
      for (const data of channels) {
        const v = data[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    peaks[x * 2] = min;
    peaks[x * 2 + 1] = max;
  }
  return peaks;
}

/**
 * Draw the waveform with the trimmed-away regions dimmed.
 * `canvas` is sized in CSS pixels; this handles the devicePixelRatio scaling.
 */
function draw(canvas, peaks, { duration, startSec, endSec }) {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);

  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);

  // Canvas can't use CSS variables directly, so resolve them at paint time —
  // that way the waveform follows the theme instead of pinning dark colours
  // onto a light background.
  const palette = getComputedStyle(document.documentElement);
  const inRangeColour = palette.getPropertyValue("--wave").trim() || "#7aa2f7";
  const trimmedColour = palette.getPropertyValue("--wave-dim").trim() || "#39414f";
  const handleColour = palette.getPropertyValue("--warn").trim() || "#f0b132";

  const mid = height / 2;
  const startX = (startSec / duration) * width;
  const endX = (endSec / duration) * width;

  for (let x = 0; x < width; x++) {
    const inRange = x >= startX && x <= endX;
    ctx.fillStyle = inRange ? inRangeColour : trimmedColour;
    const min = peaks[x * 2];
    const max = peaks[x * 2 + 1];
    const top = mid - max * mid;
    const bottom = mid - min * mid;
    ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
  }

  ctx.fillStyle = handleColour;
  ctx.fillRect(startX - 1, 0, 2, height);
  ctx.fillRect(endX - 1, 0, 2, height);
}

/**
 * Wire a canvas up as a trim editor. Returns { refresh, destroy }.
 * `onChange({startSec, endSec})` fires continuously while dragging so the caller
 * can show live numbers; `onCommit` fires once on release, for persisting.
 */
export function createTrimEditor(canvas, buffer, clip, { onChange, onCommit }) {
  const duration = buffer.duration;
  let peaks = computePeaks(buffer, Math.max(1, canvas.clientWidth));
  let startSec = Math.min(Math.max(clip.startSec ?? 0, 0), duration);
  let endSec = Math.min(Math.max(clip.endSec ?? duration, startSec), duration);
  let dragging = null;

  const render = () => draw(canvas, peaks, { duration, startSec, endSec });

  const timeAt = (event) => {
    const rect = canvas.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    return Math.min(Math.max(ratio, 0), 1) * duration;
  };

  const pxFor = (seconds) => (seconds / duration) * canvas.clientWidth;

  const onPointerDown = (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    // Grab whichever handle is closer, but only if the click landed near one;
    // clicking the middle of the waveform should not yank a boundary across.
    const dStart = Math.abs(x - pxFor(startSec));
    const dEnd = Math.abs(x - pxFor(endSec));
    if (Math.min(dStart, dEnd) > HANDLE_HIT_PX) return;
    dragging = dStart <= dEnd ? "start" : "end";
    canvas.setPointerCapture(event.pointerId);
    onPointerMove(event);
  };

  const onPointerMove = (event) => {
    if (!dragging) return;
    const t = timeAt(event);
    // Keep at least 20 ms of audio between the handles so a clip can never be
    // trimmed down to silence by accident.
    if (dragging === "start") startSec = Math.min(t, endSec - 0.02);
    else endSec = Math.max(t, startSec + 0.02);
    startSec = Math.max(0, startSec);
    endSec = Math.min(duration, endSec);
    render();
    onChange?.({ startSec, endSec });
  };

  const onPointerUp = (event) => {
    if (!dragging) return;
    dragging = null;
    canvas.releasePointerCapture?.(event.pointerId);
    onCommit?.({ startSec, endSec });
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);

  render();

  return {
    // Peaks are width-dependent, so a resize means recomputing them.
    refresh() {
      peaks = computePeaks(buffer, Math.max(1, canvas.clientWidth));
      render();
    },
    reset() {
      startSec = 0;
      endSec = duration;
      render();
      onCommit?.({ startSec, endSec });
    },
    destroy() {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
    },
  };
}
