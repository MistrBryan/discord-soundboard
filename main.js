// Electron main process.
//
// Three jobs, and deliberately nothing else:
//   1. Own the window and grant the microphone permission the renderer needs.
//      Without a granted mic permission Chromium returns EMPTY STRINGS for every
//      device label, which makes it impossible to find "CABLE Input" by name.
//   2. Own the disk. The renderer never touches fs; it asks for bytes over IPC.
//   3. Own global shortcuts, which only exist in the main process.
//
// All audio work happens in the renderer, where Web Audio lives.

import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, session, shell, Tray } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import electronUpdater from "electron-updater";
import { RpcVoice } from "./src/rpc-voice.mjs";

const { autoUpdater } = electronUpdater;

const HERE = path.dirname(fileURLToPath(import.meta.url));

// userData normally derives from the product name, which means packaging the app
// under a nicer display name would silently point it at a different, empty
// folder and lose the existing board. Pin it instead. Must run before ready.
app.setPath("userData", path.join(app.getPath("appData"), "discord-soundboard"));

// Chromium decodes all of these natively, so the app needs no ffmpeg. Anything
// outside this list is rejected at import with a message naming what is
// supported. (electron-updater is the app's only runtime dependency.)
const AUDIO_EXTENSIONS = [".mp3", ".wav", ".ogg", ".oga", ".flac", ".m4a", ".aac", ".opus", ".webm"];

// Device ids are salted per origin and can be reissued between launches, so
// every device is remembered by label as well and re-resolved by name on start.
const DEFAULT_SETTINGS = {
  cableDeviceId: null,
  cableDeviceLabel: null,
  monitorDeviceId: null,
  monitorDeviceLabel: null,
  micDeviceId: null,
  micDeviceLabel: null,
  masterVolume: 1,
  monitorVolume: 0.6,
  monitorEnabled: true,
  micPassthrough: true,
  overlapMode: "layer",
  stopAllHotkey: "CommandOrControl+Alt+X",

  // Cleared on a fresh install so the wizard runs once; the user dismisses it.
  setupComplete: false,

  // "system" follows the Windows light/dark setting.
  theme: "system",

  // Discord RPC automation. The client secret and access token deliberately do
  // NOT live here — they are credentials, and this file is the clip library.
  rpcEnabled: false,
  rpcHangoverMs: 900,

  // Mic cleanup. This exists because Discord's noise suppression has to be
  // switched off — it would otherwise mangle the clips sharing the stream — and
  // Chromium ties its own suppression to the echo canceller, which cannot be
  // used here. Gating the mic before it meets the clips is the way back.
  gateEnabled: true,
  gateThreshold: -50,
  gateHysteresis: 6,
  gateAttackMs: 5,
  gateReleaseMs: 180,
  gateHoldMs: 120,
  highPassHz: 85,
};

let win = null;
let tray = null;
let clipsDir = "";
let libraryPath = "";
let credentialsPath = "";
let themesDir = "";

const rpc = new RpcVoice();

// Closing the window hides it to the tray; only an explicit Quit really exits.
// Without this flag the close handler would also cancel the real shutdown.
let quitting = false;

// Last state the renderer reported, mirrored into the tray icon and tooltip so a
// hidden window still tells you whether your microphone is actually live.
let micState = { micLive: false, cableOpen: false };

// --- disk -------------------------------------------------------------------

async function ensureDirs() {
  const userData = app.getPath("userData");
  clipsDir = path.join(userData, "clips");
  libraryPath = path.join(userData, "library.json");
  credentialsPath = path.join(userData, "rpc-credentials.json");
  themesDir = path.join(userData, "themes");
  await fs.mkdir(clipsDir, { recursive: true });
  await fs.mkdir(themesDir, { recursive: true });
}

// --- RPC credentials --------------------------------------------------------
//
// Kept in their own file rather than in library.json. The client secret is a
// password for your Discord application, and the clip library gets copied,
// backed up, and hand-edited; those two things should not share a file.

async function loadCredentials() {
  try {
    return JSON.parse((await fs.readFile(credentialsPath, "utf8")).replace(/^﻿/, ""));
  } catch {
    return { clientId: "", clientSecret: "", accessToken: "" };
  }
}

async function saveCredentials(credentials) {
  const tmp = `${credentialsPath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(credentials, null, 2), "utf8");
  await fs.rename(tmp, credentialsPath);
  // Best effort on Windows; the file still sits inside the user's own profile.
  await fs.chmod(credentialsPath, 0o600).catch(() => {});
}

async function loadLibrary() {
  try {
    const raw = await fs.readFile(libraryPath, "utf8");
    // Strip a byte-order mark before parsing. JSON.parse rejects one outright,
    // and plenty of editors and shells add it without asking — PowerShell 5.1's
    // `Set-Content -Encoding utf8` among them. Losing a whole board to an
    // invisible character is not an acceptable failure mode.
    const parsed = JSON.parse(raw.replace(/^﻿/, ""));
    return {
      version: 1,
      clips: Array.isArray(parsed.clips) ? parsed.clips : [],
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) },
    };
  } catch (err) {
    // A missing file is the normal first-run case. A corrupt file is not, so
    // move it aside rather than silently discarding the user's whole board.
    if (err.code !== "ENOENT") {
      const backup = `${libraryPath}.broken-${Date.now()}`;
      await fs.rename(libraryPath, backup).catch(() => {});
      console.error(`[soundboard] unreadable library.json moved to ${backup}:`, err.message);
    }
    return { version: 1, clips: [], settings: { ...DEFAULT_SETTINGS } };
  }
}

// Write to a temp file and rename. A rename is atomic on the same volume, so a
// crash mid-save can never leave a half-written library behind.
async function saveLibrary(data) {
  const tmp = `${libraryPath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, libraryPath);
}

// Clip filenames come back from the renderer, so treat them as untrusted: only
// a bare basename that actually lives in the clips directory is allowed.
function resolveClipFile(name) {
  if (typeof name !== "string" || !name || name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new Error(`refusing suspicious clip filename: ${name}`);
  }
  const full = path.join(clipsDir, name);
  if (path.dirname(full) !== clipsDir) throw new Error(`clip escaped clips directory: ${name}`);
  return full;
}

async function importBytes(originalName, bytes) {
  const ext = path.extname(originalName).toLowerCase();
  if (!AUDIO_EXTENSIONS.includes(ext)) {
    throw new Error(`${path.basename(originalName)}: unsupported format. Use ${AUDIO_EXTENSIONS.join(", ")}`);
  }
  const id = crypto.randomUUID();
  const file = `${id}${ext}`;
  await fs.writeFile(path.join(clipsDir, file), Buffer.from(bytes));
  return { id, file, name: path.basename(originalName, ext) };
}

// --- global shortcuts -------------------------------------------------------

// Re-registered wholesale whenever bindings change: cheap, and it keeps the
// registered set from drifting out of sync with the library.
function applyHotkeys(bindings, stopAllAccelerator) {
  globalShortcut.unregisterAll();
  const failed = [];

  const register = (accelerator, fire) => {
    if (!accelerator) return;
    let ok = false;
    try {
      ok = globalShortcut.register(accelerator, fire);
    } catch {
      ok = false;
    }
    // register() returns false when another application already owns the combo.
    // Report it instead of leaving a button that silently never fires.
    if (!ok) failed.push(accelerator);
  };

  for (const { id, accelerator } of bindings ?? []) {
    register(accelerator, () => win?.webContents.send("hotkey:fire", id));
  }
  register(stopAllAccelerator, () => win?.webContents.send("hotkey:stop-all"));

  return failed;
}

// --- updates ----------------------------------------------------------------
//
// Checks GitHub Releases, downloads in the background, and installs on quit.
// Nothing is ever installed underneath a live call: the app sits in the tray
// holding your microphone, so a surprise restart would cut your voice mid-
// sentence. The user is told an update is ready and chooses when to restart.

let updateState = { status: "idle" };

function reportUpdate(next) {
  updateState = next;
  win?.webContents.send("update:state", updateState);
}

function setupUpdates() {
  // In development there is no packaged app to replace, and electron-updater
  // throws rather than no-opping.
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => reportUpdate({ status: "checking" }));
  autoUpdater.on("update-not-available", () => reportUpdate({ status: "idle" }));
  autoUpdater.on("update-available", (info) => reportUpdate({ status: "downloading", version: info.version }));
  autoUpdater.on("download-progress", (p) =>
    reportUpdate({ status: "downloading", percent: Math.round(p.percent) })
  );
  autoUpdater.on("update-downloaded", (info) => {
    reportUpdate({ status: "ready", version: info.version });
    refreshTray();
  });
  autoUpdater.on("error", (err) => {
    // A failed update check must never be fatal, and must never nag: the app's
    // job is playing sounds.
    console.error("[updater]", err?.message ?? err);
    reportUpdate({ status: "error", error: String(err?.message ?? err) });
  });

  autoUpdater.checkForUpdates().catch(() => {});
  // A tray app can stay open for days, so re-check periodically rather than
  // only at launch.
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
}

// --- tray and autostart -----------------------------------------------------

function showWindow() {
  if (!win) return createWindow();
  win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
}

function setLoginItem(enabled) {
  const options = { openAtLogin: enabled, name: "Soundboard" };
  if (!app.isPackaged) {
    // In development the executable is electron.exe, which would start an empty
    // Electron unless it is given the project directory as an argument.
    options.path = process.execPath;
    options.args = [path.resolve(HERE)];
  }
  app.setLoginItemSettings(options);
}

function refreshTray() {
  if (!tray) return;

  const live = micState.micLive && micState.cableOpen;
  tray.setImage(path.join(HERE, "icons", live ? "tray-live.png" : "tray-idle.png"));
  tray.setToolTip(
    live ? "Soundboard — mic is reaching Discord" : "Soundboard — mic is NOT reaching Discord"
  );

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: live ? "Microphone: live" : "Microphone: off", enabled: false },
      { type: "separator" },
      { label: "Show soundboard", click: showWindow },
      ...(updateState.status === "ready"
        ? [{ label: `Restart to update to ${updateState.version}`, click: () => installUpdateNow() }]
        : []),
      { label: "Mute microphone", type: "checkbox", checked: !micState.micLive, click: () => win?.webContents.send("tray:toggle-mic") },
      { label: "Stop all sounds", click: () => win?.webContents.send("hotkey:stop-all") },
      { type: "separator" },
      {
        label: "Start with Windows",
        type: "checkbox",
        checked: app.getLoginItemSettings({ path: app.isPackaged ? undefined : process.execPath }).openAtLogin,
        click: (item) => {
          setLoginItem(item.checked);
          win?.webContents.send("tray:login-item-changed", item.checked);
        },
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
}

function createTray() {
  tray = new Tray(path.join(HERE, "icons", "tray-idle.png"));
  tray.on("click", showWindow);
  refreshTray();
}

// --- window -----------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: "#14161b",
    title: "Soundboard",
    icon: path.join(HERE, "icons", "app.png"),
    webPreferences: {
      preload: path.join(HERE, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // An ESM preload requires the sandbox off. contextIsolation is what
      // actually keeps the renderer away from Node, and that stays on.
      sandbox: false,
    },
  });

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(HERE, "index.html"));

  // The whole point of running in the tray: the renderer keeps holding the mic
  // and feeding the cable, so Discord's input can stay on CABLE Output forever
  // instead of being switched every session. Quitting is what stops your voice.
  win.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });

  // Renderer problems are otherwise invisible unless devtools happen to be
  // open, and the interesting failures here (a denied mic, a device that will
  // not open) all happen in the renderer.
  win.webContents.on("console-message", (...args) => {
    const details = typeof args[0] === "object" && args[0]?.message ? args[0] : null;
    const message = details ? details.message : args[2];
    const level = details ? details.level : args[1];
    if (level === "error" || level === 3 || level === "warning" || level === 2) {
      console.log(`[renderer:${level}] ${message}`);
    }
  });

  // Smoke test, run by `npm run smoke` after a build. Exactly one of the two
  // screens must be visible; a regression that leaves both hidden shows up as a
  // blank window with no error anywhere, which has happened twice.
  if (process.env.SOUNDBOARD_SELFCHECK) {
    win.webContents.once("did-finish-load", () =>
      setTimeout(async () => {
        const result = await win.webContents
          .executeJavaScript(
            `(() => {
               const visible = (el) => el && !el.hidden && el.getClientRects().length > 0;
               const app = document.querySelector("#app");
               const setup = document.querySelector("#setup");
               return {
                 app: visible(app),
                 setup: visible(setup),
                 pads: document.querySelectorAll(".pad").length,
                 wizardSteps: document.querySelectorAll(".wizard-step").length,
               };
             })()`
          )
          .catch((err) => ({ error: err.message }));

        const ok = Boolean(result.app) !== Boolean(result.setup);
        console.log(`SELFCHECK ${ok ? "PASS" : "FAIL"} ${JSON.stringify(result)}`);
        // Optional screenshot, for eyeballing a build without driving it by hand.
        if (process.env.SOUNDBOARD_SHOT) {
          await fs.writeFile(process.env.SOUNDBOARD_SHOT, (await win.webContents.capturePage()).toPNG());
        }
        quitting = true;
        app.exit(ok ? 0 : 1);
      }, 5000)
    );
  }

  win.webContents.on("preload-error", (_e, file, err) => console.error(`[preload] ${file}:`, err));
  win.webContents.on("did-fail-load", (_e, code, desc) => console.error(`[load] ${code} ${desc}`));
}

// An autostarting tray app can easily end up launched twice — once by Windows,
// once by hand. Two copies would fight over the microphone and both register the
// same global hotkeys, so the second instance hands focus back and exits.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
}

app.whenReady().then(async () => {
  await ensureDirs();

  // The renderer is our own local page, so grant it the media permission it
  // needs for getUserMedia and for real device labels. Everything else is
  // denied — nothing in this app should be asking for geolocation or notifications.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === "media");
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === "media");

  createWindow();
  createTray();
  setupUpdates();

  app.on("activate", showWindow);
});

// Deliberately no window-all-closed quit: this app lives in the tray, and
// exiting would silently cut the microphone Discord is listening to.

let restoringOnQuit = false;

app.on("before-quit", (event) => {
  quitting = true;
  // Put Discord's settings back before the process dies. Discord does restore
  // them itself when the controlling app disconnects, but doing it explicitly
  // means the user's mic is already back by the time the window disappears.
  if (rpc.engaged && !restoringOnQuit) {
    restoringOnQuit = true;
    event.preventDefault();
    rpc
      .disconnect()
      .catch(() => {})
      .finally(() => app.quit());
  }
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

// --- IPC --------------------------------------------------------------------

ipcMain.handle("library:load", () => loadLibrary());
ipcMain.handle("library:save", (_e, data) => saveLibrary(data));

ipcMain.handle("clip:import", (_e, originalName, bytes) => importBytes(originalName, bytes));

ipcMain.handle("clip:read", async (_e, file) => {
  const buf = await fs.readFile(resolveClipFile(file));
  // Hand back a plain Uint8Array; structured clone moves it across cheaply and
  // the renderer feeds it straight to decodeAudioData.
  return new Uint8Array(buf);
});

ipcMain.handle("clip:delete", async (_e, file) => {
  await fs.unlink(resolveClipFile(file)).catch(() => {});
});

ipcMain.handle("dialog:pick-clips", async () => {
  const result = await dialog.showOpenDialog(win, {
    title: "Add sounds",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS.map((e) => e.slice(1)) }],
  });
  if (result.canceled) return [];

  const imported = [];
  for (const full of result.filePaths) {
    try {
      imported.push(await importBytes(full, await fs.readFile(full)));
    } catch (err) {
      imported.push({ error: err.message });
    }
  }
  return imported;
});

ipcMain.handle("hotkeys:apply", (_e, bindings, stopAll) => applyHotkeys(bindings, stopAll));

// --- RPC IPC ----------------------------------------------------------------

rpc.on("state", () => win?.webContents.send("rpc:state", rpc.getState()));
rpc.on("token", async (accessToken) => {
  // Persist the token so the authorization modal only ever appears once.
  await saveCredentials({ ...(await loadCredentials()), accessToken }).catch(() => {});
});

ipcMain.handle("rpc:get-config", async () => {
  const credentials = await loadCredentials();
  // The secret never goes back to the renderer; only whether one is stored.
  return {
    clientId: credentials.clientId ?? "",
    hasSecret: Boolean(credentials.clientSecret),
    state: rpc.getState(),
  };
});

ipcMain.handle("rpc:save-config", async (_e, { clientId, clientSecret }) => {
  const current = await loadCredentials();
  const next = {
    clientId: clientId ?? current.clientId ?? "",
    clientSecret: clientSecret || current.clientSecret || "",
    // A different application means the old token is meaningless.
    accessToken: clientId && clientId !== current.clientId ? "" : (current.accessToken ?? ""),
  };
  await saveCredentials(next);
});

ipcMain.handle("rpc:connect", async (_e, hangoverMs) => {
  const credentials = await loadCredentials();
  rpc.hangoverMs = hangoverMs ?? rpc.hangoverMs;
  try {
    await rpc.connect(credentials);
    return { ok: true, state: rpc.getState() };
  } catch (err) {
    return { ok: false, error: err.message, state: rpc.getState() };
  }
});

ipcMain.handle("rpc:disconnect", async () => {
  await rpc.disconnect().catch(() => {});
});

ipcMain.handle("rpc:set-hangover", (_e, ms) => {
  rpc.hangoverMs = ms;
});

// Awaited by the renderer BEFORE a clip is sent to the cable, so the input
// switch has finished before any audio starts.
ipcMain.handle("rpc:clip-starting", () => rpc.clipStarting());
ipcMain.handle("rpc:clip-ended", () => rpc.clipEnded());

// Quitting is what applies the update, so the close-to-tray guard has to be
// lifted first or the app would merely hide and never install.
function installUpdateNow() {
  quitting = true;
  autoUpdater.quitAndInstall();
}

ipcMain.handle("update:get-state", () => updateState);
ipcMain.handle("update:install", () => installUpdateNow());
ipcMain.handle("update:check", async () => {
  if (!app.isPackaged) return { status: "idle", detail: "updates only run in a packaged build" };
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    reportUpdate({ status: "error", error: String(err?.message ?? err) });
  }
  return updateState;
});

// Themes are user-supplied files. Main does the reading and writing; the
// renderer validates, because that is where the token list lives.

function themeFile(id) {
  if (typeof id !== "string" || !/^[a-z0-9-]{1,60}$/.test(id)) throw new Error("bad theme id");
  return path.join(themesDir, id + ".json");
}

ipcMain.handle("themes:list", async () => {
  const names = await fs.readdir(themesDir).catch(() => []);
  const out = [];
  for (const file of names.filter((n) => n.endsWith(".json"))) {
    try {
      const text = await fs.readFile(path.join(themesDir, file), "utf8");
      out.push({ id: file.replace(/.json$/, ""), raw: text.replace(/^﻿/, "") });
    } catch {
      // A single unreadable theme must not stop the rest loading.
    }
  }
  return out;
});

ipcMain.handle("themes:pick", async () => {
  const result = await dialog.showOpenDialog(win, {
    title: "Import a theme",
    properties: ["openFile"],
    filters: [{ name: "Theme", extensions: ["json"] }],
  });
  if (result.canceled) return null;
  const full = result.filePaths[0];
  return { raw: (await fs.readFile(full, "utf8")).replace(/^﻿/, "") };
});

ipcMain.handle("themes:save", async (_e, id, theme) => {
  await fs.writeFile(themeFile(id), JSON.stringify(theme, null, 2), "utf8");
});

ipcMain.handle("themes:delete", async (_e, id) => {
  await fs.unlink(themeFile(id)).catch(() => {});
});

ipcMain.handle("themes:export", async (_e, theme) => {
  const result = await dialog.showSaveDialog(win, {
    title: "Export theme",
    defaultPath: (theme.name || "theme").replace(/[^a-z0-9-_ ]/gi, "") + ".json",
    filters: [{ name: "Theme", extensions: ["json"] }],
  });
  if (result.canceled) return false;
  await fs.writeFile(result.filePath, JSON.stringify(theme, null, 2), "utf8");
  return true;
});

ipcMain.handle("app:report-state", (_e, state) => {
  micState = state;
  refreshTray();
});

ipcMain.handle("app:set-login-item", (_e, enabled) => {
  setLoginItem(Boolean(enabled));
  refreshTray();
});

ipcMain.handle("app:get-login-item", () =>
  app.getLoginItemSettings({ path: app.isPackaged ? undefined : process.execPath }).openAtLogin
);

// Opens the Sound control panel so the user can fix a bad default device. The
// target is hardcoded — the renderer cannot ask for an arbitrary thing to launch,
// and the app changes no audio settings itself.
ipcMain.handle("shell:open-sound-settings", async () => {
  try {
    await shell.openExternal("ms-settings:sound");
  } catch {
    // Older builds without the Settings URI still have the classic panel.
    shell.openPath("C:\\Windows\\System32\\mmsys.cpl");
  }
});

ipcMain.handle("shell:open-external", (_e, url) => {
  // Only ever used for the VB-CABLE download page. Refuse anything that is not
  // a plain https link so a bad clip name can never turn into a launched process.
  if (typeof url !== "string" || !url.startsWith("https://")) return;
  return shell.openExternal(url);
});
