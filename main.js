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

import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, safeStorage, session, shell, Tray } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
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
let audioScriptPath = "";

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

// --- Windows audio defaults -------------------------------------------------
//
// VB-CABLE's installer makes the cable Windows' default device, which is what
// causes "all my audio goes into Discord". Undoing that by hand means a trip
// through the Sound control panel. src/win-audio.ps1 does it in one call via
// IPolicyConfig — the same COM interface the Sound panel uses — in the user's
// own context, no elevation, no driver install, no registry or format writes.
//
// PowerShell cannot run a script from inside app.asar, so the bundled copy is
// staged to a real file in userData on every launch (cheap, and keeps it fresh
// across updates). fs reads the source transparently through the asar.
async function ensureAudioScript() {
  if (process.platform !== "win32") return;
  try {
    const text = await fs.readFile(path.join(HERE, "src", "win-audio.ps1"), "utf8");
    const dest = path.join(app.getPath("userData"), "win-audio.ps1");
    await fs.writeFile(dest, text, "utf8");
    audioScriptPath = dest;
  } catch (err) {
    console.error("[soundboard] could not stage win-audio.ps1:", err.message);
    audioScriptPath = "";
  }
}

// Runs the helper and parses its single JSON line. Never rejects: a failed
// audio fix is a reported outcome, not a crash.
function runAudioScript(args) {
  return new Promise((resolve) => {
    if (!audioScriptPath) return resolve({ ok: false, error: "audio helper unavailable" });
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", audioScriptPath, ...args],
      // The first run compiles the inline C#, which can take a few seconds.
      { timeout: 25000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve({ ok: false, error: err.message });
        try {
          resolve(JSON.parse(String(stdout).trim() || "{}"));
        } catch {
          resolve({ ok: false, error: "unreadable audio helper output" });
        }
      }
    );
  });
}

// A device name reaches the script only as a base64 match string it compares
// against enumerated endpoints; it is never executed, so no name — however
// punctuated — can inject. The script path is our own staged file.
async function setDefaultDevice(flow, label) {
  const b64 = Buffer.from(String(label ?? ""), "utf8").toString("base64");
  const res = await runAudioScript(["-Action", "setdefault", "-Flow", flow, "-MatchB64", b64]);
  return { flow, label, ...res };
}

// --- VB-CABLE install -------------------------------------------------------
//
// The app never downloads or bundles the driver — VB-CABLE's licence forbids
// repackaging it, and installing a signed kernel driver is the user's call.
// What this does is remove the fiddly middle: take the .zip the user downloaded
// (or the extracted .exe), find the right installer, and launch it elevated.
// The installer then shows its own "Install Driver" button and Windows' own
// driver-signature prompt; a reboot is still required afterwards.

// Only ever the two real VB-CABLE installer names are launched.
const CABLE_INSTALLER = /^VBCABLE_Setup(_x64)?\.exe$/i;

// PowerShell single-quoted literal: wrap and double any embedded quote. Used so
// a path with spaces or punctuation cannot break out of the -Command string.
function psLiteral(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

// Extract a VB-CABLE zip into a fresh empty temp dir and return the installer
// inside it. The archive is untrusted, so it goes in its own directory and only
// a file with the exact installer name, sitting directly in that directory, is
// ever returned — never anything the archive's own paths could point elsewhere.
async function extractCableInstaller(zipPath) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vbcable-"));
  await execFileP(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
      `Expand-Archive -LiteralPath ${psLiteral(zipPath)} -DestinationPath ${psLiteral(dir)} -Force`],
    { timeout: 60000, windowsHide: true }
  );
  const entries = await fs.readdir(dir);
  for (const name of ["VBCABLE_Setup_x64.exe", "VBCABLE_Setup.exe"]) {
    const hit = entries.find((e) => e.toLowerCase() === name.toLowerCase());
    if (!hit) continue;
    const full = path.join(dir, hit);
    if (path.dirname(full) !== dir) throw new Error("unexpected archive layout");
    return full;
  }
  throw new Error("No VBCABLE_Setup_x64.exe was found in that zip.");
}

async function installCable() {
  if (process.platform !== "win32") return { ok: false, error: "Windows only" };

  const result = await dialog.showOpenDialog(win, {
    title: "Select the VB-CABLE installer or its .zip",
    defaultPath: app.getPath("downloads"),
    properties: ["openFile"],
    filters: [{ name: "VB-CABLE installer", extensions: ["zip", "exe"] }],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };

  let exePath;
  try {
    exePath = result.filePaths[0].toLowerCase().endsWith(".zip")
      ? await extractCableInstaller(result.filePaths[0])
      : result.filePaths[0];
  } catch (err) {
    return { ok: false, error: err.message };
  }

  const base = path.basename(exePath);
  if (!CABLE_INSTALLER.test(base)) {
    return { ok: false, error: `That doesn't look like the VB-CABLE installer (${base}).` };
  }

  // Launch elevated. The installer self-elevates too, but RunAs guarantees the
  // UAC prompt rather than depending on the exe's manifest. A declined prompt
  // makes Start-Process throw, which surfaces as a clean "cancelled".
  try {
    await execFileP(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
        `Start-Process -FilePath ${psLiteral(exePath)} -Verb RunAs`],
      { timeout: 120000, windowsHide: true }
    );
    return { ok: true, installerName: base };
  } catch {
    return { ok: false, error: "The installer was cancelled or blocked." };
  }
}

// --- RPC credentials --------------------------------------------------------
//
// Kept in their own file rather than in library.json. The client secret is a
// password for your Discord application, and the clip library gets copied,
// backed up, and hand-edited; those two things should not share a file.

// The secret and token are encrypted at rest with the OS keystore — DPAPI on
// Windows — so the file is useless if it is copied off the machine or ends up
// in a backup or a screen share. The client ID is deliberately left readable:
// it is public information and keeping it legible makes the file diagnosable.
const SECRET_FIELDS = ["clientSecret", "accessToken"];

function canEncrypt() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

async function loadCredentials() {
  let stored;
  try {
    stored = JSON.parse((await fs.readFile(credentialsPath, "utf8")).replace(/^﻿/, ""));
  } catch {
    return { clientId: "", clientSecret: "", accessToken: "" };
  }

  const out = { clientId: stored.clientId ?? "", clientSecret: "", accessToken: "" };
  for (const field of SECRET_FIELDS) {
    const value = stored[field];
    if (!value) continue;
    if (stored.encrypted) {
      try {
        out[field] = safeStorage.decryptString(Buffer.from(value, "base64"));
      } catch {
        // Encrypted on another machine or another Windows account. Unusable
        // rather than corrupt — drop it and let the user re-enter.
        console.warn(`[soundboard] could not decrypt ${field}; it will need re-entering`);
      }
    } else {
      out[field] = value; // legacy plaintext, re-encrypted on the next save
    }
  }
  return out;
}

async function saveCredentials(credentials) {
  const encrypt = canEncrypt();
  const payload = { clientId: credentials.clientId ?? "", encrypted: encrypt };

  for (const field of SECRET_FIELDS) {
    const value = credentials[field] ?? "";
    if (!value) {
      payload[field] = "";
      continue;
    }
    payload[field] = encrypt ? safeStorage.encryptString(value).toString("base64") : value;
  }

  const tmp = `${credentialsPath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
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

// The app only ever needs to open two sites. An allowlist rather than a
// "starts with https://" check, so that a compromised or buggy renderer cannot
// turn this into a way to launch arbitrary URLs on the user's machine.
const ALLOWED_EXTERNAL_HOSTS = new Set(["vb-audio.com", "www.vb-audio.com", "discord.com", "github.com"]);

function openExternalUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return;
  }
  if (parsed.protocol !== "https:" || !ALLOWED_EXTERNAL_HOSTS.has(parsed.hostname)) {
    console.warn(`[soundboard] refused to open ${parsed.protocol}//${parsed.hostname}`);
    return;
  }
  return shell.openExternal(parsed.toString());
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

  // The preload hands the page `window.api`, which can read and write files and
  // register global shortcuts. That is safe only while the page is OUR page.
  // Nothing here navigates, but the content security policy does not restrict
  // top-level navigation, so without these two guards a single injected link
  // could move the window to a remote origin that then inherits the whole IPC
  // surface. Deny both, and send anything genuinely external to the real browser.
  win.webContents.on("will-navigate", (event, url) => {
    if (url !== win.webContents.getURL()) {
      event.preventDefault();
      openExternalUrl(url);
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: "deny" };
  });

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
  await ensureAudioScript();

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

ipcMain.handle("shell:open-external", (_e, url) => openExternalUrl(url));

// Set Windows' default playback/recording devices back to the user's real
// hardware, taking the cable off every default role. Driven by an explicit
// button, never on launch: it is a real system-wide change and stays the
// user's call.
ipcMain.handle("audio:fix-defaults", async (_e, { outputLabel, inputLabel } = {}) => {
  if (process.platform !== "win32") return { ok: false, error: "Windows only" };
  const results = [];
  if (outputLabel) results.push(await setDefaultDevice("render", outputLabel));
  if (inputLabel) results.push(await setDefaultDevice("capture", inputLabel));
  return { ok: results.length > 0 && results.every((r) => r.ok), results };
});

// Read-only enumeration, for diagnostics.
ipcMain.handle("audio:list", () => runAudioScript(["-Action", "list"]));

// Launch the VB-CABLE installer the user downloaded (zip or exe), elevated.
ipcMain.handle("audio:install-cable", () => installCable());

// Set both halves of the cable to 48000 Hz — the rate the whole app is pinned
// to; a mismatch plays every clip pitch-shifted. Like the default-device fix
// this goes through IPolicyConfig (SetDeviceFormat) and needs no elevation. The
// two halves are the render device "CABLE Input" and the capture device "CABLE
// Output", matched by name; VB-CABLE does not localise them.
function cableRateArgs(action, flow, name) {
  const b64 = Buffer.from(name, "utf8").toString("base64");
  return [action, "-Flow", flow, "-MatchB64", b64];
}

ipcMain.handle("audio:set-cable-rate", async () => {
  if (process.platform !== "win32") return { ok: false, error: "Windows only" };
  const results = [
    { half: "input", ...(await runAudioScript(["-Action", ...cableRateArgs("setrate", "render", "CABLE Input"), "-Rate", "48000"])) },
    { half: "output", ...(await runAudioScript(["-Action", ...cableRateArgs("setrate", "capture", "CABLE Output"), "-Rate", "48000"])) },
  ];
  return { ok: results.every((r) => r.ok), results };
});

ipcMain.handle("audio:get-cable-rate", async () => {
  if (process.platform !== "win32") return {};
  return {
    cableInput: await runAudioScript(["-Action", ...cableRateArgs("getrate", "render", "CABLE Input")]),
    cableOutput: await runAudioScript(["-Action", ...cableRateArgs("getrate", "capture", "CABLE Output")]),
  };
});
