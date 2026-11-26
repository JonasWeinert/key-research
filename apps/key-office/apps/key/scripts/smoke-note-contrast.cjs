// Run serially: native windows and focus are shared with other GUI checks.
// Note editor contrast: every text and control colour in a note with rich content, in the
// light and the dark theme, resolved to real colours with getComputedStyle (backgrounds
// composited up the tree) and held to WCAG AA: 4.5:1 for text (placeholders too), 3:1 for
// large text, icons and the edges of controls. KEY_CONTRAST_REPORT=1 prints every pair.
const { _electron: electron } = require("playwright-core");
const { mkdtemp } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const BODY = (sourceId) => `# Field notes

A plain paragraph with a [web link](https://example.org), some \`inline code\` and a citation [Palma et al. 2022](key://source/${sourceId}).

## Second heading

### Third heading

> An ordinary block quote, set apart from the text.

\`\`\`quote source="${sourceId}" page="3"
Health and income moved together in every region.
\`\`\`

\`\`\`source id="${sourceId}"
Palma et al. 2022 — Health versus income
\`\`\`

\`\`\`callout tone="info"
An info callout.
\`\`\`

\`\`\`callout tone="tip"
A tip callout.
\`\`\`

\`\`\`callout tone="warning"
A warning callout.
\`\`\`

\`\`\`callout tone="note"
A note callout.
\`\`\`

\`\`\`toggle title="Folded findings"
Inside the toggle.
\`\`\`

- a bullet
- another bullet

1. first step
2. second step

- [ ] still to do
- [x] already done

| Region | Rate |
| --- | --- |
| North | 0.4 |
| South | 0.6 |

\`\`\`js
const rate = 0.4;
\`\`\`

---

Last line.`;

/** In the page: contrast of each probe against what is actually behind it. */
function measure(probes) {
  const parse = (c) => {
    if (!c || c === "transparent") return [0, 0, 0, 0];
    let m = /^rgba?\(([^)]+)\)$/.exec(c);
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2], p[3] ?? 1];
    }
    m = /^color\(srgb ([^)]+)\)$/.exec(c);
    if (m) {
      const p = m[1].split(/[\s/]+/).filter(Boolean).map(Number);
      return [p[0] * 255, p[1] * 255, p[2] * 255, p[3] ?? 1];
    }
    throw new Error(`Unparsed colour ${c}`);
  };
  const over = (top, bottom) => {
    const a = top[3] + bottom[3] * (1 - top[3]);
    if (!a) return [0, 0, 0, 0];
    return [0, 1, 2].map((i) => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a).concat(a);
  };
  const lum = ([r, g, b]) => {
    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  // Layers of background from the element up to the first opaque one.
  const backdrop = (el) => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const bg = parse(getComputedStyle(e).backgroundColor);
      if (bg[3] > 0) layers.push(bg);
      if (bg[3] >= 1) break;
    }
    let color = parse(getComputedStyle(document.body).backgroundColor);
    if (color[3] < 1) color = [255, 255, 255, 1];
    for (const layer of layers.reverse()) color = over(layer, color);
    return color;
  };
  const opacity = (el) => {
    let o = 1;
    for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
    return o;
  };
  return probes.map((probe) => {
    // The note being checked first (other notes stay open in hidden tabs), then menus at the root.
    const root = document.querySelector("[data-contrast-root]");
    const el = root?.querySelector(probe.selector) ?? document.querySelector(probe.selector);
    if (!el) return { ...probe, missing: true };
    const style = getComputedStyle(el, probe.pseudo ?? null);
    const bg = probe.bgSelector ? backdrop(document.querySelector(probe.bgSelector)) : probe.pseudo === "::selection" ? over(parse(style.backgroundColor), backdrop(el)) : backdrop(el);
    const fgRaw = parse(style[probe.prop ?? "color"]);
    const fg = over([fgRaw[0], fgRaw[1], fgRaw[2], fgRaw[3] * opacity(el)], bg);
    const fgText = probe.pseudo === "::selection" ? parse(getComputedStyle(el).color) : fg;
    return { ...probe, ratio: Math.round(ratio(fgText, bg) * 100) / 100, fg: fgText.slice(0, 3).map(Math.round).join(","), bg: bg.slice(0, 3).map(Math.round).join(",") };
  });
}

const TEXT = 4.5;
const UI = 3;
// What is checked; `min` is the WCAG AA threshold that applies.
const EDITOR_PROBES = [
  { name: "body text", selector: ".ne-prose > p", min: TEXT },
  { name: "heading 1", selector: ".ne-prose h1", min: TEXT },
  { name: "heading 3", selector: ".ne-prose h3", min: TEXT },
  { name: "web link", selector: '.ne-prose a[href^="https"]', min: TEXT },
  { name: "inline code", selector: ".ne-prose p code", min: TEXT },
  { name: "code block", selector: ".ne-prose pre code", min: TEXT },
  { name: "block quote", selector: ".ne-prose blockquote:not(.ne-squote-text)", min: TEXT },
  { name: "bullet marker", selector: ".ne-prose ul:not([data-type]) li", pseudo: "::marker", min: UI },
  { name: "number marker", selector: ".ne-prose ol li", pseudo: "::marker", min: TEXT },
  { name: "done to-do", selector: '.ne-prose li[data-checked="true"] > div > p', min: TEXT },
  { name: "source quote", selector: ".ne-squote-text", min: TEXT },
  { name: "quote source link", selector: ".ne-squote-link", min: TEXT },
  { name: "citation chip", selector: '.ne-prose a[href^="key://source/"]', min: TEXT },
  { name: "source card title", selector: ".ne-source-card-title", min: TEXT },
  { name: "source card detail", selector: ".ne-source-card-detail", min: TEXT },
  { name: "source card open", selector: ".ne-source-card-open", min: UI },
  { name: "source card icon", selector: ".ne-source-card-icon", min: UI },
  { name: "callout info text", selector: ".ne-callout:not([class*=ne-tone-]) .ne-callout-body p, .ne-callout.ne-tone-info .ne-callout-body p", min: TEXT },
  { name: "callout info icon", selector: ".ne-callout.ne-tone-info .ne-callout-icon", min: UI },
  { name: "callout tip icon", selector: ".ne-callout.ne-tone-tip .ne-callout-icon", min: UI },
  { name: "callout warning icon", selector: ".ne-callout.ne-tone-warning .ne-callout-icon", min: UI },
  { name: "callout warning text", selector: ".ne-callout.ne-tone-warning .ne-callout-body p", min: TEXT },
  { name: "callout note icon", selector: ".ne-callout.ne-tone-note .ne-callout-icon", min: UI },
  { name: "toggle chevron", selector: ".ne-toggle-chevron", min: UI },
  { name: "toggle title", selector: ".ne-toggle-title", min: TEXT },
  { name: "table header", selector: ".ne-prose th", min: TEXT },
  { name: "table cell", selector: ".ne-prose td", min: TEXT },
  { name: "table grid", selector: ".ne-prose th", prop: "borderBottomColor", min: UI },
  { name: "divider", selector: ".ne-prose hr", prop: "borderTopColor", min: UI },
  { name: "empty line hint", selector: ".ne-prose p.is-empty", pseudo: "::before", min: TEXT },
  { name: "text selection", selector: ".ne-prose > p", pseudo: "::selection", min: TEXT },
  { name: "note title", selector: ".kx-note-page .kx-note-title", min: TEXT },
  { name: "saved state", selector: ".kx-note-page .kx-note-saved", min: TEXT },
];
const GUTTER_PROBES = [{ name: "block handle", selector: ".ne-gutter-btn:not([hidden])", min: UI }];
const SLASH_PROBES = [
  { name: "menu heading", selector: ".ne-menu .ne-menu-heading", min: TEXT },
  { name: "menu label", selector: ".ne-menu .ne-menu-label", min: TEXT },
  { name: "menu hint", selector: ".ne-menu .ne-menu-hint", min: TEXT },
  { name: "menu icon", selector: ".ne-menu .ne-menu-icon", min: UI },
  { name: "active menu hint", selector: ".ne-menu .ne-menu-item.is-active .ne-menu-hint", min: TEXT },
];
const PICKER_PROBES = [
  { name: "picker heading", selector: ".ne-menu--source .ne-menu-heading", min: TEXT },
  { name: "picker result", selector: ".ne-menu--source .ne-menu-label", min: TEXT },
  { name: "picker detail", selector: ".ne-menu--source .ne-menu-hint", min: TEXT },
  { name: "picker icon", selector: ".ne-menu--source .ne-menu-icon", min: UI },
  { name: "picker footnote", selector: ".ne-menu--source .ne-menu-foot", min: TEXT },
];
const BUBBLE_PROBES = [
  { name: "toolbar button", selector: ".ne-bubble .ne-tool:not(.ne-tool-text):not(.is-active)", min: UI },
  { name: "toolbar block menu", selector: ".ne-bubble .ne-tool-text", min: TEXT },
];
const PANEL_PROBES = [
  { name: "library title", selector: ".kx-note-library-title", min: TEXT },
  { name: "library search hint", selector: ".kx-note-library .kx-search-input", pseudo: "::placeholder", min: TEXT },
  { name: "library kind chip", selector: '.kx-note-library .kx-kind-chips button[aria-pressed="false"]:not(:disabled)', min: TEXT },
  { name: "library chosen chip", selector: '.kx-note-library .kx-kind-chips button[aria-pressed="true"]', min: TEXT },
  { name: "library result", selector: ".kx-note-library .kx-hit-title", min: TEXT },
  { name: "library byline", selector: ".kx-note-library .kx-hit-meta", min: TEXT },
  { name: "library keys", selector: ".kx-note-library-foot", min: TEXT },
  { name: "library close", selector: ".kx-note-library-head .kx-icon-button", min: UI },
  { name: "library button", selector: ".kx-library-fab", min: UI },
];
const FOCUS_PROBES = [{ name: "focus ring", selector: ".ne-toggle-chevron:focus-visible", prop: "outlineColor", min: UI }];

(async () => {
  const report = process.env.KEY_CONTRAST_REPORT === "1";
  const temp = await mkdtemp(path.join(tmpdir(), "key-note-contrast-"));
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: { ...process.env, KEY_SKIP_ONBOARDING: "1", KEY_USER_DATA: path.join(temp, "profile"), KEY_WORKSPACE_PARENT: path.join(temp, "workspaces") },
  });
  const shot = (page, name) => page.screenshot({ path: path.join(temp, `${name}.png`) });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1100));
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => page.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });
    await call("store_create", { source: { kind: "reference", title: "Health versus income", year: 2022, creators: [{ given: "Marco", family: "Palma" }] } }).catch(() => undefined);
    const { items } = await call("store_sources", { limit: 5, offset: 0 });
    const source = items.find((s) => s.title === "Health versus income");
    assert.ok(source, "the reference was created");
    let notePage, prose;
    // Each theme gets its own copy of the note.
    const openNote = async (title) => {
      const note = await call("store_note_save", { id: null, sourceId: null, title, body: BODY(source.id) });
      await page.evaluate(({ id, noteId, title }) => window.key.tabAction("open-content", { section: "note", workspaceId: id, noteId, title }), { id: ws.id, noteId: note.id, title });
      // The new note's tab is the visible one; its title arrives with the note (the input's
      // value attribute does not reliably follow, so match the live value).
      notePage = page.locator(".kx-note-page:visible");
      await page.waitForFunction((title) => [...document.querySelectorAll(".kx-note-page input")].some((i) => i.offsetParent && i.value === title), title);
      prose = notePage.locator(".ne-prose");
      await prose.waitFor();
      await page.evaluate(() => document.querySelector("[data-contrast-root]")?.removeAttribute("data-contrast-root"));
      await notePage.evaluate((el) => (el.closest(".kx-note-shell") ?? el).setAttribute("data-contrast-root", ""));
      await notePage.locator(".ne-source-card-title", { hasText: "Health versus income" }).waitFor();
    };

    // A new empty line after the last one, with the cursor in it.
    const newLine = async () => {
      const empty = () => prose.locator("p.is-empty").count();
      const before = await prose.locator("p").count();
      for (let attempt = 0; attempt < 6; attempt++) {
        await prose.locator("p", { hasText: "Last line." }).click();
        await notePage.locator(".ProseMirror:focus").waitFor();
        // If the page was still settling, the click can land as a small drag: keep only the
        // caret, so Enter adds a line rather than replacing a selection.
        await page.evaluate(() => getSelection()?.collapseToEnd());
        await page.keyboard.press("End");
        await page.keyboard.press("Enter");
        await page.waitForTimeout(300);
        if ((await prose.locator("p").count()) > before && (await empty())) return;
      }
      throw new Error("no new line");
    };
    const failures = [];
    const check = async (theme, probes) => {
      const results = await page.evaluate(measure, probes);
      for (const r of results) {
        if (report) console.log(`${theme.padEnd(5)} ${r.missing ? "MISSING" : r.ratio.toFixed(2).padStart(6)}  ${r.min}  ${r.name}${r.missing ? "" : `  fg ${r.fg} bg ${r.bg}`}`);
        if (r.missing) failures.push(`${theme}: ${r.name} not found (${r.selector})`);
        else if (r.ratio < r.min) failures.push(`${theme}: ${r.name} ${r.ratio}:1 < ${r.min}:1 (fg ${r.fg} on ${r.bg})`);
      }
    };

    for (const theme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: theme });
      await openNote(`Contrast ${theme}`);
      await page.waitForFunction((dark) => matchMedia("(prefers-color-scheme: dark)").matches === dark, theme === "dark");
      // An empty line at the end, with its hint (the selection colour needs no selection to read).
      await newLine();
      await check(theme, EDITOR_PROBES);
      await notePage.locator(".kx-item-page-body").evaluate((el) => el.closest(".kx-note-page").scrollTo(0, 0));
      await shot(page, `${theme}-editor`);
      await prose.locator("table").scrollIntoViewIfNeeded();
      await shot(page, `${theme}-editor-lower`);

      // The block handles beside a paragraph.
      await prose.locator("p", { hasText: "A plain paragraph" }).hover();
      await notePage.locator(".ne-gutter-btn:not([hidden])").first().waitFor();
      await check(theme, GUTTER_PROBES);

      // The slash menu.
      await newLine();
      await page.keyboard.type("/");
      await page.locator(".ne-menu").waitFor();
      await page.waitForTimeout(300);
      await check(theme, SLASH_PROBES);
      await shot(page, `${theme}-slash`);
      await page.keyboard.press("Backspace");
      await page.locator(".ne-menu").waitFor({ state: "detached" });
      await page.keyboard.press("Backspace");

      // The citation picker.
      await newLine();
      await page.keyboard.type("@Health");
      await page.locator(".ne-menu--source .ne-menu-item").first().waitFor();
      await page.waitForTimeout(300);
      await check(theme, PICKER_PROBES);
      await shot(page, `${theme}-picker`);
      for (let i = 0; i < "@Health".length + 1; i++) await page.keyboard.press("Backspace");

      // The selection toolbar.
      await prose.locator("p", { hasText: "A plain paragraph" }).dblclick({ position: { x: 12, y: 10 } });
      await page.locator(".ne-bubble .ne-tool").first().waitFor();
      await page.waitForTimeout(300);
      await check(theme, BUBBLE_PROBES);
      await shot(page, `${theme}-bubble`);
      await page.keyboard.press("ArrowRight");

      // A control reached with the keyboard shows a visible focus ring.
      await page.keyboard.press("Shift");
      await notePage.locator(".ne-toggle-chevron").focus();
      await check(theme, FOCUS_PROBES);
      const ring = await notePage.locator(".ne-toggle-chevron").evaluate((el) => {
        const s = getComputedStyle(el);
        return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) };
      });
      assert.ok(ring.style !== "none" && ring.width >= 2, `${theme}: keyboard focus shows a ring (${JSON.stringify(ring)})`);

      // The library panel beside the note, and the button that opens it.
      await page.locator(".kx-note-shell:visible .kx-library-fab").click();
      const panel = page.locator(".kx-note-shell:visible .kx-note-library");
      await panel.locator(".kx-found-hit").first().waitFor();
      await page.waitForTimeout(600);
      await check(theme, PANEL_PROBES);
      await shot(page, `${theme}-library`);
      await page.keyboard.press("Escape");
      await panel.waitFor({ state: "detached" });
    }

    assert.deepEqual(errors, []);
    assert.deepEqual(failures, [], `contrast below WCAG AA:\n${failures.join("\n")}`);
    console.log(JSON.stringify({ ok: true, temp, themes: ["light", "dark"], probes: EDITOR_PROBES.length + GUTTER_PROBES.length + SLASH_PROBES.length + PICKER_PROBES.length + BUBBLE_PROBES.length + FOCUS_PROBES.length + PANEL_PROBES.length }));
  } catch (e) {
    await app.windows()[0]?.screenshot({ path: path.join(temp, "failure.png") }).catch(() => {});
    console.error("Artifacts", temp);
    throw e;
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
