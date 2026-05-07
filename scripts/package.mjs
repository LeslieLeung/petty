#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import process from "node:process";

const PLATFORM_CONFIG = {
  macos: {
    host: "darwin",
    displayName: "macOS",
    bundles: ["app", "dmg"],
    targetFlag: null,
  },
  windows: {
    host: "win32",
    displayName: "Windows",
    bundles: ["nsis", "msi"],
    targetFlag: null,
  },
};

const platform = process.argv[2];
const passthroughArgs = process.argv.slice(3);

if (!platform || !PLATFORM_CONFIG[platform]) {
  console.error("Usage: npm run package:<mac|windows> [-- extra tauri build args]");
  console.error("Examples:");
  console.error("  npm run package:mac");
  console.error("  npm run package:windows");
  console.error("  npm run package:mac -- --no-sign");
  process.exit(1);
}

const config = PLATFORM_CONFIG[platform];

if (process.platform !== config.host) {
  console.error(
    `${config.displayName} installers must be built on ${config.displayName}. ` +
      `Current host is ${process.platform}.`
  );
  console.error("Run this script on the matching OS, or use CI runners for each platform.");
  process.exit(1);
}

const args = ["tauri", "build", "--bundles", config.bundles.join(",")];

if (config.targetFlag) {
  args.push("--target", config.targetFlag);
}

args.push(...passthroughArgs);

const result = spawnSync("npx", args, {
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
