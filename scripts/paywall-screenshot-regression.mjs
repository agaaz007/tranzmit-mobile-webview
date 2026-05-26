import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const breakpoints = [
  { id: "android_360x740", width: 360, height: 740 },
  { id: "iphone_390x844", width: 390, height: 844 },
  { id: "android_412x915", width: 412, height: 915 },
  { id: "tablet_768x1024", width: 768, height: 1024 },
];

const outputDir = process.env.PAYWALL_SCREENSHOT_DIR || "artifacts/paywall-screenshots";
const activity = process.env.ANDROID_ACTIVITY || "com.example.tranzmit_flutter_example/.MainActivity";
const settleMs = Number(process.env.PAYWALL_SCREENSHOT_SETTLE_MS || "2500");

function adb(args, options = {}) {
  return execFileSync("adb", args, { stdio: options.stdio || "pipe" }).toString();
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function startApp() {
  spawnSync("adb", ["shell", "am", "start", "-n", activity], { stdio: "ignore" });
}

mkdirSync(outputDir, { recursive: true });

const manifest = {
  generatedAt: new Date().toISOString(),
  activity,
  breakpoints,
  captures: [],
};

try {
  adb(["get-state"]);
  for (const breakpoint of breakpoints) {
    adb(["shell", "wm", "size", `${breakpoint.width}x${breakpoint.height}`]);
    startApp();
    sleep(settleMs);

    const fileName = `${breakpoint.id}.png`;
    const target = join(outputDir, fileName);
    const screenshot = execFileSync("adb", ["exec-out", "screencap", "-p"]);
    writeFileSync(target, screenshot);
    manifest.captures.push({ ...breakpoint, file: target });
    console.log(`Captured ${target}`);
  }
} finally {
  try {
    adb(["shell", "wm", "size", "reset"], { stdio: "ignore" });
  } catch {
    // Best effort reset; adb can fail if the emulator is already gone.
  }
}

writeFileSync(join(outputDir, "manifest.json"), JSON.stringify(manifest, null, 2));
