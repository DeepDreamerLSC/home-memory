"use strict";
// NODE_PATH=<bundled runtime>/node_modules node scripts/generate-personalization-assets.js
const fs = require("node:fs/promises");
const path = require("node:path");
const sharp = require("sharp");
const root = path.resolve(__dirname, "..");
async function main() {
  const html = await fs.readFile(path.join(root, "docs/design/personalization-v1/index.html"), "utf8");
  const legacy = await fs.readFile(path.join(root, "scripts/generate-ui-assets.js"), "utf8");
  const symbols = new Map([...html.matchAll(/<symbol id="([^"]+)" viewBox="([^"]+)">([\s\S]*?)<\/symbol>/g)].map(m => [m[1], { viewBox: m[2], body: m[3] }]));
  for (const [name, viewBox] of [["storage", "0 0 180 120"], ["generic", "0 0 80 70"]]) {
    const match = legacy.match(new RegExp(`const ${name} = '([^']+)';`));
    if (!match) throw new Error(`Missing neutral artwork: ${name}`);
    symbols.set(`art-${name}`, { viewBox, body: match[1] });
  }
  const palettes = [...html.matchAll(/(\w+): \{light:(\[[^\]]+\]),dark:(\[[^\]]+\])\}/g)];
  if (palettes.length !== 8) throw new Error("Expected eight approved palettes");
  let bytes = 0, count = 0;
  for (const [, id, light, dark] of palettes) {
    for (const [mode, source] of [["light", light], ["dark", dark]]) {
      const colors = JSON.parse(source.replace(/'/g, '"'));
      const mapping = { line: colors[10], mid: colors[11], light: colors[12], dark: colors[13], accent: colors[14] };
      const directory = path.join(root, "miniprogram/assets/themes", id);
      await fs.mkdir(directory, { recursive: true });
      await Promise.all(["living", "bedroom", "study", "kitchen", "storage", "key", "medicine", "book", "generic"].map(async name => {
        const symbol = symbols.get(`art-${name}`);
        if (!symbol) throw new Error(`Missing ${name}`);
        const [, , width, height] = symbol.viewBox.split(" ").map(Number);
        const body = symbol.body.replace(/var\(--room-([a-z]+)\)/g, (_, key) => mapping[key]).replace(/currentColor/g, colors[2]);
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width * 3}" height="${height * 3}" viewBox="${symbol.viewBox}">${body}</svg>`;
        const info = await sharp(Buffer.from(svg)).png({ palette: true, colours: 128, effort: 10 }).toFile(path.join(directory, `${name}${mode === "dark" ? "-dark" : ""}.png`));
        bytes += info.size; count++;
      }));
    }
  }
  console.log(JSON.stringify({ palettes: 8, modes: 2, count, bytes, kib: +(bytes / 1024).toFixed(1) }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
