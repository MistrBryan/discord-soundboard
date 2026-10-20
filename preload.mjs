// The entire surface the renderer gets. Nothing here hands out an ipcRenderer
// reference or a filesystem handle — every call is a named, typed request that
// main validates on its side.

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("api", {
  loadLibrary: () => ipcRenderer.invoke("library:load"),
  saveLibrary: (data) => ipcRenderer.invoke("library:save", data),

  importClip: (originalName, bytes) => ipcRenderer.invoke("clip:import", originalName, bytes),
  readClip: (file) => ipcRenderer.invoke("clip:read", file),
  deleteClip: (file) => ipcRenderer.invoke("clip:delete", file),
  pickClips: () => ipcRenderer.invoke("dialog:pick-clips"),

  // Returns the accelerators that could not be registered because another
  // application already owns them.
  applyHotkeys: (bindings, stopAll) => ipcRenderer.invoke("hotkeys:apply", bindings, stopAll),

  openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),
  openSoundSettings: () => ipcRenderer.invoke("shell:open-sound-settings"),

  // Sets Windows' default devices back to the named real hardware, clearing the
  // cable off every default role. Returns { ok, results }.
  fixAudioDefaults: (outputLabel, inputLabel) =>
    ipcRenderer.invoke("audio:fix-defaults", { outputLabel, inputLabel }),
  listAudioEndpoints: () => ipcRenderer.invoke("audio:list"),

  // Sets both cable halves to 48000 Hz; reads back the current rates.
  setCableSampleRate: () => ipcRenderer.invoke("audio:set-cable-rate"),
  getCableSampleRate: () => ipcRenderer.invoke("audio:get-cable-rate"),

  // Opens a picker for the downloaded VB-CABLE zip/exe and launches it elevated.
  installCable: () => ipcRenderer.invoke("audio:install-cable"),

  // Keeps the tray icon and tooltip honest while the window is hidden.
  reportState: (state) => ipcRenderer.invoke("app:report-state", state),
  setLoginItem: (enabled) => ipcRenderer.invoke("app:set-login-item", enabled),
  getLoginItem: () => ipcRenderer.invoke("app:get-login-item"),

  rpcGetConfig: () => ipcRenderer.invoke("rpc:get-config"),
  rpcSaveConfig: (config) => ipcRenderer.invoke("rpc:save-config", config),
  rpcConnect: (hangoverMs) => ipcRenderer.invoke("rpc:connect", hangoverMs),
  rpcDisconnect: () => ipcRenderer.invoke("rpc:disconnect"),
  rpcSetHangover: (ms) => ipcRenderer.invoke("rpc:set-hangover", ms),
  rpcClipStarting: () => ipcRenderer.invoke("rpc:clip-starting"),
  rpcClipEnded: () => ipcRenderer.invoke("rpc:clip-ended"),
  onRpcState: (fn) => ipcRenderer.on("rpc:state", (_e, state) => fn(state)),

  themesList: () => ipcRenderer.invoke("themes:list"),
  themesPick: () => ipcRenderer.invoke("themes:pick"),
  themesSave: (id, theme) => ipcRenderer.invoke("themes:save", id, theme),
  themesDelete: (id) => ipcRenderer.invoke("themes:delete", id),
  themesExport: (theme) => ipcRenderer.invoke("themes:export", theme),

  updateGetState: () => ipcRenderer.invoke("update:get-state"),
  updateCheck: () => ipcRenderer.invoke("update:check"),
  updateInstall: () => ipcRenderer.invoke("update:install"),
  onUpdateState: (fn) => ipcRenderer.on("update:state", (_e, state) => fn(state)),

  onHotkeyFire: (fn) => ipcRenderer.on("hotkey:fire", (_e, id) => fn(id)),
  onHotkeyStopAll: (fn) => ipcRenderer.on("hotkey:stop-all", () => fn()),
  onTrayToggleMic: (fn) => ipcRenderer.on("tray:toggle-mic", () => fn()),
  onLoginItemChanged: (fn) => ipcRenderer.on("tray:login-item-changed", (_e, enabled) => fn(enabled)),
});
