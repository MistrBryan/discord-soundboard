// Renderer-side clip model. Owns the in-memory board and pushes it to disk;
// never touches the filesystem itself.

const SAVE_DEBOUNCE_MS = 300;

const PALETTE = ["#7aa2f7", "#9ece6a", "#f0b132", "#e06c75", "#bb9af7", "#56c8d8", "#e8a3c4", "#8bd5a0"];

export class Library {
  constructor(data) {
    this.clips = data.clips;
    this.settings = data.settings;
    this._timer = null;
  }

  static async load() {
    return new Library(await window.api.loadLibrary());
  }

  // Every mutation funnels through here. Saves are debounced because dragging a
  // volume slider would otherwise rewrite the file on every pixel of movement.
  save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      window.api
        .saveLibrary({ version: 1, clips: this.clips, settings: this.settings })
        .catch((err) => console.error("[soundboard] save failed:", err));
    }, SAVE_DEBOUNCE_MS);
  }

  find(id) {
    return this.clips.find((clip) => clip.id === id) ?? null;
  }

  add({ id, file, name, durationSec }) {
    const clip = {
      id,
      file,
      name,
      volume: 1,
      startSec: 0,
      endSec: durationSec,
      durationSec,
      hotkey: null,
      color: PALETTE[this.clips.length % PALETTE.length],
      addedAt: Date.now(),
    };
    this.clips.push(clip);
    this.save();
    return clip;
  }

  update(id, patch) {
    const clip = this.find(id);
    if (!clip) return null;
    Object.assign(clip, patch);
    this.save();
    return clip;
  }

  async remove(id) {
    const index = this.clips.findIndex((clip) => clip.id === id);
    if (index === -1) return null;
    const [clip] = this.clips.splice(index, 1);
    await window.api.deleteClip(clip.file).catch(() => {});
    this.save();
    return clip;
  }

  updateSettings(patch) {
    Object.assign(this.settings, patch);
    this.save();
    return this.settings;
  }

  /** The bindings main needs to register, minus the clips that have none. */
  hotkeyBindings() {
    return this.clips
      .filter((clip) => clip.hotkey)
      .map((clip) => ({ id: clip.id, accelerator: clip.hotkey }));
  }
}
