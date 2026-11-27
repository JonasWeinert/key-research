// Contact sheet for Key's icon set: every glyph at 12/14/16/20, outline and filled, light and dark.
// node scripts/icon-sheet.cjs [out.png]  (default: <tmp>/key-icon-sheet.png)
const { electron } = require("./lib/launch.cjs");
const { buildSync } = require("esbuild");
const { mkdtempSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { tmpdir } = require("node:os");

const temp = mkdtempSync(path.join(tmpdir(), "key-icon-sheet-"));
const out = path.resolve(process.argv[2] || path.join(temp, "key-icon-sheet.png"));
const bundle = path.join(temp, "glyphs.cjs");
buildSync({ entryPoints: [path.resolve(__dirname, "../../../../key/src/ui/glyphs.ts")], bundle: true, format: "cjs", platform: "node", outfile: bundle, logLevel: "silent" });
const { glyphs } = require(bundle);
const stroke = (size) => Math.min(2, Math.max(1.05, 1.4 * Math.sqrt(16 / size)));
const svg = (g, size, filled) => {
  const v = (filled && g.on) || g;
  return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="${stroke(size)}" stroke-linecap="round" stroke-linejoin="round">${v.f ? `<path d="${v.f}" fill="currentColor" fill-rule="evenodd" stroke="none"/>` : ""}${v.s ? `<path d="${v.s}"/>` : ""}</svg>`;
};
const sizes = [12, 14, 16, 20];
const cells = (filled) =>
  Object.entries(glyphs)
    .map(([name, g]) => `<div class="c${filled && !g.on ? " dim" : ""}"><div class="row">${sizes.map((s) => svg(g, s, filled)).join("")}</div><div class="big">${svg(g, 48, filled)}</div><span>${name}</span></div>`)
    .join("");
const panel = (theme, filled) => `<section class="${theme}"><h2>${theme} · ${filled ? "filled" : "outline"}</h2><div class="g">${cells(filled)}</div></section>`;
const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;font:11px -apple-system,system-ui;width:1100px}
section{padding:12px}.light{background:#f6f6f6;color:#1d1d1f}.dark{background:#232326;color:#ececee}
h2{font-size:12px;font-weight:600;margin:0 0 8px}.g{display:grid;grid-template-columns:repeat(9,1fr);gap:6px}
.c{display:flex;flex-direction:column;align-items:center;gap:4px;padding:6px 2px;border-radius:6px;background:rgba(127,127,127,.08)}
.c.dim{opacity:.35}.row{display:flex;gap:6px;align-items:center;height:20px}.big svg{background:rgba(127,127,127,.12);background-image:linear-gradient(rgba(127,127,127,.18) 1px,transparent 1px),linear-gradient(90deg,rgba(127,127,127,.18) 1px,transparent 1px);background-size:3px 3px}
span{opacity:.7;font-size:10px}</style>${panel("light", false)}${panel("dark", false)}${panel("light", true)}${panel("dark", true)}`;
const page = path.join(temp, "sheet.html");
writeFileSync(page, html);
const main = path.join(temp, "main.cjs");
writeFileSync(main, `const { app, BrowserWindow } = require("electron"); app.whenReady().then(() => { const w = new BrowserWindow({ width: 1100, height: 900, show: false }); w.loadFile(${JSON.stringify(page)}); });`);
(async () => {
  const app = await electron.launch({ executablePath: require("electron"), args: [main] });
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState("load");
    const sections = win.locator("section");
    for (let i = 0; i < 4; i++) {
      const file = out.replace(/\.png$/, `-${["light", "dark", "light-filled", "dark-filled"][i]}.png`);
      await sections.nth(i).screenshot({ path: file });
      console.log(file);
    }
  } finally {
    await app.close();
  }
})();
