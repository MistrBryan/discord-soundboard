// Launches the built app and asserts that it actually rendered something.
//
// This exists because the failure it catches is silent: #app starts hidden in
// the markup, so any path through startup that forgets to reveal a screen leaves
// a blank window, throws nothing, and logs nothing. Twice now.
//
// Run after a build:  npm run smoke

import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Prefer the packaged binary — that is what users actually run — and fall back
// to the dev Electron when there is no build yet.
const packaged = path.join(ROOT, "dist", "win-unpacked", "Soundboard.exe");
const dev = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");

const usePackaged = fs.existsSync(packaged);
const exe = usePackaged ? packaged : dev;
const args = usePackaged ? [] : [ROOT];

if (!fs.existsSync(exe)) {
  console.error("Nothing to test: no build in dist/ and no electron in node_modules.");
  process.exit(1);
}

console.log(`smoke: launching ${usePackaged ? "packaged build" : "dev build"}`);

const child = spawn(exe, args, {
  cwd: ROOT,
  env: { ...process.env, SOUNDBOARD_SELFCHECK: "1" },
});

let output = "";
const collect = (chunk) => (output += chunk.toString());
child.stdout.on("data", collect);
child.stderr.on("data", collect);

const timer = setTimeout(() => {
  console.error("smoke: FAIL — the app never reported a result within 40s");
  child.kill();
  process.exit(1);
}, 40000);

child.on("exit", (code) => {
  clearTimeout(timer);
  const line = output.split(/\r?\n/).find((l) => l.includes("SELFCHECK"));

  if (!line) {
    console.error("smoke: FAIL — no SELFCHECK line; the window may not have loaded at all");
    console.error(output.trim().slice(-800));
    process.exit(1);
  }

  console.log(`smoke: ${line.trim()}`);
  if (code !== 0 || line.includes("FAIL")) {
    console.error("smoke: FAIL — exactly one of #app / #setup must be visible");
    process.exit(1);
  }
  console.log("smoke: PASS");
});
