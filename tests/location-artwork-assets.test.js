"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { loadInputs, makeSvg } = require("../scripts/generate-location-artwork");
const root = path.join(__dirname, "..");
const ids = [
  "living", "bedroom", "study", "kitchen", "bathroom", "balcony", "entryway", "car",
  "wardrobe", "bookshelf", "refrigerator", "desk", "nightstand", "shoe-cabinet", "drawer-unit", "wall-cabinet",
  "drawer", "storage-box", "carton", "basket", "document-folder", "suitcase", "toolbox", "generic",
];
const palettes = ["cream", "sage", "mist", "clay", "inkGold", "cobalt", "emerald", "berry"];

test("location illustrations cover all 24 approved forms and use the real app palettes", async () => {
  const input = await loadInputs();
  assert.deepEqual(Array.from(input.drawings, art => art.id).sort(), ids.slice().sort());
  assert.deepEqual(Object.keys(input.palettes).sort(), palettes.slice().sort());
  for (const art of input.drawings) {
    for (const palette of Object.values(input.palettes)) {
      for (const mode of ["light", "dark"]) {
        const svg = makeSvg(art, palette[mode]);
        assert.ok(!svg.includes("var("), art.id + " has no unresolved color tokens");
        assert.match(svg, /viewBox="0 0 180 120"/);
      }
    }
  }
  assert.throws(() => makeSvg({ id: "invalid", body: '<rect fill="var(--art-missing)"/>' }, input.palettes.cream.light), /Missing illustration color/);
});

test("all 384 location PNGs have transparent 270×180 canvases and fit the main-package budget", async () => {
  let total = 0;
  for (const palette of palettes) {
    const directory = path.join(root, "miniprogram/assets/location-artwork", palette);
    const expected = ids.flatMap(id => [id + ".png", id + "-dark.png"]).sort();
    assert.deepEqual((await fs.readdir(directory)).sort(), expected);
    for (const file of expected) {
      const png = await fs.readFile(path.join(directory, file));
      total += png.length;
      assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", file);
      assert.equal(png.readUInt32BE(16), 270, file);
      assert.equal(png.readUInt32BE(20), 180, file);
      assert.equal(png[25], 3, "indexed PNG: " + file);
      let hasAlpha = false;
      for (let offset = 8; offset < png.length;) {
        const length = png.readUInt32BE(offset);
        const type = png.toString("ascii", offset + 4, offset + 8);
        if (type === "PLTE") assert.ok(length <= 16 * 3, "at most 16 palette colors: " + file);
        if (type === "tRNS") hasAlpha = true;
        offset += 12 + length;
      }
      assert.ok(hasAlpha, "transparent background: " + file);
    }
  }
  assert.ok(total <= 500 * 1024, `artwork must stay below 500 KiB, received ${total}`);
  assert.ok(1512720 + total <= 2 * 1024 * 1024, "conservative main-package estimate stays below 2 MiB");
});
