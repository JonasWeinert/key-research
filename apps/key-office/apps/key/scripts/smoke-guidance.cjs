// Real Electron smoke: guidance. Settings › Services & API keys says what an API key is: the
// "What is an API key?" explainer opens beside its link, inside the window, and Escape closes
// it while Settings stays open. Library access, Zotero, feeds and the Inbox's empty state
// explain themselves (the empty Inbox says what it is and offers its action). A first-use tip
// shows once beside its feature and stays dismissed after a reload. Screenshots in light and
// dark of each, at a small window too, to look at.
const { _electron: electron } = require("playwright-core");
const { mkdtemp, writeFile } = require("node:fs/promises");
const { createServer } = require("node:http");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const item = (n) => `<item><title>Guided work number ${n}</title><link>http://journal.test/articles/${n}</link><description>Summary ${n}.</description><pubDate>Tue, 1${n} Jun 2025 04:00:00 +0000</pubDate></item>`;

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-guidance-"));
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/rss+xml" });
    res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Journal of Guidance</title>${item(1)}${item(2)}</channel></rss>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const mock = `http://127.0.0.1:${server.address().port}`;
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: {
      ...process.env,
      KEY_SKIP_ONBOARDING: "1",
      KEY_SHOW_TIPS: "1",
      KEY_USER_DATA: path.join(temp, "profile"),
      KEY_WORKSPACE_PARENT: path.join(temp, "workspaces"),
      KEY_FEEDS_ALLOW_LOOPBACK: "1",
      KEY_OPENALEX_FIXTURES: temp,
    },
  });
  let page;
  const shots = [];
  const shot = async (name) => {
    const file = path.join(temp, `${name}.png`);
    await writeFile(file, await page.screenshot());
    shots.push(file);
  };
  const theme = (dark) => page.evaluate((dark) => document.documentElement.setAttribute("data-theme", dark ? "dark" : "light"), dark);
  const send = (event, value) => app.evaluate(({ BrowserWindow }, [event, value]) => BrowserWindow.getAllWindows()[0].webContents.send(event, value), [event, value]);
  const resize = (width, height) =>
    app.evaluate(({ BrowserWindow }, [width, height]) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.setMinimumSize(600, 400);
      w.setContentSize(width, height);
    }, [width, height]);
  const modal = () => page.locator(".key-modal").last();
  const section = async (name) => {
    await modal().getByRole("navigation", { name: /Settings sections$/ }).getByRole("button", { name, exact: true }).click();
    await page.waitForTimeout(350);
  };
  const inside = (box, vw, vh) => box.x >= 0 && box.y >= 0 && box.x + box.width <= vw + 0.5 && box.y + box.height <= vh + 0.5;
  try {
    page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await resize(1280, 820);
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();

    for (const dark of [false, true]) {
      const mode = dark ? "dark" : "light";
      await theme(dark);
      // Services & API keys: the opening line and its explainer.
      await send("open-settings");
      await modal().waitFor();
      await section("Services & API keys");
      await modal().getByText("Optional keys that give Key a higher allowance", { exact: false }).waitFor();
      const link = modal().getByRole("button", { name: "What is an API key?" });
      await link.click();
      const pop = page.getByRole("dialog", { name: "What is an API key?" });
      await pop.waitFor();
      await pop.getByText("What leaves this Mac", { exact: false }).waitFor();
      await page.waitForTimeout(250);
      const box = await pop.boundingBox();
      const vp = await page.evaluate(() => [innerWidth, innerHeight]);
      assert.ok(inside(box, ...vp), `the explainer stays inside the window: ${JSON.stringify(box)}`);
      assert.equal(await link.getAttribute("aria-expanded"), "true");
      await shot(`explainer-api-key-${mode}`);
      await page.keyboard.press("Escape");
      await pop.waitFor({ state: "detached" });
      assert.ok(await modal().isVisible(), "Escape closes the explainer, not Settings");
      const focused = await page.evaluate(() => document.activeElement?.textContent);
      assert.ok(focused?.includes("What is an API key?"), `focus goes back to the link: ${focused}`);
      // A service's own explainer: how to get a key, step by step.
      await modal().locator('[data-help="settings.services.openalex"]').click();
      const steps = page.getByRole("dialog", { name: "An OpenAlex key" });
      await steps.getByText("How to").waitFor();
      assert.ok((await steps.locator("ol li").count()) >= 3, "the steps to get a key are listed");
      await steps.getByRole("button", { name: "Close" }).click();
      await steps.waitFor({ state: "detached" });
      await shot(`settings-services-${mode}`);

      await section("Web & browser");
      await modal().getByRole("heading", { name: "Library access" }).scrollIntoViewIfNeeded();
      const access = modal().locator('[data-help="settings.web.access"]');
      assert.equal(await access.getAttribute("aria-label"), "Explain");
      assert.equal(await access.getAttribute("aria-description"), "What is library access?", "the (i) is described by what it explains");
      await access.click();
      await page.getByRole("dialog", { name: "What is library access?" }).waitFor();
      await page.waitForTimeout(350);
      await shot(`settings-library-access-${mode}`);
      await page.keyboard.press("Escape");

      await section("General");
      await modal().getByRole("heading", { name: "Glossary" }).scrollIntoViewIfNeeded();
      await modal().getByText("Digital Object Identifier", { exact: false }).waitFor();
      await shot(`settings-general-${mode}`);
      // Which window applies to what: Key Settings' scope line explains itself.
      await modal().locator('[data-help="settings.scope.app"]').click();
      await page.getByRole("dialog", { name: "Key Settings and Workspace Settings" }).waitFor();
      await page.waitForTimeout(300);
      await shot(`settings-scope-${mode}`);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await modal().waitFor({ state: "detached" });

      // Workspace Settings: its scope, Zotero, feeds, indexing.
      await send("open-workspace-settings");
      await modal().waitFor();
      await modal().locator('[data-help="settings.scope.workspace"]').waitFor();
      await section("Zotero");
      await modal().getByText("Key never changes your Zotero library", { exact: false }).first().waitFor();
      await shot(`workspace-zotero-${mode}`);
      await section("Feeds & alerts");
      await modal().getByRole("button", { name: "What are feeds and alerts?" }).waitFor();
      await shot(`workspace-feeds-${mode}`);
      await section("Indexing & lookups");
      for (const id of ["settings.search.indexing", "settings.search.metadata", "settings.libraries.find-pdf", "settings.search.people"]) await modal().locator(`[data-help="${id}"]`).first().waitFor();
      await shot(`workspace-indexing-${mode}`);
      await page.keyboard.press("Escape");
      await modal().waitFor({ state: "detached" });
    }
    await theme(false);

    // The empty Inbox: what it is, what to do, and its action.
    await page.locator(".kx-inbox-row button").click();
    const inbox = page.locator(".kx-inbox");
    const empty = inbox.locator(".kx-empty-state");
    await empty.getByRole("heading", { name: "Nothing followed yet" }).waitFor();
    await empty.getByText("The Inbox collects new articles", { exact: false }).waitFor();
    await empty.getByRole("button", { name: "Learn more" }).click();
    await page.getByRole("dialog", { name: "What are feeds and alerts?" }).waitFor();
    await page.waitForTimeout(350);
    await shot("inbox-empty-explainer-light");
    await page.keyboard.press("Escape");
    await theme(true);
    await shot("inbox-empty-dark");
    await theme(false);
    await shot("inbox-empty-light");

    // The manager, from the empty state's action; follow a feed so the Inbox has items.
    await empty.getByRole("button", { name: "Add a feed…" }).click();
    const sheet = page.getByRole("dialog", { name: "Feeds and alerts" });
    await sheet.getByText("Not following anything").waitFor();
    await shot("feeds-manager-light");
    await theme(true);
    await shot("feeds-manager-dark");
    await theme(false);
    await sheet.getByLabel("Feed or page address").fill(`${mock}/feed.xml`);
    await sheet.getByRole("button", { name: "Follow", exact: true }).click();
    await sheet.locator(".kx-feeds-row", { hasText: "Journal of Guidance" }).waitFor();
    await sheet.getByRole("button", { name: "Close", exact: true }).click();
    await sheet.waitFor({ state: "detached" });

    // The first-use tip beside the Inbox's keyboard hints: once, then gone for good.
    const tip = page.locator('.kx-tip[data-tip="tip.inbox-keys"]');
    await tip.waitFor();
    await page.waitForTimeout(300);
    const tipBox = await tip.boundingBox();
    assert.ok(inside(tipBox, ...(await page.evaluate(() => [innerWidth, innerHeight]))), "the tip is inside the window");
    await shot("tip-inbox-keys-light");
    await theme(true);
    await shot("tip-inbox-keys-dark");
    await theme(false);
    await tip.getByRole("button", { name: "Got it" }).click();
    await tip.waitFor({ state: "detached" });
    assert.ok((await page.evaluate(() => localStorage.getItem("key.tips"))).includes("tip.inbox-keys"), "the tip is remembered");
    // Kept in the app's settings (main), so a cleared view storage does not bring it back.
    await page.waitForFunction(async () => (await window.key.appSettings()).settings?.tips?.seen?.includes("tip.inbox-keys"));
    await page.evaluate(() => localStorage.removeItem("key.tips"));
    await page.reload();
    await page.getByRole("region", { name: "Home", exact: true }).waitFor().catch(() => {});
    await page.locator(".kx-inbox-row button").click();
    await page.locator(".kx-inbox-list > li").first().waitFor();
    await page.waitForTimeout(1500);
    assert.equal(await tip.count(), 0, "a dismissed tip does not come back");

    // A small window: the explainer still fits, scrolling inside when it must.
    await resize(760, 520);
    await page.waitForTimeout(300);
    await send("open-settings");
    await modal().waitFor();
    await section("Services & API keys");
    await modal().getByRole("button", { name: "What is an API key?" }).click();
    const small = page.getByRole("dialog", { name: "What is an API key?" });
    await small.waitFor();
    await page.waitForTimeout(200);
    assert.ok(inside(await small.boundingBox(), ...(await page.evaluate(() => [innerWidth, innerHeight]))), "the explainer fits a small window");
    await shot("explainer-small-window");
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, shots }, null, 2));
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(temp, "failure.png") }).catch(() => {});
    console.error(`Failure screenshot: ${path.join(temp, "failure.png")}`);
    throw error;
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
