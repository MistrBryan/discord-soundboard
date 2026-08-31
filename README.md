# Discord Soundboard

A programmable soundboard for Discord voice chat. Drop in any audio file, get a button, press
it or a global hotkey, and the sound goes out over your voice channel. No clip length limit,
no file size limit, no server slots.

---

## How it works, and why

Discord exposes no API that lets an outside program inject audio into your microphone, and
modifying the Discord client itself violates its terms of service. So this app takes the one
clean route available: **it becomes your microphone.**

[VB-CABLE](https://vb-audio.com/Cable/index.htm) creates a virtual audio device with two
halves. The app mixes your real mic together with any playing clips and writes the blend into
one half; Discord listens to the other half and cannot tell it from real hardware.

```
your mic ─► noise gate ─┐
                        ├─► CABLE Input ══ CABLE Output ─► Discord
clips ─► limiter ───────┘        │
                                 └─► your headphones (clips only, so you hear what you fired)
```

Nothing touches the Discord process, so this works in servers, DMs, and group calls alike.

**The trade-off:** the app owns your mic path, so it must be running whenever you want to
talk. It lives in the tray for exactly that reason.

---

## Requirements

- Windows 10 or 11
- Discord **desktop** client (the browser version has no RPC pipe)
- [VB-CABLE](https://vb-audio.com/Cable/index.htm) — free, installed once
- Node.js 20+ only if building from source

---

## Setup

**The app walks you through all of this on first run.** The setup wizard checks each step for
real rather than taking your word for it — it detects VB-CABLE by name, probes both halves of
the cable for their actual sample rate, reads all four Windows default-device slots, and
confirms the Discord connection. Reopen it any time with **Setup guide** in the header.

The rest of this section is the same list in written form.

### 1. Install the app

Run `Soundboard Setup <version>.exe`. It installs per-user into `%LOCALAPPDATA%\Programs`, so
there is no administrator prompt.

It is not code-signed, so SmartScreen will say "Windows protected your PC" the first time.
Choose **More info → Run anyway**. That warning means *unknown publisher*, not *unsafe*.

### 2. Install VB-CABLE

Download from <https://vb-audio.com/Cable/index.htm>, run the installer **as administrator**,
then reboot. The app detects whether it is present and shows a checklist if not.

### 3. Set both halves to 48000 Hz

Run `control mmsys.cpl`.

- **Playback** tab → `CABLE Input` → Properties → Advanced → **48000 Hz**
- **Recording** tab → `CABLE Output` → Properties → Advanced → **48000 Hz**

Mismatched sample rates make every clip play back pitch-shifted.

### 4. Take the cable back off "default"

**This is the step everyone misses.** The VB-CABLE installer makes `CABLE Input` the default
playback device, which sends *every program on the machine* into the cable — Discord then
broadcasts your music, browser, and games.

Still in `control mmsys.cpl`:

- **Playback** tab → your real headphones → **Set Default**, and again as **Default
  Communication Device** (the arrow beside the button)
- **Recording** tab → your real microphone → same, both

Windows keeps those two defaults **separately**, so fixing only one leaves half the problem.
The app shows a warning banner if any of the four is still pointed at the cable.

### 5. Point Discord at the cable

Discord → Settings → Voice & Video → **Input Device** → `CABLE Output`.

Leave Output Device on your headphones.

### 6. Set up automatic switching (recommended)

Without this you must disable Discord's voice processing by hand and remember to put it back.
With it, the app does both automatically, only while a clip is playing.

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) →
   **New Application**. Name it anything.
2. **OAuth2** tab → Redirects → add `http://localhost` → **Save Changes**.
3. Copy the **Client ID**, and click **Reset Secret** and copy that too.
4. In the app's RPC row, paste both, tick **Auto-switch Discord**, and approve the
   authorization prompt Discord shows. It appears once.

Do **not** enable *Public Client*, and do **not** touch the Bot tab — no bot is involved.

If you skip this step, disable Echo Cancellation, Noise Suppression, Automatic Gain Control,
and Krisp yourself in Discord → Voice & Video, and accept that they stay off.

### 7. First run

- **Add sounds** — drag audio files onto the window, or use the button. mp3, wav, ogg, flac,
  m4a, opus, aac all work. No ffmpeg needed.
- **Calibrate the gate** — press **Calibrate**, stay quiet three seconds. The threshold is set
  just above your measured noise floor.
- **Set hotkeys** — click the faint `+ hotkey` on any pad and press a combination.
- **Start with Windows** — tick it, and the switching becomes a one-time job forever.

---

## Daily use

Closing the window hides it to the tray; the mic keeps flowing, so Discord's input can stay on
`CABLE Output` permanently. Only **Quit** from the tray menu actually stops your voice. The
tray icon is green while your mic is genuinely reaching Discord and red when it is not.

| Action | How |
|---|---|
| Play a clip | Click its pad, or press its hotkey from anywhere, including in a fullscreen game |
| Bind a hotkey | Click the `+ hotkey` label on the pad |
| Rename, trim, set volume | Click `⋯` on the pad, or right-click it |
| Preview without broadcasting | **Preview (only you)** in the editor — plays to your headphones only, safe mid-call |
| Stop everything | **Stop all**, or `Ctrl + Alt + X` |
| Mute your mic | Tray menu → Mute microphone |

Clips are copied into the app's own folder on import, so moving or deleting the original file
never breaks a button.

---

## Settings reference

**Devices** — *To Discord* is the cable, *Microphone* is your real mic, *Monitor* is your
headphones. Never set Monitor to the cable; that would double every clip in the call.

**Overlap** — whether clips layer, restart, or cut each other off.

**Mic noise gate** — Discord's noise suppression has to be off while clips play, and Chromium
refuses to run its own suppression with the echo canceller disabled, so the app gates the mic
itself, upstream of where the mic meets the clips. Per-source processing is something Discord
structurally cannot do, because it only ever sees the blended stream. *Release* and *Hold*
control how long the gate stays open after you stop talking — raise *Hold* if the ends of your
words get clipped. A gate removes room tone between words, not noise during them.

**Auto-switch Discord** — see step 6. It only ever writes settings it has to change: it reads
your voice settings as a baseline on connect, diffs every change against it, and restores only
the fields it touched. Volumes, output device, voice mode, QoS, self-mute, and self-deafen are
never written at all.

**Hold on cable after clip** — keeps the override up briefly after playback so a burst of pad
presses doesn't restart Discord's capture pipeline each time. Clips fired inside that window
play with no switching delay.

**Theme** — dark, light, or match Windows.

**Layering is safe.** Clips sum, and unmanaged that overshoots full scale — three at once
measured 1.32 where 1.0 is the ceiling, heard as static and as a drop in level. A limiter on
the clip bus, never on your voice, holds it down; one or two clips pass through untouched. If
the status bar reads *limiting −N dB* while clips play, your per-clip volumes are hotter than
the number you are layering.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Discord broadcasts music, browser, games | `CABLE Input` is still a Windows default. See step 4, and check the **Default Communication Device** separately. |
| Clips sound pitch-shifted | A device is not at 48000 Hz. See step 3. |
| Clip plays about a second then goes silent | Discord's Krisp or echo cancellation. Set up step 6, or disable them by hand. |
| Nobody hears the clips | Discord's input isn't `CABLE Output`, or the app's output isn't `CABLE Input`. |
| Static when several clips play at once | Should be handled by the limiter — if not, lower the per-clip volumes. |
| A hotkey does nothing | Another app registered it first. The pad shows it in red; rebind it. |
| Device dropdowns empty or unnamed | Microphone permission was denied. Chromium hides all device names until it is granted. |
| Your voice cuts out when a clip plays | Discord's echo cancellation is still on. |
| Nothing transmits at all | Discord is set to push-to-talk. The RPC status line warns about this. |

---

## Building from source

```bash
npm install
```

```bash
npm start
```

```bash
npm run dist
```

```bash
npm run smoke
```

`npm run smoke` launches the built app and asserts that exactly one of the two screens is
visible. It exists because that failure is silent — `#app` starts hidden in the markup, so any
startup path that forgets to reveal a screen yields a blank window with no error logged
anywhere. Run it after every build.

`npm run icons` regenerates the tray and window icons, which are drawn in code rather than
committed as binaries.

Your board lives in `%APPDATA%\discord-soundboard`, independent of the install location, so
installing over a source checkout keeps your clips, hotkeys, and calibration. RPC credentials
are kept in `rpc-credentials.json` in that folder, separate from the clip library — treat that
file like a password.

---

## Layout

| File | Role |
|---|---|
| `main.js` | Window, tray, mic permission, all disk I/O, global shortcuts |
| `preload.mjs` | The renderer's entire IPC surface |
| `src/audio.js` | The mixer — dual 48 kHz contexts, mic path, clip limiter, playback |
| `src/noise-gate.worklet.js` | The gate, running on the audio thread |
| `src/rpc-voice.mjs` | Discord RPC client over the named pipe; baseline diff and restore |
| `src/app.js` | UI shell, device pickers, board, import |
| `src/library.js` | Clip model and debounced persistence |
| `src/waveform.js` | Peak rendering and the drag-to-trim editor |
| `src/hotkeys.js` | KeyboardEvent → Electron accelerator |
| `src/setup.js` | VB-CABLE detection and the four-way routing check |
| `src/wizard.js` | First-run setup wizard; every step self-verifies |
| `tools/make-icons.mjs` | Generates the icons |
| `tools/smoke.mjs` | Post-build check that the UI actually rendered |

---

## Known limits

- **Windows only.** The whole design rests on a Windows virtual audio device and Discord's
  desktop RPC pipe.
- **Discord desktop only.** There is no way to route this to Discord on a phone — see below.
- **The app must be running to talk**, because it owns the mic path. Hence the tray.
- **Not code-signed**, so SmartScreen warns on first run.
