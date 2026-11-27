// Real Electron smoke: the shared modal frame and the shared segmented tab bar.
// Every modal (Settings and its sections, the proxy sheet inside it, Commands, Keyboard
// shortcuts, Zotero) opens at a small and a large window and stays inside the window with a
// margin; typing or filtering inside one does not change its size. The library's tab bars
// fill their row with the pill under the chosen tab; the active main tab is marked; native
// full screen drops the traffic-light inset. Screenshots in light and dark.
const { electron } = require("./lib/launch.cjs");
const { mkdtemp, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const SIZES = [
  [760, 520],
  [1400, 860],
];
const MARGIN = 20;

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-modals-"));
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: { ...process.env, KEY_SKIP_ONBOARDING: "1", KEY_USER_DATA: path.join(temp, "profile"), KEY_WORKSPACE_PARENT: path.join(temp, "workspaces") },
  });
  let page;
  const shots = [];
  const shot = async (name) => {
    const file = path.join(temp, `${name}.png`);
    await writeFile(file, await page.screenshot());
    shots.push(file);
  };
  const resize = async ([width, height]) => {
    // Below the window's own minimum (850×600) on purpose: modals must fit even then.
    await app.evaluate(({ BrowserWindow }, [width, height]) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.setMinimumSize(600, 400);
      w.setContentSize(width, height);
    }, [width, height]);
    await page.waitForFunction(([w, h]) => Math.abs(innerWidth - w) < 16 && Math.abs(innerHeight - h) < 16, [width, height], { timeout: 3000 }).catch(async () => {
      throw Error(`Window not resized to ${width}×${height}: ${JSON.stringify(await page.evaluate(() => [innerWidth, innerHeight]))}`);
    });
    await page.waitForTimeout(150);
  };
  const theme = (dark) =>
    page.evaluate((dark) => (dark ? document.documentElement.setAttribute("data-theme", "dark") : document.documentElement.setAttribute("data-theme", "light")), dark);
  const send = (event, value) => app.evaluate(({ BrowserWindow }, [event, value]) => BrowserWindow.getAllWindows()[0].webContents.send(event, value), [event, value]);
  const modal = () => page.locator(".key-modal").last();
  const rect = () =>
    modal().evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom, vw: innerWidth, vh: innerHeight, scrolls: el.scrollHeight > el.clientHeight + 1 };
    });
  // Waits for the open animation and any height settling, then checks the frame is inside.
  const settled = async (what) => {
    await modal().waitFor();
    let last;
    for (let i = 0; i < 40; i++) {
      const now = await rect();
      if (last && Math.abs(now.height - last.height) < 0.5 && Math.abs(now.y - last.y) < 0.5 && Math.abs(now.width - last.width) < 0.5) break;
      last = now;
      await page.waitForTimeout(80);
    }
    const r = await rect();
    assert.ok(r.x >= MARGIN - 0.5 && r.y >= MARGIN - 0.5 && r.right <= r.vw - MARGIN + 0.5 && r.bottom <= r.vh - MARGIN + 0.5, `${what} leaves the window's margin: ${JSON.stringify(r)}`);
    return r;
  };
  const close = async () => {
    await page.keyboard.press("Escape");
    await page.locator(".key-modal").waitFor({ state: "detached" });
    await page.waitForTimeout(100);
  };
  const result = { modals: {} };
  try {
    page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();

    for (const size of SIZES) {
      await resize(size);
      const tag = size.join("x");
      for (const dark of [false, true]) {
        await theme(dark);
        const mode = dark ? "dark" : "light";

        // Settings: every section fits; a section's size does not change while it is shown.
        await send("open-settings", "general");
        let r = await settled(`Settings at ${tag}`);
        result.modals[`settings-${tag}`] = r;
        if (!dark) {
          for (const section of ["Workspaces", "Citations", "Search & indexing", "Privacy & network", "Services & API keys", "AI assistant", "About Key", "General", "Web & browser"]) {
            await modal().getByRole("navigation", { name: "Key Settings sections" }).getByRole("button", { name: section, exact: true }).click();
            await page.waitForTimeout(400);
            const a = await settled(`Settings (${section}) at ${tag}`);
            await page.waitForTimeout(600);
            const b = await rect();
            assert.ok(Math.abs(a.height - b.height) < 1, `Settings (${section}) changed size while shown: ${a.height} → ${b.height}`);
            result.modals[`settings-${section}-${tag}`] = Math.round(b.height);
          }
          // The proxy sheet inside Settings stays inside Settings and the window.
          const add = modal().getByRole("button", { name: "Add proxy…", exact: true });
          await add.waitFor();
          {
            await add.scrollIntoViewIfNeeded();
            await add.click();
            const sheet = page.locator(".kx-proxy-sheet");
            await sheet.waitFor();
            await page.waitForTimeout(300);
            const inner = await sheet.evaluate((el) => {
              const r = el.getBoundingClientRect();
              return { y: r.y, bottom: r.bottom, x: r.x, right: r.right, vw: innerWidth, vh: innerHeight };
            });
            assert.ok(inner.y >= 0 && inner.bottom <= inner.vh - MARGIN + 0.5 && inner.x >= MARGIN - 0.5 && inner.right <= inner.vw - MARGIN + 0.5, `The proxy sheet leaves the window at ${tag}: ${JSON.stringify(inner)}`);
            await shot(`proxy-${tag}`);
            await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
            await sheet.waitFor({ state: "detached" });
          }
        }
        await shot(`settings-${tag}-${mode}`);
        await close();

        // Workspace Settings: the same frame, every section fits and holds its size.
        await send("open-workspace-settings");
        r = await settled(`Workspace Settings at ${tag}`);
        result.modals[`workspace-settings-${tag}`] = r;
        if (!dark) {
          for (const section of ["Zotero", "Indexing & lookups", "Citations & export", "Markdown export", "Files", "Feeds & alerts", "General"]) {
            await modal().getByRole("navigation", { name: "Workspace Settings sections" }).getByRole("button", { name: section, exact: true }).click();
            await page.waitForTimeout(400);
            const a = await settled(`Workspace Settings (${section}) at ${tag}`);
            await page.waitForTimeout(600);
            const b = await rect();
            assert.ok(Math.abs(a.height - b.height) < 1, `Workspace Settings (${section}) changed size while shown: ${a.height} → ${b.height}`);
          }
        }
        await shot(`workspace-settings-${tag}-${mode}`);
        await close();

        // Commands: typing a filter that matches less keeps the frame still.
        await send("command", "palette");
        r = await settled(`Commands at ${tag}`);
        const input = modal().locator("input, textarea").first();
        await input.focus();
        for (const text of ["s", "se", "set", "zzzz"]) {
          await input.fill(text);
          await page.waitForTimeout(150);
          const now = await rect();
          assert.ok(Math.abs(now.height - r.height) < 1 || now.height > r.height, `Commands shrank while typing "${text}": ${r.height} → ${now.height}`);
          r = now;
        }
        const inside = await settled(`Commands after typing at ${tag}`);
        await shot(`commands-${tag}-${mode}`);
        result.modals[`commands-${tag}`] = Math.round(inside.height);
        await close();

        // Keyboard shortcuts: a long list scrolls inside the frame at a small window.
        await send("command", "shortcuts");
        r = await settled(`Keyboard shortcuts at ${tag}`);
        result.modals[`shortcuts-${tag}`] = r;
        await shot(`shortcuts-${tag}-${mode}`);
        await close();

        // Zotero: the sheet's first step.
        await page.evaluate(() => window.dispatchEvent(new Event("key:open-zotero")));
        r = await settled(`Zotero at ${tag}`);
        await page.waitForTimeout(800);
        r = await settled(`Zotero after loading at ${tag}`);
        result.modals[`zotero-${tag}`] = r;
        await shot(`zotero-${tag}-${mode}`);
        await close();
      }
    }

    // The scrim dims the whole window, title bar included.
    await send("command", "palette");
    await settled("Commands");
    const scrim = await page.locator(".key-global-drawer-scrim").evaluate((el) => {
      const r = el.getBoundingClientRect();
      return [r.x, r.y, r.width, r.height, innerWidth, innerHeight];
    });
    assert.deepEqual(scrim.slice(0, 2), [0, 0]);
    assert.equal(Math.round(scrim[2]), scrim[4]);
    assert.equal(Math.round(scrim[3]), scrim[5]);
    await close();

    // Tab bars: the library's segmented tabs fill their bar, the pill sits under the chosen tab.
    await theme(false);
    await resize([1200, 800]);
    const [ws] = await page.evaluate(() => window.key.workspaces());
    await page.evaluate((id) => window.key.tabAction("open-content", { section: "sources", workspaceId: id }), ws.id);
    const bar = page.locator(".kx-scope-tabs").first();
    await bar.waitFor();
    await page.waitForTimeout(400);
    const geometry = await bar.evaluate((el) => {
      const track = el.querySelector("[role=tablist]");
      const tabs = [...track.querySelectorAll("[role=tab]")].map((t) => t.getBoundingClientRect());
      const pill = el.querySelector(".key-segmented-pill").getBoundingClientRect();
      const chosen = track.querySelector("[aria-selected=true]").getBoundingClientRect();
      const row = el.parentElement.getBoundingClientRect();
      const t = track.getBoundingClientRect();
      return { tabs: tabs.length, used: tabs.reduce((n, r) => n + r.width, 0), track: t.width, bar: el.getBoundingClientRect().width, row: row.width, pill: [pill.x, pill.width], chosen: [chosen.x, chosen.width] };
    });
    result.tabBar = geometry;
    assert.ok(geometry.used >= geometry.track - 10, `The tabs don't fill their bar: ${JSON.stringify(geometry)}`);
    // The library's view tabs are compact (sized to their tabs), not stretched over the row.
    assert.ok(geometry.bar <= geometry.track + 12, `The bar is wider than its tabs: ${JSON.stringify(geometry)}`);
    assert.ok(Math.abs(geometry.pill[0] - geometry.chosen[0]) < 1.5 && Math.abs(geometry.pill[1] - geometry.chosen[1]) < 1.5, `The pill isn't under the chosen tab: ${JSON.stringify(geometry)}`);
    // Arrow keys move the choice and the pill follows.
    await bar.locator("[role=tab][aria-selected=true]").focus();
    await page.keyboard.press("End");
    await page.waitForTimeout(400);
    const moved = await bar.evaluate((el) => {
      const tabs = [...el.querySelectorAll("[role=tab]")];
      const pill = el.querySelector(".key-segmented-pill").getBoundingClientRect();
      const chosen = el.querySelector("[aria-selected=true]");
      return { last: tabs.at(-1) === chosen, focused: document.activeElement === chosen, pill: Math.round(pill.x), chosen: Math.round(chosen.getBoundingClientRect().x) };
    });
    assert.ok(moved.last && moved.focused && Math.abs(moved.pill - moved.chosen) <= 1, `End didn't choose the last tab: ${JSON.stringify(moved)}`);
    await page.keyboard.press("Home");
    // A narrow window: the bar scrolls instead of squeezing, with a faded edge.
    await resize([760, 520]);
    await page.waitForTimeout(300);
    const narrow = await bar.evaluate((el) => {
      const track = el.querySelector("[role=tablist]");
      return { overflow: track.scrollWidth > track.clientWidth + 1, fadeEnd: el.hasAttribute("data-fade-end"), right: el.getBoundingClientRect().right, vw: innerWidth };
    });
    result.narrowTabBar = narrow;
    assert.ok(narrow.right <= narrow.vw, "The tab bar overflows the window");
    if (narrow.overflow) assert.ok(narrow.fadeEnd, "An overflowing tab bar fades its end");
    await shot("tab-bars-narrow-light");
    await resize([1200, 800]);
    for (const dark of [false, true]) {
      await theme(dark);
      await page.waitForTimeout(200);
      await shot(`tab-bars-${dark ? "dark" : "light"}`);
    }

    // The main tab strip: the active tab carries an accent underline.
    const active = await page.locator('.kx-tabs[data-focused] .kx-tab[aria-selected="true"]').evaluate((el) => {
      const after = getComputedStyle(el, "::after");
      return { height: after.height, background: after.backgroundColor, plate: getComputedStyle(el).backgroundColor };
    });
    result.activeTab = active;
    assert.equal(active.height, "2px");
    assert.notEqual(active.plate, "rgba(0, 0, 0, 0)");

    // Native full screen: no traffic lights, so no inset before the workspace name.
    await theme(false);
    const inset = () => page.locator(".kx-sidebar-titlebar").evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
    assert.ok((await inset()) > 60, "The title bar clears the traffic lights");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(true));
    await page.waitForFunction(() => document.documentElement.hasAttribute("data-full-screen"), undefined, { timeout: 8000 });
    await page.waitForTimeout(900);
    result.fullScreenInset = await inset();
    assert.ok(result.fullScreenInset < 20, `Full screen keeps the traffic-light inset: ${result.fullScreenInset}`);
    await shot("full-screen");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(false));
    await page.waitForFunction(() => !document.documentElement.hasAttribute("data-full-screen"), undefined, { timeout: 8000 });
    await page.waitForTimeout(900);
    assert.ok((await inset()) > 60, "Leaving full screen brings the inset back");

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, ...result, shots: temp }, null, 1));
  } finally {
    await app.close().catch(() => {});
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
