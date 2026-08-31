// Discord RPC client — automates the two settings a soundboard on a virtual
// cable would otherwise make you change by hand.
//
// While a clip is playing, Discord's input is pointed at the cable and its voice
// processing is switched off, because Krisp would otherwise treat the clip as
// noise and shred it. The moment playback stops, everything goes back exactly as
// it was.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: never write a setting we did not have to
// change. Every mutation is diffed against a captured baseline first, only
// differing fields are sent, and only those same fields are written back on
// restore. Volumes, voice mode, QoS, self-mute, self-deafen, and the output
// device are never included in a payload — not even to set them to the value
// they already hold.
//
// Transport is the Windows named pipe (\\.\pipe\discord-ipc-N), not the
// WebSocket transport, because the WHATWG WebSocket client in Node cannot set
// the Origin header that Discord's socket transport requires.

import net from "node:net";
import { EventEmitter } from "node:events";
import crypto from "node:crypto";

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;

// Only these are ever written. Anything not in this list cannot be touched by
// construction, which is easier to trust than remembering not to add it.
const FILTER_FIELDS = ["noise_suppression", "echo_cancellation", "automatic_gain_control"];

const CABLE_INPUT_PATTERN = /^CABLE Output/i; // Discord's *input* is the cable's output side

const CONNECT_TIMEOUT_MS = 4000;
const COMMAND_TIMEOUT_MS = 8000;

export class RpcVoice extends EventEmitter {
  constructor() {
    super();
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map(); // nonce -> { resolve, reject, timer, sentAt }

    this.connected = false;
    this.authenticated = false;

    this.baseline = null; // voice settings as they were before we touched anything
    this.touched = null; // which fields we changed, so restore writes only those
    this.engaged = false;
    this.overriding = false; // guards baseline capture against our own writes

    this.cableDeviceId = null;
    this.voiceMode = null; // read-only diagnostics; never written back
    this.inVoiceChannel = false;
    this.lastSwitchMs = null; // measured round trip of the engage command

    this.activeClips = 0;
    this.hangoverTimer = null;
    this.hangoverMs = 900;

    this.lastError = null;
  }

  // --- transport ------------------------------------------------------------

  #encode(op, payload) {
    const data = Buffer.from(JSON.stringify(payload), "utf8");
    const header = Buffer.alloc(8);
    header.writeInt32LE(op, 0);
    header.writeInt32LE(data.length, 4);
    return Buffer.concat([header, data]);
  }

  #send(op, payload) {
    if (!this.socket) throw new Error("not connected to Discord");
    this.socket.write(this.#encode(op, payload));
  }

  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    // Frames are length-prefixed and can be split or coalesced across reads, so
    // drain only whole frames and leave any partial one buffered.
    while (this.buffer.length >= 8) {
      const op = this.buffer.readInt32LE(0);
      const length = this.buffer.readInt32LE(4);
      if (this.buffer.length < 8 + length) break;

      const body = this.buffer.subarray(8, 8 + length).toString("utf8");
      this.buffer = this.buffer.subarray(8 + length);

      let message;
      try {
        message = JSON.parse(body);
      } catch {
        continue;
      }

      if (op === OP_PING) {
        this.#send(OP_PONG, message);
        continue;
      }
      if (op === OP_CLOSE) {
        this.#fail(new Error(message.message || "Discord closed the connection"));
        continue;
      }
      if (op === OP_FRAME) this.#onFrame(message);
    }
  }

  #onFrame(message) {
    const waiter = message.nonce && this.pending.get(message.nonce);
    if (waiter) {
      this.pending.delete(message.nonce);
      clearTimeout(waiter.timer);
      if (message.evt === "ERROR") {
        waiter.reject(new Error(message.data?.message ?? "RPC error"));
      } else {
        waiter.resolve({ data: message.data, elapsed: Date.now() - waiter.sentAt });
      }
      return;
    }

    if (message.cmd === "DISPATCH") this.#onDispatch(message.evt, message.data);
  }

  #onDispatch(event, data) {
    if (event === "READY") {
      this.emit("ready");
      return;
    }

    if (event === "VOICE_CHANNEL_SELECT") {
      this.inVoiceChannel = Boolean(data?.channel_id);
      // Leaving a call while a clip is mid-flight would otherwise strand the
      // override in place.
      if (!this.inVoiceChannel && this.engaged) this.restore().catch(() => {});
      this.emit("state");
    }

    if (event === "VOICE_SETTINGS_UPDATE") {
      // While we are not overriding, whatever Discord reports IS the baseline —
      // this is how a setting the user changes themselves gets picked up rather
      // than being clobbered by a stale snapshot on the next restore.
      //
      // `overriding` is essential, not belt-and-braces: our own SET command also
      // triggers this event, and it can arrive before the command response sets
      // `engaged`. Without the flag we would occasionally record the cable and
      // the disabled filters AS the baseline, and then "restore" to them —
      // permanently. That is the one bug that would silently eat the user's
      // real settings.
      if (!this.engaged && !this.overriding) this.#captureBaseline(data);
      this.emit("state");
    }
  }

  #fail(error) {
    this.lastError = error.message;
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
    this.connected = false;
    this.authenticated = false;
    this.engaged = false;
    this.overriding = false;
    this.emit("state");
  }

  #command(payload) {
    const nonce = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(nonce);
        reject(new Error(`${payload.cmd} timed out`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(nonce, { resolve, reject, timer, sentAt: Date.now() });
      try {
        this.#send(OP_FRAME, { ...payload, nonce });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(nonce);
        reject(err);
      }
    });
  }

  // Discord listens on the first free pipe in 0..9, so probe them in order.
  #openPipe() {
    return new Promise((resolve, reject) => {
      let index = 0;
      const attempt = () => {
        if (index > 9) {
          reject(new Error("Discord isn't running, or its RPC pipe wasn't found"));
          return;
        }
        const path = `\\\\?\\pipe\\discord-ipc-${index++}`;
        const socket = net.createConnection(path);
        const timer = setTimeout(() => {
          socket.destroy();
          attempt();
        }, CONNECT_TIMEOUT_MS);

        socket.once("connect", () => {
          clearTimeout(timer);
          socket.removeAllListeners("error");
          resolve(socket);
        });
        socket.once("error", () => {
          clearTimeout(timer);
          socket.destroy();
          attempt();
        });
      };
      attempt();
    });
  }

  // --- connection lifecycle -------------------------------------------------

  async connect({ clientId, clientSecret, accessToken }) {
    if (!clientId) throw new Error("no Discord application client ID configured");

    this.socket = await this.#openPipe();
    this.socket.on("data", (chunk) => this.#onData(chunk));
    this.socket.on("close", () => this.#fail(new Error("Discord RPC connection closed")));
    this.socket.on("error", (err) => this.#fail(err));

    // READY arrives as a dispatch carrying no nonce, so it cannot be awaited
    // through the normal command path.
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Discord never sent READY")), COMMAND_TIMEOUT_MS);
      this.once("ready", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    this.#send(OP_HANDSHAKE, { v: 1, client_id: clientId });
    await ready;
    this.connected = true;

    let token = accessToken;
    if (!token) {
      if (!clientSecret) throw new Error("a client secret is required the first time, to complete authorization");
      token = await this.#authorize(clientId, clientSecret);
      this.emit("token", token);
    }

    try {
      await this.#command({ cmd: "AUTHENTICATE", args: { access_token: token } });
    } catch (err) {
      // A stale or revoked token has to be re-earned, which needs the secret.
      if (!clientSecret) throw err;
      token = await this.#authorize(clientId, clientSecret);
      this.emit("token", token);
      await this.#command({ cmd: "AUTHENTICATE", args: { access_token: token } });
    }
    this.authenticated = true;

    await this.#command({ cmd: "SUBSCRIBE", evt: "VOICE_SETTINGS_UPDATE", args: {} });
    await this.#command({ cmd: "SUBSCRIBE", evt: "VOICE_CHANNEL_SELECT", args: {} });

    const settings = await this.#command({ cmd: "GET_VOICE_SETTINGS", args: {} });
    this.#captureBaseline(settings.data);

    const channel = await this.#command({ cmd: "GET_SELECTED_VOICE_CHANNEL", args: {} }).catch(() => ({ data: null }));
    this.inVoiceChannel = Boolean(channel.data?.id);

    this.lastError = null;
    this.emit("state");
  }

  async #authorize(clientId, clientSecret) {
    const result = await this.#command({
      cmd: "AUTHORIZE",
      args: {
        client_id: clientId,
        // The narrowest set that permits reading the baseline and writing it back.
        scopes: ["rpc", "rpc.voice.read", "rpc.voice.write"],
      },
    });

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      code: result.data.code,
      redirect_uri: "http://localhost",
    });

    const response = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) {
      throw new Error(`token exchange failed (${response.status}) — check the client secret and that http://localhost is a registered redirect`);
    }
    const json = await response.json();
    return json.access_token;
  }

  async disconnect() {
    await this.restore().catch(() => {});
    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
    this.authenticated = false;
    this.emit("state");
  }

  // --- baseline and overrides ----------------------------------------------

  #captureBaseline(settings) {
    if (!settings) return;
    this.baseline = {
      input_device_id: settings.input?.device_id ?? null,
      noise_suppression: settings.noise_suppression,
      echo_cancellation: settings.echo_cancellation,
      automatic_gain_control: settings.automatic_gain_control,
    };

    const devices = settings.input?.available_devices ?? [];
    this.cableDeviceId = devices.find((device) => CABLE_INPUT_PATTERN.test(device.name))?.id ?? null;

    // Read-only, and deliberately kept out of `baseline` so it can never end up
    // in a write payload. Discord's voice activity detection is a gate in its
    // own right: with a manual threshold set above the clip level it will stop
    // transmitting partway through a clip, which looks exactly like a filter
    // eating it. Worth being able to see; not ours to change.
    this.voiceMode = {
      type: settings.mode?.type ?? null,
      autoThreshold: settings.mode?.auto_threshold ?? null,
      threshold: settings.mode?.threshold ?? null,
    };
  }

  /**
   * Build the smallest possible payload: only fields whose current value is not
   * already what playback needs. A field that already holds the right value is
   * left out entirely and is not recorded as touched, so restore will not write
   * it either.
   */
  buildEngagePayload() {
    const payload = {};
    const touched = [];

    if (this.cableDeviceId && this.baseline.input_device_id !== this.cableDeviceId) {
      // device_id only. Including `volume` here would overwrite the user's input
      // level, which is exactly what we were asked never to do.
      payload.input = { device_id: this.cableDeviceId };
      touched.push("input_device_id");
    }
    for (const field of FILTER_FIELDS) {
      if (this.baseline[field] === true) {
        payload[field] = false;
        touched.push(field);
      }
    }
    return { payload, touched };
  }

  buildRestorePayload() {
    const payload = {};
    for (const field of this.touched ?? []) {
      if (field === "input_device_id") payload.input = { device_id: this.baseline.input_device_id };
      else payload[field] = this.baseline[field];
    }
    return payload;
  }

  async engage() {
    if (!this.authenticated || !this.baseline) return false;
    if (this.engaged) return true;
    if (!this.inVoiceChannel) return false; // nothing to do outside a call
    if (!this.cableDeviceId) {
      this.lastError = "Discord doesn't list a CABLE Output input device";
      return false;
    }

    const { payload, touched } = this.buildEngagePayload();
    if (touched.length === 0) {
      this.engaged = true; // already in the right state; nothing was written
      this.touched = [];
      this.emit("state");
      return true;
    }

    // Raised before the write so the echoed VOICE_SETTINGS_UPDATE cannot be
    // mistaken for a user-made change and recorded as the new baseline.
    this.overriding = true;
    try {
      const result = await this.#command({ cmd: "SET_VOICE_SETTINGS", args: payload });
      this.lastSwitchMs = result.elapsed;
      this.touched = touched;
      this.engaged = true;
    } catch (err) {
      this.overriding = false;
      throw err;
    }
    this.emit("state");
    return true;
  }

  async restore() {
    if (!this.engaged) return;
    const payload = this.buildRestorePayload();
    this.engaged = false;
    // `overriding` deliberately stays raised here — it is only lowered once the
    // restore write has been echoed back, below.
    const touched = this.touched;
    this.touched = null;

    if (!touched || touched.length === 0) {
      this.overriding = false;
      this.emit("state");
      return;
    }
    try {
      await this.#command({ cmd: "SET_VOICE_SETTINGS", args: payload });
    } finally {
      // Stays raised until the restore write has been echoed back, so the event
      // it generates is not mistaken for a user change either.
      setTimeout(() => (this.overriding = false), 250);
    }
    this.emit("state");
  }

  // --- playback tracking ----------------------------------------------------

  /**
   * Called when a clip is about to be sent to the cable. Resolves once Discord
   * is actually listening to the cable, so the opening moments of the clip are
   * not lost to the input switch.
   */
  async clipStarting() {
    this.activeClips += 1;
    clearTimeout(this.hangoverTimer);
    this.hangoverTimer = null;
    if (!this.connected) return;
    try {
      await this.engage();
    } catch (err) {
      this.lastError = err.message;
      this.emit("state");
    }
  }

  /**
   * Called when a clip finishes. The revert is deliberately delayed: switching
   * the input device costs a capture-pipeline rebuild, and reverting instantly
   * would make a burst of pad presses thrash it. Any clip fired inside the
   * hangover window plays with no switching delay at all.
   */
  clipEnded() {
    this.activeClips = Math.max(0, this.activeClips - 1);
    if (this.activeClips > 0) return;

    clearTimeout(this.hangoverTimer);
    this.hangoverTimer = setTimeout(() => {
      this.hangoverTimer = null;
      if (this.activeClips === 0) this.restore().catch((err) => (this.lastError = err.message));
    }, this.hangoverMs);
  }

  getState() {
    return {
      connected: this.connected,
      authenticated: this.authenticated,
      engaged: this.engaged,
      inVoiceChannel: this.inVoiceChannel,
      cableFound: Boolean(this.cableDeviceId),
      voiceMode: this.voiceMode ?? null,
      lastSwitchMs: this.lastSwitchMs,
      activeClips: this.activeClips,
      error: this.lastError,
    };
  }
}
