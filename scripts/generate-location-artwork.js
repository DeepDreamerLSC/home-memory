"use strict";
// NODE_PATH=<bundled runtime>/node_modules node scripts/generate-location-artwork.js
const fs = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
// Five-color flat art needs only a small indexed palette; 270px covers 150px cards at 1.8×.
const WIDTH = 270;
const HEIGHT = 180;
const BUDGET = 500 * 1024;
const EXISTING_PACKAGE_BYTES = 1512720;
const MAIN_PACKAGE_LIMIT = 2 * 1024 * 1024;

async function loadInputs() {
  const context = { window: {} };
  for (const name of ["spaces", "furniture", "containers"]) {
    const filename = path.join(root, "docs/design/location-artwork-v1", name + ".js");
    vm.runInNewContext(await fs.readFile(filename, "utf8"), context, { filename, timeout: 1000 });
  }
  const drawings = Object.values(context.window).flat();
  if (drawings.length !== 24 || new Set(drawings.map(art => art.id)).size !== 24) {
    throw new Error("Expected 24 unique approved location illustrations");
  }
  for (const art of drawings) {
    if (!/^[a-z]+(?:-[a-z]+)*$/.test(art.id) || !art.body || /<(?:script|image|foreignObject)\b/i.test(art.body)) {
      throw new Error("Unsafe location illustration: " + art.id);
    }
  }
  const source = await fs.readFile(path.join(root, "miniprogram/utils/appearance.ts"), "utf8");
  const start = source.indexOf("= {", source.indexOf("export const PALETTES")) + 2;
  const end = source.indexOf("\n};", start) + 2;
  const palettes = JSON.parse(source.slice(start, end));
  if (Object.keys(palettes).length !== 8) throw new Error("Expected eight app palettes");
  return { drawings, palettes };
}

function makeSvg(art, colors) {
  const values = { line: colors[10], mid: colors[11], light: colors[12], dark: colors[13], accent: colors[14] };
  let body = art.body.replace(/var\(--art-([a-z]+)\)/g, (_, key) => {
    if (!/^#[0-9a-f]{6}$/i.test(values[key] || "")) throw new Error("Missing illustration color: " + key);
    return values[key];
  }).replace(/currentColor/g, colors[2]);
  if (/var\(/.test(body)) throw new Error("Unresolved illustration variable: " + art.id);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 180 120">${body}</svg>`;
}

async function main() {
  const sharp = require("sharp");
  const { drawings, palettes } = await loadInputs();
  let bytes = 0, count = 0;
  for (const [palette, modes] of Object.entries(palettes)) {
    const directory = path.join(root, "miniprogram/assets/location-artwork", palette);
    await fs.mkdir(directory, { recursive: true });
    for (const mode of ["light", "dark"]) {
      for (const art of drawings) {
        const svg = makeSvg(art, modes[mode]);
        const file = path.join(directory, art.id + (mode === "dark" ? "-dark" : "") + ".png");
        const info = await sharp(Buffer.from(svg)).png({ palette: true, colours: 16, effort: 10 }).toFile(file);
        bytes += info.size;
        count++;
      }
    }
  }
  console.log(JSON.stringify({ palettes: 8, modes: 2, drawings: 24, count, width: WIDTH, height: HEIGHT, bytes, kib: +(bytes / 1024).toFixed(1) }));
  if (EXISTING_PACKAGE_BYTES + bytes > MAIN_PACKAGE_LIMIT) throw new Error("Conservative main-package estimate exceeds 2 MiB");
  if (bytes > BUDGET) throw new Error("Location artwork exceeds 500 KiB package budget; review resolution/quantization before shipping");
}

module.exports = { loadInputs, makeSvg, WIDTH, HEIGHT, BUDGET };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
