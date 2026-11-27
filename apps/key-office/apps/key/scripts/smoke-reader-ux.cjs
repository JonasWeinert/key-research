// The PDF reader's own UX: the floating toolbar, citation hover cards (one and several
// works), the lookup skeleton while a provider is rate limited, the selection toolbar's
// Cite (and the clipboard it fills), and zooming to a quote. Screenshots land in the temp
// dir printed at the end (light and dark).
const { electron } = require("./lib/launch.cjs");
const { mkdtemp, mkdir } = require("node:fs/promises");
const path = require("node:path");
const { tmpdir } = require("node:os");

const only = (process.env.KEY_SMOKE_ONLY || "").split(",").filter(Boolean);
const want = (name) => !only.length || only.includes(name);

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-reader-ux-"));
  await mkdir(path.join(temp, "profile"));
  const shots = [];
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: {
      ...process.env,
      KEY_SKIP_ONBOARDING: "1",
      KEY_USER_DATA: path.join(temp, "profile"),
      KEY_WORKSPACE_PARENT: path.join(temp, "workspaces"),
    },
  });
  const shot = async (page, name) => {
    const file = path.join(temp, `${name}.png`);
    await page.screenshot({ path: file });
    shots.push(file);
  };
  try {
    const shell = await app.firstWindow();
    await shell.waitForFunction(() => window.key);
    const fixture = path.resolve(__dirname, "../../../../../tests/fixtures", process.env.KEY_SMOKE_PDF || "PUBMED_33599681.pdf");
    const opened = await shell.evaluate(async (input) => {
      const [w] = await window.key.workspaces();
      const info = await window.key.invoke("library_import_file", { path: input }, w.id);
      const source = { ...info, documentHash: info.hash, workspaceId: w.id };
      await window.key.openSource(source);
      return source;
    }, fixture);
    let pdf;
    for (let i = 0; i < 100 && !pdf; i++) {
      pdf = app.windows().find((p) => p.url().endsWith("/pdf.html"));
      if (!pdf) await new Promise((r) => setTimeout(r, 100));
    }
    if (!pdf) throw Error("PDF view not created");
    pdf.on("pageerror", (e) => console.error("PDF ERROR", e));
    pdf.on("console", (m) => m.type() === "error" && console.error("PDF CONSOLE", m.text()));
    await pdf.getByRole("button", { name: "Zoom in", exact: true }).waitFor({ timeout: 30000 });
    await pdf.waitForFunction(() => document.querySelectorAll("canvas").length > 0, { timeout: 30000 });
    await pdf.waitForTimeout(800);
    const result = { opened: opened.title };
    const chromeHidden = () => pdf.locator(".key-pdf-chrome").evaluate((e) => e.hasAttribute("data-hidden"));
    const scrollTo = (top) =>
      pdf.evaluate((top) => {
        const s = document.querySelector(".pdfjs-scroll");
        s.scrollTo({ top, behavior: "instant" });
      }, top);
    const themes = async (name, body) => {
      for (const scheme of ["light", "dark"]) {
        await shell.evaluate((t) => window.key.setAppSettings({ theme: t }), scheme);
        await pdf.emulateMedia({ colorScheme: scheme });
        await pdf.waitForTimeout(250);
        if (body) await body(scheme);
        await shot(pdf, `${name}-${scheme}`);
      }
      await shell.evaluate(() => window.key.setAppSettings({ theme: "system" }));
      await pdf.emulateMedia({ colorScheme: "light" });
    };

    // 1. The floating toolbar: over the page at the top, gone while reading down, back on
    //    scrolling up and when the pointer nears the top.
    if (want("toolbar")) {
      await pdf.mouse.move(600, 500);
      await themes("toolbar-top");
      const firstPageTop = await pdf.evaluate(() => document.querySelector(".pdfjs-page").getBoundingClientRect().top);
      const barBottom = await pdf.evaluate(() => document.querySelector(".key-pdf-toolbar").getBoundingClientRect().bottom);
      if (firstPageTop < barBottom) throw Error(`The toolbar covers the first page at the top (${firstPageTop} < ${barBottom})`);
      await scrollTo(300);
      await pdf.waitForTimeout(60);
      await scrollTo(900);
      await pdf.waitForTimeout(400);
      if (!(await chromeHidden())) throw Error("The toolbar did not step aside while scrolling down");
      await shot(pdf, "toolbar-scrolled-hidden");
      await scrollTo(700);
      await pdf.waitForTimeout(400);
      if (await chromeHidden()) throw Error("The toolbar did not come back on scrolling up");
      await themes("toolbar-scrolled");
      await scrollTo(1400);
      await pdf.waitForTimeout(300);
      await pdf.mouse.move(600, 30);
      await pdf.waitForTimeout(300);
      if (await chromeHidden()) throw Error("The toolbar did not come back with the pointer near the top");
      await pdf.getByRole("button", { name: "Find", exact: true }).click();
      await pdf.mouse.move(600, 500);
      await scrollTo(2200);
      await pdf.waitForTimeout(400);
      if (await chromeHidden()) throw Error("The toolbar hid while Find was open");
      await pdf.getByRole("textbox", { name: "Find in PDF" }).fill("echocardiogra");
      await pdf.waitForTimeout(600);
      await themes("toolbar-find");
      await pdf.getByRole("button", { name: "Close find" }).click();
      await scrollTo(0);
      result.toolbar = { firstPageTop, barBottom };
    }

    // 2. Citation cards: one work, and several as chips that scroll inside the card.
    const card = pdf.locator(".pdfjs-cite-card");
    // The text layer sits above the marks; the reader hit-tests the pointer, as a person's would.
    const hoverCitation = async (id, { optional = false } = {}) => {
      const box = await pdf.locator(`.pdfjs-link-overlay.citation[data-id="${id}"]`).first().boundingBox().catch(() => null);
      if (!box) {
        if (optional) return false;
        throw Error(`Citation ${id} is not on screen`);
      }
      await pdf.mouse.move(box.x + box.width / 2 - 3, box.y + box.height / 2 + 2, { steps: 3 });
      await pdf.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 2 });
      return true;
    };
    const hoverCitations = async (wanted) => {
      const seen = new Set();
      const found = {};
      const height = await pdf.evaluate(() => document.querySelector(".pdfjs-scroll").scrollHeight);
      const onScreen = () =>
        pdf.evaluate(() =>
          [...document.querySelectorAll(".pdfjs-link-overlay.citation[data-id]")]
            .filter((e) => {
              const r = e.getBoundingClientRect();
              return r.top > 90 && r.bottom < innerHeight - 260 && r.width > 2;
            })
            .map((e) => e.dataset.id),
        );
      for (let top = 0; top < height && Object.keys(found).length < wanted.length; top += 500) {
        await scrollTo(top);
        await pdf.waitForTimeout(250);
        // Analysis arriving redraws the marks under new ids, so the marks here are listed
        // again after each one: a mark that went while the pointer moved is not lost.
        for (;;) {
          const id = (await onScreen()).find((candidate) => !seen.has(candidate));
          if (!id) break;
          seen.add(id);
          await pdf.mouse.move(5, 5);
          await pdf.waitForTimeout(260);
          if (!(await hoverCitation(id, { optional: true }))) continue;
          if (!(await card.isVisible().catch(() => false))) {
            await card.waitFor({ timeout: 1500 }).catch(() => {});
          }
          const chips = await pdf.locator(".pdfjs-cite-chips [role=tab]").count();
          const kind = chips === 0 ? "single" : chips >= 5 ? "many" : "several";
          if (wanted.includes(kind) && !found[kind]) found[kind] = { id, chips, top };
          if (Object.keys(found).length >= wanted.length) break;
        }
      }
      return found;
    };
    const showCitation = async (entry) => {
      await scrollTo(entry.top);
      await pdf.waitForTimeout(300);
      await pdf.mouse.move(5, 5);
      await pdf.waitForTimeout(260);
      await hoverCitation(entry.id);
      await card.waitFor({ timeout: 3000 });
      // Metadata comes from the network: give it a moment, the skeleton shows meanwhile.
      await pdf.waitForFunction(() => !document.querySelector(".pdfjs-cite-skeleton"), undefined, { timeout: Number(process.env.KEY_SMOKE_LOOKUP_MS || 20000) }).catch(() => {});
      await pdf.waitForTimeout(300);
    };
    const cardGeometry = () =>
      pdf.evaluate(() => {
        const c = document.querySelector(".pdfjs-cite-card").getBoundingClientRect();
        const strip = document.querySelector(".pdfjs-cite-chips [role=tablist]") ?? document.querySelector(".pdfjs-cite-chips");
        const bar = document.querySelector(".pdfjs-cite-chips");
        const chips = [...document.querySelectorAll(".pdfjs-cite-chips [role=tab]")].map((e) => e.getBoundingClientRect());
        return {
          width: c.width,
          height: c.height,
          stripOverflows: strip ? strip.scrollWidth > strip.clientWidth : false,
          stripInside: strip ? strip.getBoundingClientRect().right <= c.right + 0.5 : true,
          chips: chips.length,
          fades: bar ? [bar.dataset.fadeStart, bar.dataset.fadeEnd] : [],
        };
      });
    let citations = {};
    if (want("cards") || want("skeleton") || want("pinned")) {
      citations = await hoverCitations(["single", "several", "many"].filter((k) => k !== "many" || process.env.KEY_SMOKE_MANY));
      result.citations = citations;
      if (!citations.single) throw Error("No single-work citation to hover");
    }
    if (want("cards")) {
      for (const kind of ["single", "several", "many"]) {
        if (!citations[kind]) continue;
        await themes(`card-${kind}`, async () => {
          await showCitation(citations[kind]);
        });
        // A layout shift (theme switch, analysis arriving) can move the citation from under
        // a resting pointer, which rightly closes the card: hover again then.
        let geometry;
        for (let attempt = 0; attempt < 3 && !geometry; attempt++) {
          await showCitation(citations[kind]);
          if (await card.isVisible()) geometry = await cardGeometry();
        }
        if (geometry.width > 341) throw Error(`The ${kind} card is too wide: ${geometry.width}`);
        if (!geometry.stripInside) throw Error(`The ${kind} card's chips overflow the card`);
        result[`card-${kind}`] = { ...geometry, text: (await card.innerText()).replace(/\s+/g, " ").slice(0, 160) };
        if (geometry.chips > 1) {
          // Arrow keys move between works; the selected chip stays in view.
          await pdf.locator(".pdfjs-cite-chips [aria-selected=true]").focus();
          for (let i = 0; i < geometry.chips - 1; i++) await pdf.keyboard.press("ArrowRight");
          const last = await pdf.evaluate(() => {
            const strip = document.querySelector(".pdfjs-cite-chips [role=tablist]").getBoundingClientRect();
            const chip = document.querySelector(".pdfjs-cite-chips [aria-selected=true]").getBoundingClientRect();
            return chip.right <= strip.right + 1 && chip.left >= strip.left - 1;
          });
          if (!last) throw Error("The selected chip scrolled out of view");
          await shot(pdf, `card-${kind}-last`);
        }
      }
      await pdf.mouse.move(5, 5);
    }

    // 3. A rate-limited lookup: the card keeps a skeleton and retries, then shows the work;
    //    when the provider stays unavailable it says so quietly, with Retry.
    if (want("skeleton") && citations.single) {
      // Switching themes can shift the layout: hover afresh for each screenshot.
      const rateLimited = async (faults) => {
        await pdf.mouse.move(5, 5);
        await pdf.waitForTimeout(400);
        await pdf.evaluate((faults) => (window.__KEY_LOOKUP_FAULTS__ = faults), faults);
        await scrollTo(citations.single.top);
        await pdf.waitForTimeout(300);
        await hoverCitation(citations.single.id);
      };
      await themes("card-skeleton", async () => {
        await rateLimited({ scholarly: 3, baseMs: 1500 });
        await pdf.locator(".pdfjs-cite-skeleton").waitFor({ timeout: 3000 });
        await pdf.waitForTimeout(200);
      });
      // The real lookup follows the simulated failures; providers can be slow.
      await rateLimited({ scholarly: 2, baseMs: 400 });
      await pdf.locator(".pdfjs-cite-skeleton").waitFor({ timeout: 3000 });
      await pdf.waitForFunction(() => !document.querySelector(".pdfjs-cite-skeleton"), undefined, { timeout: 60000 });
      const recovered = await card.innerText();
      await pdf.evaluate(() => (window.__KEY_LOOKUP_FAULTS__ = { scholarly: 99, baseMs: 100, attempts: 3 }));
      await pdf.mouse.move(5, 5);
      await pdf.waitForTimeout(400);
      await hoverCitation(citations.single.id);
      await pdf.getByText("Couldn’t load details").waitFor({ timeout: 10000 });
      await shot(pdf, "card-unavailable-light");
      await pdf.evaluate(() => delete window.__KEY_LOOKUP_FAULTS__);
      await pdf.locator(".pdfjs-cite-unavailable button").click();
      await pdf.waitForFunction(() => !document.querySelector(".pdfjs-cite-unavailable, .pdfjs-cite-skeleton"), undefined, { timeout: 60000 });
      result.skeleton = { recovered: recovered.slice(0, 80), retried: await card.innerText().then((t) => t.slice(0, 80)) };
      await pdf.mouse.move(5, 5);
    }

    // 3b. A clicked citation card, expanded into its details: it stays while the page and the
    //     card scroll, and closes on a press outside it.
    if (want("pinned") && citations.single) {
      await pdf.mouse.move(5, 5);
      await scrollTo(citations.single.top);
      await pdf.waitForTimeout(300);
      const box = await pdf.locator(`.pdfjs-link-overlay.citation[data-id="${citations.single.id}"]`).first().boundingBox();
      await pdf.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await card.waitFor({ timeout: 3000 });
      await pdf.waitForFunction(() => !document.querySelector(".pdfjs-cite-skeleton"), undefined, { timeout: Number(process.env.KEY_SMOKE_LOOKUP_MS || 20000) }).catch(() => {});
      const details = pdf.locator(".pdfjs-cite-card [aria-label='Show details']");
      const expanded = await details.isVisible().catch(() => false);
      if (expanded) {
        await details.click();
        await pdf.locator(".pdfjs-cite-card[data-expanded] .pdfjs-cite-details").waitFor({ timeout: 3000 });
      }
      const inCard = await card.boundingBox();
      await pdf.mouse.move(inCard.x + inCard.width / 2, inCard.y + inCard.height / 2);
      await pdf.mouse.wheel(0, 300);
      await pdf.waitForTimeout(300);
      if (!(await card.isVisible())) throw Error("Scrolling inside the pinned card closed it");
      await pdf.mouse.move(inCard.x - 60 > 40 ? inCard.x - 60 : inCard.x + inCard.width + 60, inCard.y + 20);
      for (let i = 0; i < 4; i++) await pdf.mouse.wheel(0, 60);
      await pdf.waitForTimeout(400);
      if (!(await card.isVisible())) throw Error("Scrolling the page closed the pinned card");
      await themes(expanded ? "card-expanded" : "card-pinned", async () => {
        await pdf.waitForTimeout(200);
      });
      result.pinned = { expanded, geometry: await card.boundingBox() };
      await pdf.mouse.click(5, 300);
      await pdf.waitForTimeout(300);
      if (await card.isVisible()) throw Error("A press outside did not close the pinned card");
    }

    // 3c. The rail: wider under the pointer, chapters or thumbnails from its context menu.
    if (want("rail")) {
      await scrollTo(0);
      await pdf.waitForTimeout(300);
      const ticks = pdf.locator(".key-pdf-rail .key-preview-rail-ticks");
      await ticks.waitFor({ timeout: 10000 });
      // The dock check wants many ticks: page ticks, not the few chapters analysis may find.
      if ((await pdf.locator(".key-pdf-rail").getAttribute("data-mode")) !== "pages") {
        const box = await ticks.boundingBox();
        await pdf.mouse.click(box.x + 6, box.y + box.height / 2, { button: "right" });
        await pdf.getByRole("menuitemradio", { name: "Page thumbnails" }).click();
        await pdf.mouse.move(400, 400);
        await pdf.waitForTimeout(400);
      }
      const rest = await ticks.boundingBox();
      await pdf.mouse.move(rest.x + 6, rest.y + rest.height / 2);
      await pdf.waitForTimeout(450);
      const wide = await ticks.boundingBox();
      if (wide.width < rest.width * 2) throw Error(`The rail did not widen on hover: ${rest.width} → ${wide.width}`);
      // Dock-style: the tick under the pointer is longest, its neighbours less, far ones least;
      // the open rail sits on its own plate so it reads over any page.
      const dock = () =>
        pdf.evaluate((y) => {
          const buttons = [...document.querySelectorAll(".key-pdf-rail .key-preview-rail-ticks > button")];
          const scale = (b) => new DOMMatrix(getComputedStyle(b.querySelector(".key-preview-rail-tick")).transform).a;
          const at = buttons.findIndex((b) => {
            const r = b.getBoundingClientRect();
            return y >= r.top && y < r.bottom;
          });
          const nav = document.querySelector(".key-pdf-rail .key-preview-rail-ticks");
          const style = getComputedStyle(nav);
          return {
            at,
            count: buttons.length,
            pitch: buttons[0]?.getBoundingClientRect().height,
            hovered: scale(buttons[at]),
            near: Math.max(scale(buttons[at - 1] ?? buttons[at + 1]), scale(buttons[at + 1] ?? buttons[at - 1])),
            next: scale(buttons[at + 2] ?? buttons[at - 2]),
            far: Math.min(...buttons.filter((_, i) => Math.abs(i - at) >= 4).map(scale), 2),
            plate: style.backgroundColor,
            blur: style.backdropFilter,
          };
        }, rest.y + rest.height / 2);
      const magnified = await dock();
      if (magnified.at < 0 || magnified.count < 8) throw Error(`The rail has too few ticks to check: ${JSON.stringify(magnified)}`);
      if (!(magnified.hovered > magnified.near && magnified.near > magnified.next && magnified.next > magnified.far))
        throw Error(`The rail does not magnify around the pointer: ${JSON.stringify(magnified)}`);
      // No plate behind the open rail (the owner asked for none): a halo keeps it legible.
      if (!/rgba\(0, 0, 0, 0\)|transparent/.test(magnified.plate) || /blur/.test(magnified.blur))
        throw Error(`The open rail should have no backing: ${magnified.plate} ${magnified.blur}`);
      result.railDock = magnified;
      await themes("rail-hover", async () => {
        await pdf.mouse.move(rest.x + 6, rest.y + rest.height / 2 + 1);
        await pdf.waitForTimeout(450);
      });
      // Over a dark page: the plate keeps the ticks legible.
      await pdf.addStyleTag({ content: ".pdfjs-scroll{background:#15161a!important}.pdfjs-page{filter:invert(1) hue-rotate(180deg)}" });
      await pdf.mouse.move(600, 500);
      await themes("rail-rest-darkpage", async () => {
        await pdf.waitForTimeout(300);
      });
      await themes("rail-hover-darkpage", async () => {
        await pdf.mouse.move(rest.x + 30, rest.y + rest.height / 2, { steps: 4 });
        await pdf.mouse.move(rest.x + 6, rest.y + rest.height / 2 - 1, { steps: 4 });
        await pdf.waitForTimeout(450);
      });
      await pdf.evaluate(() => document.head.lastElementChild?.remove());
      await pdf.mouse.move(rest.x + 6, rest.y + rest.height / 2);
      await pdf.waitForTimeout(300);
      await pdf.mouse.click(rest.x + 6, rest.y + rest.height / 2, { button: "right" });
      const menu = pdf.getByRole("menu", { name: "Rail shows" });
      await menu.waitFor({ timeout: 3000 });
      await themes("rail-menu");
      const before = await pdf.locator(".key-pdf-rail").getAttribute("data-mode");
      const other = before === "pages" ? "Chapters" : "Page thumbnails";
      if (await menu.getByRole("menuitemradio", { name: other }).isEnabled()) {
        await menu.getByRole("menuitemradio", { name: other }).click();
        await pdf.waitForTimeout(200);
        const after = await pdf.locator(".key-pdf-rail").getAttribute("data-mode");
        if (after === before) throw Error("The rail's menu did not switch what it shows");
        const stored = await pdf.evaluate(() => localStorage.getItem("key.pdf.rail"));
        await pdf.mouse.move(rest.x + 6, rest.y + rest.height / 2 + 20);
        await pdf.waitForTimeout(500);
        await shot(pdf, `rail-${after}-light`);
        result.rail = { rest: rest.width, wide: wide.width, before, after, stored };
        await pdf.mouse.click(rest.x + 6, rest.y + rest.height / 2, { button: "right" });
        await menu.getByRole("menuitemradio", { name: before === "pages" ? "Page thumbnails" : "Chapters" }).click();
      } else {
        await pdf.keyboard.press("Escape");
        result.rail = { rest: rest.width, wide: wide.width, before, chapters: false };
      }
      await pdf.mouse.move(600, 500);
    }

    // 3d. The side panel beside the reader: References and Details in one panel, switched in
    //     its header (the old overlay is gone).
    if (want("panel")) {
      await pdf.mouse.move(600, 20);
      await pdf.getByRole("button", { name: "References", exact: true }).click();
      const panel = shell.locator(".key-reader-panel");
      await panel.waitFor({ timeout: 15000 });
      if (await pdf.locator(".key-panel-shell.references").count()) throw Error("The references overlay still opens");
      const tab = (name) => panel.getByRole("tab", { name: new RegExp(`^${name}`) });
      await shell.waitForFunction(() => document.querySelector(".key-reader-panel [role=tab][aria-selected=true]")?.textContent?.startsWith("References"), undefined, { timeout: 5000 });
      await panel.locator(".key-ref-list li").first().waitFor({ timeout: 90000 });
      const rows = await panel.locator(".key-ref-list li").count();
      const pressed = await pdf.getByRole("button", { name: "References", exact: true }).getAttribute("aria-pressed");
      if (pressed !== "true") throw Error("The References button is not shown pressed");
      for (const scheme of ["light", "dark"]) {
        await shell.evaluate((t) => window.key.setAppSettings({ theme: t }), scheme);
        await shell.emulateMedia({ colorScheme: scheme });
        await shell.waitForTimeout(300);
        await shot(shell, `panel-references-${scheme}`);
      }
      await shell.evaluate(() => window.key.setAppSettings({ theme: "system" }));
      // A reference takes the reader to its place in the list.
      const top = await pdf.evaluate(() => document.querySelector(".pdfjs-scroll").scrollTop);
      // The row itself: a looked-up reference also carries Add to library and Add to Inbox buttons.
      await panel.locator(".key-ref-list li > button:first-child").nth(Math.min(3, rows - 1)).click();
      await pdf.waitForFunction((t) => Math.abs(document.querySelector(".pdfjs-scroll").scrollTop - t) > 200, top, { timeout: 5000 });
      // The switch: Details shows the source's page in the same panel.
      await tab("Details").click();
      await shell.locator(".key-reader-panel .kx-source-page").waitFor({ timeout: 10000 });
      await pdf.waitForFunction(() => document.querySelector("[aria-label='Details & notes']")?.getAttribute("aria-pressed") === "true", undefined, { timeout: 5000 });
      for (const scheme of ["light", "dark"]) {
        await shell.evaluate((t) => window.key.setAppSettings({ theme: t }), scheme);
        await shell.emulateMedia({ colorScheme: scheme });
        await shell.waitForTimeout(300);
        await shot(shell, `panel-details-${scheme}`);
      }
      await shell.evaluate(() => window.key.setAppSettings({ theme: "system" }));
      await shell.emulateMedia({ colorScheme: "light" });
      // The panel's top reads as one header: tabs as wide as their labels on the row with the
      // panel's actions; the page's own bar right under it at the same insets; one divider; the
      // page scrolling below both. Checked at the widths the panel takes.
      const header = async (width) =>
        shell.evaluate((width) => {
          const pane = document.querySelector(".key-content-pane:has(> .key-reader-panel)");
          pane.style.flex = `0 0 ${width}px`;
          pane.style.width = `${width}px`;
          const box = (s) => document.querySelector(`.key-reader-panel ${s}`)?.getBoundingClientRect();
          const head = box(".key-side-panel-head");
          const tabs = box(".key-side-panel-switch");
          const actions = box(".key-side-panel-actions");
          const bar = box(".kx-source-page-bar");
          const badge = box(".kx-source-page-bar > :first-child");
          const toprow = box(".kx-item-page-toprow");
          const body = box(".kx-item-page-body");
          const style = (s) => getComputedStyle(document.querySelector(`.key-reader-panel ${s}`));
          return {
            width,
            panel: Math.round(box("").width ?? 0),
            pageWidth: document.querySelector(".key-reader-panel .kx-source-page").clientWidth,
            headHeight: Math.round(head.height),
            tabsWidth: Math.round(tabs.width),
            rowCentres: Math.abs(tabs.top + tabs.height / 2 - (actions.top + actions.height / 2)),
            gapUnderHead: Math.round(bar.top - head.bottom),
            insets: [Math.round(tabs.left - head.left), Math.round(badge.left - head.left)],
            barHeight: Math.round(bar.height),
            headDivider: style(".key-side-panel-head").borderBottomColor,
            barDivider: style(".kx-item-page-toprow").borderBottomWidth,
            scrollsBelow: body.top >= toprow.bottom - 1 && document.querySelector(".key-reader-panel .kx-item-page-body").scrollHeight >= 0,
            clipped: tabs.left < head.left || actions.right > head.right + 1,
          };
        }, width);
      result.panelHeader = [];
      for (const width of [280, 340, 420]) {
        await header(width);
        await shell.waitForTimeout(400);
        const h = await header(width);
        result.panelHeader.push(h);
        if (h.headHeight > 44) throw Error(`The panel header is more than one row: ${JSON.stringify(h)}`);
        if (h.rowCentres > 2) throw Error(`The tabs and the panel's buttons are not on one line: ${JSON.stringify(h)}`);
        if (h.tabsWidth > 0.75 * h.panel) throw Error(`The tabs are stretched across the panel: ${JSON.stringify(h)}`);
        if (h.gapUnderHead < 0 || h.gapUnderHead > 4) throw Error(`The page's bar does not sit right under the header: ${JSON.stringify(h)}`);
        if (Math.abs(h.insets[0] - h.insets[1]) > 2) throw Error(`The header rows do not share their inset: ${JSON.stringify(h)}`);
        if (!/rgba\(0, 0, 0, 0\)|transparent/.test(h.headDivider) || h.barDivider !== "1px") throw Error(`Not exactly one divider under the header: ${JSON.stringify(h)}`);
        if (!h.scrollsBelow || h.clipped) throw Error(`The header is overlapped or clipped: ${JSON.stringify(h)}`);
      }
      await shell.evaluate(() => {
        const pane = document.querySelector(".key-content-pane:has(> .key-reader-panel)");
        pane.style.flex = "";
        pane.style.width = "";
      });
      // Scrolled, the page's title pins just under the bar ("Back to the top" brings it back).
      const docked = shell.locator(".key-reader-panel .kx-source-page");
      // Long enough to scroll: the details opened.
      const details = docked.locator(".kx-page-details-toggle");
      // (Its summary line changes while the PDF is analysed, so the click goes straight to it.)
      if ((await details.getAttribute("aria-expanded")) !== "true") await details.evaluate((el) => el.click());
      await shell.waitForTimeout(300);
      await docked.locator(".kx-item-page-body").evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
      const pinned = docked.locator('.kx-page-pinned[data-visible="true"] button');
      await pinned.waitFor({ timeout: 5000 });
      await shell.waitForTimeout(400);
      const pin = await shell.evaluate(() => {
        const button = document.querySelector(".key-reader-panel .kx-page-pinned button").getBoundingClientRect();
        const bar = document.querySelector(".key-reader-panel .kx-item-page-toprow").getBoundingClientRect();
        return { top: Math.round(button.top), barBottom: Math.round(bar.bottom) };
      });
      if (pin.top < pin.barBottom - 1) throw Error(`The pinned title covers the panel's bar: ${JSON.stringify(pin)}`);
      // (The page keeps reflowing while the PDF is analysed, so the click goes straight to it.)
      await pinned.evaluate((el) => el.click());
      await docked.locator('.kx-page-pinned[data-visible="false"]').waitFor({ state: "attached", timeout: 5000 });
      await shell.waitForFunction(() => document.querySelector(".key-reader-panel .kx-item-page-body").scrollTop < 4, undefined, { timeout: 5000 });
      result.pinnedTitle = pin;
      // The open reader follows an edit made elsewhere: the title changed in the library's
      // inspector shows in the docked Details and the tab once the reader is in front again.
      const readerTab = await shell.evaluate(async () => (await window.key.tabs()).tabs.find((t) => t.views[0]?.kind === "pdf")?.id);
      await shell.evaluate((id) => window.key.tabAction("open-content", { section: "sources", workspaceId: id }), opened.workspaceId);
      const library = shell.locator(".kx-library:not([hidden])");
      await library.locator(".kx-row").first().click({ position: { x: 24, y: 14 } });
      const renamed = "A title edited in the library";
      const titleBox = library.locator(".kx-inspector").getByRole("textbox", { name: "Title", exact: true });
      await titleBox.fill(renamed);
      await titleBox.press("Enter");
      await shell.evaluate((id) => window.key.tabAction("activate", { tabId: id }), readerTab);
      await shell.locator(".key-reader-panel .kx-source-page", { hasText: renamed }).waitFor({ timeout: 15000 });
      await shell.waitForFunction(async (title) => (await window.key.tabs()).tabs.some((t) => t.views[0]?.kind === "pdf" && t.title.includes(title)), renamed, { timeout: 15000 });
      await shell.locator(`[data-tab-id="${readerTab}"]`, { hasText: renamed }).waitFor({ timeout: 15000 });
      await shot(shell, "panel-details-follows-edit");
      result.panelFollowsEdits = true;
      await tab("References").click();
      await shell.waitForFunction(() => document.querySelector(".key-reader-panel [role=tab][aria-selected=true]")?.textContent?.startsWith("References"), undefined, { timeout: 5000 });
      // A scroll made just as the panel closes is kept: the reader lays out again for its new
      // width a frame after the resize, and must not go back to where it was before.
      await pdf.evaluate(() => {
        const s = document.querySelector(".pdfjs-scroll");
        window.__closing = { width: s.clientWidth, scrolled: false };
        const observer = new ResizeObserver(() => {
          if (s.clientWidth === window.__closing.width) return;
          observer.disconnect();
          s.scrollTo({ top: 0, behavior: "instant" });
          window.__closing.scrolled = true;
        });
        observer.observe(s);
      });
      await panel.getByRole("button", { name: "Hide details and references" }).click();
      await panel.waitFor({ state: "detached", timeout: 5000 });
      await pdf.waitForFunction(() => window.__closing.scrolled, undefined, { timeout: 5000 });
      // Two frames on, the new layout has been applied.
      const kept = await pdf.evaluate(
        () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done({ top: document.querySelector(".pdfjs-scroll").scrollTop, page: document.querySelector(".pdfjs-page").offsetHeight })))),
      );
      if (kept.top > kept.page / 2) throw Error(`Closing the panel undid a scroll to the top (${kept.top})`);
      // A reader at the very top stays at the top when its width changes (the panel closes
      // and the pages grow wider and taller).
      await pdf.mouse.move(600, 20);
      await pdf.getByRole("button", { name: "References", exact: true }).click();
      await panel.waitFor({ timeout: 15000 });
      await pdf.waitForTimeout(600);
      await pdf.evaluate(() => document.querySelector(".pdfjs-scroll").scrollTo({ top: 0, behavior: "instant" }));
      await pdf.waitForTimeout(300);
      const narrow = await pdf.evaluate(() => {
        const s = document.querySelector(".pdfjs-scroll");
        window.__widening = { width: s.clientWidth, top: null };
        const observer = new ResizeObserver(() => {
          if (s.clientWidth === window.__widening.width) return;
          observer.disconnect();
          requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => (window.__widening.top = s.scrollTop))));
        });
        observer.observe(s);
        return s.clientWidth;
      });
      await panel.getByRole("button", { name: "Hide details and references" }).click();
      await panel.waitFor({ state: "detached", timeout: 5000 });
      await pdf.waitForFunction(() => window.__widening.top !== null, undefined, { timeout: 5000 });
      await pdf.waitForTimeout(400);
      const atTop = await pdf.evaluate(() => ({ first: window.__widening.top, settled: document.querySelector(".pdfjs-scroll").scrollTop, width: document.querySelector(".pdfjs-scroll").clientWidth }));
      if (atTop.first > 1 || atTop.settled > 1) throw Error(`A width change at the top moved the reader down (${atTop.first}, then ${atTop.settled}; ${narrow} → ${atTop.width} px wide)`);
      result.keepsTopOnResize = atTop;
      result.panel = { rows };
    }

    // 4. Cite: the selection toolbar copies the passage as a quote (no "Send to" there).
    //    Outside Key it is plain text; pasted into a note it becomes a source quote.
    if (want("cite")) {
      await scrollTo(0);
      await pdf.waitForTimeout(300);
      // Text runs are words: drag from "Each" to "patients".
      await pdf.waitForFunction(() => document.querySelectorAll(".pdfjs-text-run").length > 100, undefined, { timeout: 15000 });
      // The page's text layer can still be re-rendering after the panel closed: wait until the
      // passage is on the page and has stopped moving, and measure it in the same step (the
      // runs are replaced when a page renders again, so an index taken earlier can go stale).
      const b = await pdf
        .waitForFunction(
          () => {
            const runs = [...document.querySelectorAll(".pdfjs-text-run")];
            const words = runs.map((r) => r.textContent.trim());
            const at = words.findIndex((w, i) => w === "Each" && words.slice(i, i + 5).join(" ") === "Each nurse scanned 30 patients");
            if (at < 0) return false;
            const first = runs[at].getBoundingClientRect();
            const last = runs[at + 4].getBoundingClientRect();
            const box = { x: first.x, y: first.y, width: last.right - first.x, height: first.height };
            const centred = Math.abs(first.y + first.height / 2 - innerHeight / 2) < innerHeight / 4;
            const key = JSON.stringify(box);
            const settled = centred && window.__citePassage === key && box.width > 0 && box.height > 0;
            window.__citePassage = key;
            if (!centred) runs[at].scrollIntoView({ block: "center" });
            return settled && box;
          },
          undefined,
          { timeout: 20000, polling: 200 },
        )
        .then((h) => h.jsonValue())
        .catch(() => null);
      if (!b) throw Error("The passage to cite is not on the page");
      await pdf.mouse.move(b.x + 1, b.y + b.height / 2);
      await pdf.mouse.down();
      await pdf.mouse.move(b.x + b.width - 2, b.y + b.height / 2, { steps: 15 });
      await pdf.mouse.up();
      const toolbar = pdf.getByRole("toolbar", { name: "Text selection actions" });
      await toolbar.waitFor({ timeout: 5000 });
      if (await toolbar.getByRole("button", { name: /Send to/ }).count()) throw Error("The selection toolbar still offers Send to");
      await themes("selection-cite");
      await app.evaluate(({ clipboard }) => clipboard.clear());
      await toolbar.getByRole("button", { name: "Cite" }).click();
      await pdf.getByRole("status").filter({ hasText: "Quote copied" }).waitFor({ timeout: 5000 });
      const clip = await app.evaluate(({ clipboard }) => ({
        text: clipboard.readText(),
        html: clipboard.readHTML(),
        formats: clipboard.availableFormats(),
      }));
      // Attributed in the chosen citation style: APA's in-text citation with the page.
      if (!/^“.*Each nurse scanned 30 patients.*” — [^()]+, (?:\d{4}[a-z]?|n\.d\.), p\. \d+$/.test(clip.text)) throw Error(`Unexpected plain text: ${clip.text}`);
      if (!clip.html.includes("data-key-quote")) throw Error("The HTML form lacks the quote marker");
      result.cite = { text: clip.text, formats: clip.formats };

      // Paste into the source's note beside the PDF.
      await pdf.mouse.move(600, 20); // the toolbar steps aside while reading; the pointer brings it back
      await pdf.getByRole("button", { name: "Details & notes" }).click();
      const note = shell.locator(".kx-source-page[data-side=false] .kx-page-note .ProseMirror");
      await note.waitFor({ timeout: 15000 });
      await note.click();
      await shell.keyboard.press("Meta+ArrowDown");
      await shell.keyboard.press("Enter");
      // The quotes in this note: the library tab behind keeps the same source's note in its inspector.
      const quotes = note.locator(".ne-squote");
      const before = await quotes.count();
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.paste());
      await quotes.nth(before).waitFor({ timeout: 5000 });
      const pasted = quotes.last();
      const pastedText = await pasted.innerText();
      if (!/Each nurse scanned 30 patients/.test(pastedText)) throw Error(`Pasted quote: ${pastedText}`);
      await pasted.scrollIntoViewIfNeeded();
      await shell.waitForTimeout(300);
      await shot(shell, "note-pasted-quote");
      result.pasted = pastedText.replace(/\s+/g, " ").slice(0, 160);

      // 5. Clicking the quote's link: the reader scrolls and zooms so the passage sits in the
      //    middle, and lights it up.
      await scrollTo(3000);
      await pdf.waitForTimeout(300);
      const zoomBefore = await pdf.locator(".key-pdf-zoom").innerText();
      await pasted.locator(".ne-squote-link").click();
      await pdf.locator(".pdfjs-passage-flash").first().waitFor({ timeout: 8000 });
      await pdf.waitForTimeout(500);
      const placed = await pdf.evaluate(() => {
        const marks = [...document.querySelectorAll(".pdfjs-passage-flash")].map((e) => e.getBoundingClientRect());
        const s = document.querySelector(".pdfjs-scroll").getBoundingClientRect();
        const left = Math.min(...marks.map((r) => r.left));
        const right = Math.max(...marks.map((r) => r.right));
        const top = Math.min(...marks.map((r) => r.top));
        const bottom = Math.max(...marks.map((r) => r.bottom));
        return {
          dx: (left + right) / 2 - (s.left + s.width / 2),
          dy: (top + bottom) / 2 - (s.top + 30 + (s.height - 30) / 2),
          width: right - left,
          viewport: s.width,
        };
      });
      const zoomAfter = await pdf.locator(".key-pdf-zoom").innerText();
      result.quoteFocus = { ...placed, zoomBefore, zoomAfter };
      if (Math.abs(placed.dx) > 40 || Math.abs(placed.dy) > 40) throw Error(`The quote is not centred: ${JSON.stringify(placed)}`);
      await shot(pdf, "quote-focused");
    }

    // 6. Highlights: the selection toolbar follows a small scroll and closes once the passage
    //    is out of view; a highlight gets a margin marker whose card shows its comment first
    //    and the notes that quote it (the note above, after Cite).
    if (want("highlight")) {
      const selectPassage = async () => {
        await scrollTo(0);
        await pdf.waitForTimeout(300);
        await pdf.waitForFunction(() => document.querySelectorAll(".pdfjs-text-run").length > 100, undefined, { timeout: 15000 });
        const span = await pdf.evaluate(() => {
          const runs = [...document.querySelectorAll(".pdfjs-text-run")];
          const words = runs.map((r) => r.textContent.trim());
          const at = words.findIndex((w, i) => w === "Each" && words.slice(i, i + 5).join(" ") === "Each nurse scanned 30 patients");
          if (at < 0) return null;
          runs[at].scrollIntoView({ block: "center" });
          return at;
        });
        if (span === null) throw Error("The passage to highlight is not on the page");
        await pdf.waitForTimeout(400);
        const box = (i) => pdf.locator(".pdfjs-text-run").nth(i).boundingBox();
        const first = await box(span);
        const last = await box(span + 4);
        await pdf.mouse.move(first.x + 1, first.y + first.height / 2);
        await pdf.mouse.down();
        await pdf.mouse.move(last.x + last.width - 2, first.y + first.height / 2, { steps: 15 });
        await pdf.mouse.up();
      };
      const toolbar = pdf.getByRole("toolbar", { name: "Text selection actions" });
      const scrollBy = (dy) => pdf.evaluate((dy) => document.querySelector(".pdfjs-scroll").scrollBy({ top: dy, behavior: "instant" }), dy);
      await selectPassage();
      await toolbar.waitFor({ timeout: 5000 });
      const y0 = (await toolbar.boundingBox()).y;
      await scrollBy(40);
      await pdf.waitForTimeout(250);
      const y1 = (await toolbar.boundingBox())?.y;
      if (y1 === undefined || Math.abs(y0 - y1 - 40) > 6) throw Error(`The toolbar does not follow its passage: ${y0} -> ${y1}`);
      await scrollBy(1400);
      await toolbar.waitFor({ state: "detached", timeout: 3000 });
      result.toolbarScroll = { followed: Math.round(y0 - y1) };

      await selectPassage();
      await toolbar.waitFor({ timeout: 5000 });
      await toolbar.getByRole("button", { name: "green highlight" }).click();
      const marker = pdf.locator(".pdfjs-highlight-marker.color-green").first();
      await marker.waitFor({ timeout: 5000 });
      await pdf.keyboard.press("Escape");
      await pdf.waitForTimeout(200);
      await marker.click();
      const info = pdf.locator(".key-highlight-info");
      await info.waitFor({ timeout: 5000 });
      await info.getByRole("button", { name: "Add comment" }).click();
      const editor = pdf.getByRole("dialog", { name: "Comment editor" });
      await editor.waitFor({ timeout: 5000 });
      await pdf.keyboard.type("Thirty patients each: a small sample.");
      await editor.getByRole("button", { name: "Save comment" }).click();
      await editor.waitFor({ state: "detached", timeout: 5000 });
      await pdf.waitForTimeout(300);
      await marker.click();
      await info.waitFor({ timeout: 5000 });
      if (want("cite")) await info.locator(".key-highlight-info-uses li").first().waitFor({ timeout: 8000 });
      const card = await info.evaluate((el) => {
        const text = el.querySelector(".key-annotation-text");
        const size = (q) => parseFloat(getComputedStyle(text.querySelector(q)).fontSize);
        return {
          lead: text.firstElementChild.className,
          comment: size(".key-annotation-comment"),
          quote: size(".key-annotation-quote"),
          meta: el.querySelector(".key-highlight-info-meta")?.textContent,
          uses: [...el.querySelectorAll(".key-highlight-info-uses li")].map((li) => li.textContent),
        };
      });
      if (!/key-annotation-comment/.test(card.lead) || !(card.quote < card.comment)) throw Error(`The comment does not lead: ${JSON.stringify(card)}`);
      result.highlightInfo = card;
      await pdf.waitForTimeout(250);
      await themes("highlight-info", async () => {
        await pdf.waitForTimeout(150);
      });
    }

    // The reference: the library's details panel. Its bar has the height and the inset the
    // reader panel's header rows use.
    if (result.panelHeader) {
      const [ws] = await shell.evaluate(() => window.key.workspaces());
      await shell.evaluate((id) => window.key.tabAction("open-content", { section: "sources", workspaceId: id }), ws.id);
      await shell.locator(".kx-library:visible .kx-row").first().click();
      const bar = shell.locator(".kx-inspector .kx-source-page-bar");
      await bar.waitFor({ timeout: 15000 });
      result.referenceBar = [];
      for (const h of result.panelHeader) {
        // The library's panel set so its page is as wide as the reader panel's.
        const pageWidth = () => shell.locator(".kx-inspector .kx-source-page").evaluate((el) => el.clientWidth);
        await shell.locator(".kx-inspector").evaluate((el, w) => el.style.setProperty("--kx-inspector-width", `${w}px`), h.width);
        await shell.waitForTimeout(300);
        const off = h.pageWidth - Math.round(await pageWidth());
        await shell.locator(".kx-inspector").evaluate((el, w) => el.style.setProperty("--kx-inspector-width", `${w}px`), h.width + off);
        await shell.waitForTimeout(300);
        const reference = await bar.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const page = el.closest(".kx-source-page").getBoundingClientRect();
          return { height: Math.round(r.height), inset: Math.round(r.left - page.left) };
        });
        result.referenceBar.push(reference);
        if (h.barHeight !== reference.height) throw Error(`At ${h.width}px the reader panel's bar is ${h.barHeight}px, the library's ${reference.height}px`);
        if (Math.abs(h.insets[1] - reference.inset) > 2) throw Error(`At ${h.width}px the reader panel's inset is ${h.insets[1]}px, the library's ${reference.inset}px`);
      }
    }
    console.log(JSON.stringify({ ok: true, result, temp, shots }, null, 1));
  } catch (error) {
    for (const page of app.windows()) {
      const name = page.url().endsWith("/pdf.html") ? "failure-pdf" : `failure-${app.windows().indexOf(page)}`;
      await page.screenshot({ path: path.join(temp, `${name}.png`) }).catch(() => {});
    }
    console.error("Screenshots in", temp);
    throw error;
  } finally {
    await app.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
