"use strict";

// Diagnostic overlay only: native text rasterization is not a visual pass/fail metric.
const fs = require("node:fs/promises");
const path = require("node:path");
const sharp = require("sharp");
const pixelmatchModule = require("pixelmatch");
const pixelmatch = pixelmatchModule.default || pixelmatchModule;
const directory = path.resolve(__dirname, "../.omx/artifacts/ui-polish-v1");

async function main() {
  const reference = path.join(directory, "reference-home-content.png");
  const native = path.join(directory, "home.png");
  const referenceMeta = await sharp(reference).metadata();
  const nativeMeta = await sharp(native).metadata();
  const checks = JSON.parse(await fs.readFile(path.join(directory, "checks.json"), "utf8"));
  const nativeScreenHeight = nativeMeta.height * checks.width / nativeMeta.width;
  const nativeTop = Math.round((nativeScreenHeight - checks.height) * nativeMeta.width / checks.width);
  const width = referenceMeta.width;
  const height = referenceMeta.height;
  const referencePixels = await sharp(reference).ensureAlpha().raw().toBuffer();
  const normalized = await sharp(native).extract({ left: 0, top: nativeTop, width: nativeMeta.width, height: nativeMeta.height - nativeTop }).resize({ width }).png().toBuffer();
  const nativePixels = await sharp(normalized).extract({ left: 0, top: 0, width, height }).ensureAlpha().raw().toBuffer();
  const diff = Buffer.alloc(width * height * 4);
  const changed = pixelmatch(referencePixels, nativePixels, diff, width, height, { threshold: .15, includeAA: false });
  await sharp(diff, { raw: { width, height, channels: 4 } }).png().toFile(path.join(directory, "home-diff.png"));
  const overlay = Buffer.from(referencePixels);
  for (let i = 0; i < overlay.length; i += 4) {
    for (let channel = 0; channel < 3; channel++) overlay[i + channel] = Math.round((referencePixels[i + channel] + nativePixels[i + channel]) / 2);
  }
  await sharp(overlay, { raw: { width, height, channels: 4 } }).png().toFile(path.join(directory, "home-overlay.png"));
  const result = { width, height, nativeTop, differingPixels: changed, differingFraction: changed / (width * height), note: "Common content viewport only; excludes native navigation, status time and fixed bottom dock. Diagnostic, not an acceptance score." };
  await fs.writeFile(path.join(directory, "pixel-diagnostic.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
