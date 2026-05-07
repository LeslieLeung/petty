#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const paths = {
  tauriConfig: join(repoRoot, "src-tauri", "tauri.conf.json"),
  packageJson: join(repoRoot, "package.json"),
  packageLock: join(repoRoot, "package-lock.json"),
  cargoToml: join(repoRoot, "src-tauri", "Cargo.toml"),
  cargoLock: join(repoRoot, "src-tauri", "Cargo.lock"),
};

const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function replacePackageVersionToml(content, version) {
  const packageBlockPattern = /(\[package\][\s\S]*?\nversion\s*=\s*)"[^"]+"/;
  if (!packageBlockPattern.test(content)) {
    throw new Error("Could not find [package] version in src-tauri/Cargo.toml");
  }
  return content.replace(packageBlockPattern, `$1"${version}"`);
}

function replacePackageVersionLock(content, packageName, version) {
  const packagePattern = new RegExp(
    `(\\[\\[package\\]\\]\\r?\\nname = "${packageName}"\\r?\\nversion = )"[^"]+"`
  );
  if (!packagePattern.test(content)) {
    throw new Error(`Could not find ${packageName} package version in src-tauri/Cargo.lock`);
  }
  return content.replace(packagePattern, `$1"${version}"`);
}

const tauriConfig = readJson(paths.tauriConfig);
const version = tauriConfig.version;

if (typeof version !== "string" || !semverPattern.test(version)) {
  throw new Error(
    "src-tauri/tauri.conf.json version must be a semver string, for example 0.1.0"
  );
}

const packageJson = readJson(paths.packageJson);
packageJson.version = version;
writeJson(paths.packageJson, packageJson);

const packageLock = readJson(paths.packageLock);
packageLock.version = version;
if (packageLock.packages?.[""]) {
  packageLock.packages[""].version = version;
}
writeJson(paths.packageLock, packageLock);

const cargoToml = readFileSync(paths.cargoToml, "utf8");
writeFileSync(paths.cargoToml, replacePackageVersionToml(cargoToml, version));

const cargoLock = readFileSync(paths.cargoLock, "utf8");
writeFileSync(paths.cargoLock, replacePackageVersionLock(cargoLock, "petty", version));

console.log(`Synced app version ${version} from src-tauri/tauri.conf.json`);
