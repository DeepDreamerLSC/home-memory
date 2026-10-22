"use strict";

// Run with the bundled Sharp runtime via NODE_PATH; output is committed, no app dependency.
const fs = require("node:fs/promises");
const path = require("node:path");
const sharp = require("sharp");
const root = path.resolve(__dirname, "..");
const palettes = {
  light: { line: "#7b8069", mid: "#d3d5bf", light: "#f8f6e9", dark: "#a9ae91", accent: "#ddc486" },
  dark: { line: "#abb598", mid: "#626f52", light: "#909a75", dark: "#3f4c37", accent: "#b29b65" },
};
const storage = '<ellipse cx="90" cy="105" rx="59" ry="5" fill="var(--room-dark)" opacity=".15"/><path d="M43 28h94v75H43z" fill="var(--room-light)" stroke="var(--room-line)" stroke-width="1.2"/><path d="M44 53h92m-92 25h92" stroke="var(--room-line)" stroke-width="1.2"/><rect x="53" y="34" width="31" height="17" rx="2" fill="var(--room-mid)" stroke="var(--room-line)" stroke-width="1"/><rect x="95" y="32" width="28" height="19" rx="2" fill="var(--room-accent)" stroke="var(--room-line)" stroke-width="1"/><rect x="52" y="59" width="32" height="16" rx="2" fill="var(--room-accent)" stroke="var(--room-line)" stroke-width="1"/><rect x="98" y="57" width="23" height="18" rx="2" fill="var(--room-mid)" stroke="var(--room-line)" stroke-width="1"/><path d="M54 101V88h37v13m9 0V85h25v16" fill="var(--room-mid)" stroke="var(--room-line)" stroke-width="1"/>';
const generic = '<ellipse cx="40" cy="59" rx="24" ry="4" fill="var(--room-dark)" opacity=".18"/><path d="m18 22 22-9 23 9v28l-23 10-22-10Z" fill="var(--room-mid)" stroke="var(--room-line)" stroke-width="1.4"/><path d="m18 22 22 10 23-10M40 32v28m-11-43 23 10v11l-7 3V30L22 20" fill="var(--room-accent)" stroke="var(--room-line)" stroke-width="1.1"/>';

async function main() {
  const html = await fs.readFile(path.join(root, "docs/design/ui-polish-v1/index.html"), "utf8");
  const symbols = new Map([...html.matchAll(/<symbol id="([^"]+)" viewBox="([^"]+)">([\s\S]*?)<\/symbol>/g)].map(match => [match[1], { viewBox: match[2], body: match[3] }]));
  symbols.set("art-storage", { viewBox: "0 0 180 120", body: storage });
  symbols.set("art-generic", { viewBox: "0 0 80 70", body: generic });
  const tasks = [];
  for (const [theme, palette] of Object.entries(palettes)) {
    for (const [id, symbol] of symbols) {
      const room = ["living", "bedroom", "study", "kitchen", "storage"].includes(id.replace("art-", ""));
      const group = id.startsWith("i-") ? "icons" : room ? "rooms" : "items";
      const name = id.replace(/^(art|i)-/, "");
      const [, , width, height] = symbol.viewBox.split(" ").map(Number);
      let body = symbol.body.replace(/var\(--room-([a-z]+)\)/g, (_, key) => palette[key]);
      body = body.replace(/currentColor/g, theme === "dark" ? "#efeee4" : "#292d25");
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width * 3}" height="${height * 3}" viewBox="${symbol.viewBox}">${body}</svg>`;
      const directory = path.join(root, "miniprogram/assets", group);
      await fs.mkdir(directory, { recursive: true });
      tasks.push(sharp(Buffer.from(svg)).png().toFile(path.join(directory, `${name}${theme === "dark" ? "-dark" : ""}.png`)));
    }
  }
  await Promise.all(tasks);
  console.log(`Generated ${tasks.length} light/dark prototype assets.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
