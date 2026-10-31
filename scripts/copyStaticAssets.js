#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SOURCE_DIRS = [
  path.join(ROOT, "src", "support-tools", "assets"),
  path.join(ROOT, "assets"),
];
const DEST_DIR = path.join(ROOT, "dist", "support-tools", "assets");

function copyAssets() {
  fs.rmSync(DEST_DIR, { recursive: true, force: true });

  let copiedAny = false;
  for (const srcDir of SOURCE_DIRS) {
    if (!fs.existsSync(srcDir)) continue;
    if (!copiedAny) {
      fs.mkdirSync(DEST_DIR, { recursive: true });
      copiedAny = true;
    }
    // Fixture provenance is packaged at assets/README.md, where its docs links
    // resolve correctly. It is not a runtime asset in the relocated dist tree.
    fs.cpSync(srcDir, DEST_DIR, {
      recursive: true,
      filter: source => source !== path.join(ROOT, "assets", "README.md"),
    });
  }

  fs.cpSync(path.join(ROOT, "examples/scenarios"), path.join(DEST_DIR, "scenarios"), { recursive: true });
  return copiedAny;
}

try {
  fs.chmodSync(path.join(ROOT, "dist", "cli.js"), 0o755);
  const didCopy = copyAssets();
  if (didCopy) {
    console.info(`Copied static assets to ${DEST_DIR}`);
  } else {
    console.info("No static asset directories found to copy.");
  }
} catch (err) {
  console.error("Failed to copy static assets:", err);
  process.exitCode = 1;
}
