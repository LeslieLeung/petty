#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import process from "node:process";

const PLATFORM_CONFIG = {
  macos: {
    host: "darwin",
    displayName: "macOS",
    bundles: ["app", "dmg"],
    defaultTarget: "universal",
    targetMap: {
      aarch64: "aarch64-apple-darwin",
      x86_64: "x86_64-apple-darwin",
      universal: "universal-apple-darwin",
    },
  },
  windows: {
    host: "win32",
    displayName: "Windows",
    bundles: ["nsis", "msi"],
    defaultTarget: "x86_64",
    targetMap: {
      x86_64: "x86_64-pc-windows-msvc",
      arm64: "aarch64-pc-windows-msvc",
      aarch64: "aarch64-pc-windows-msvc",
    },
  },
};

const platform = process.argv[2];
const rawArgs = process.argv.slice(3);

if (!platform || !PLATFORM_CONFIG[platform]) {
  console.error("Usage: npm run package:<mac|windows> [arch] [-- extra tauri build args]");
  console.error("Examples:");
  console.error("  npm run package:mac");
  console.error("  npm run package:mac:aarch64");
  console.error("  npm run package:mac -- x86_64");
  console.error("  npm run package:windows");
  console.error("  npm run package:mac -- --no-sign");
  process.exit(1);
}

const config = PLATFORM_CONFIG[platform];
let target = config.defaultTarget;
let passthroughArgs = rawArgs;

if ((platform === "macos" || platform === "windows") && rawArgs.length > 0 && !rawArgs[0].startsWith("-")) {
  target = rawArgs[0];
  passthroughArgs = rawArgs.slice(1);
}

if (process.platform !== config.host) {
  console.error(
    `${config.displayName} installers must be built on ${config.displayName}. ` +
      `Current host is ${process.platform}.`
  );
  console.error("Run this script on the matching OS, or use CI runners for each platform.");
  process.exit(1);
}

// For macOS universal builds, Tauri only lipo's the main binary automatically.
// Additional [[bin]] entries must be manually built for both archs and lipo'd first.
if (platform === "macos" && target === "universal") {
  const extraBins = ["petty-agent-hook"];
  const archs = ["aarch64-apple-darwin", "x86_64-apple-darwin"];
  const universalDir = "src-tauri/target/universal-apple-darwin/release";

  for (const bin of extraBins) {
    for (const arch of archs) {
      console.log(`Building ${bin} for ${arch}...`);
      const buildResult = spawnSync(
        "cargo",
        ["build", "--release", "--target", arch, "--bin", bin],
        { stdio: "inherit", cwd: "src-tauri" }
      );
      if (buildResult.status !== 0) {
        console.error(`Failed to build ${bin} for ${arch}`);
        process.exit(buildResult.status ?? 1);
      }
    }

    spawnSync("mkdir", ["-p", universalDir], { stdio: "inherit" });

    console.log(`Creating universal binary for ${bin}...`);
    const lipoResult = spawnSync(
      "lipo",
      [
        "-create",
        "-output",
        `${universalDir}/${bin}`,
        `src-tauri/target/aarch64-apple-darwin/release/${bin}`,
        `src-tauri/target/x86_64-apple-darwin/release/${bin}`,
      ],
      { stdio: "inherit" }
    );
    if (lipoResult.status !== 0) {
      console.error(`Failed to lipo ${bin}`);
      process.exit(lipoResult.status ?? 1);
    }
  }
}

const args = ["tauri", "build", "--bundles", config.bundles.join(",")];

if (target) {
  const targetFlag = config.targetMap[target];
  if (!targetFlag) {
    console.error(
      `Invalid ${config.displayName} arch "${target}". Supported values: ${Object.keys(config.targetMap).join(", ")}`
    );
    process.exit(1);
  }
  args.push("--target", targetFlag);
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
