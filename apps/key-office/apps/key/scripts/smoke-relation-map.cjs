// Run serially: native windows and focus are shared with other GUI checks.
// Relation maps over a seeded library (recorded OpenAlex answers written for it; no network):
// a topic's overview page shows its map, hovering lights up what goes together, a node offers
// Search library / Open overview / Centre map here and re-centres; tags have overview pages;
// a source page has a small folded map; a note embeds one with the "Relation map" block; and
// every person, journal, topic and tag link offers the same choice on click and right-click.
// Screenshots (light and dark) are written to the temp folder printed at the end.
const { _electron: electron } = require("playwright-core");
const { mkdtemp, mkdir, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const TOPICS = {
  T1: ["Open Access Publishing", "S1804", "Library and Information Sciences", "F33", "Social Sciences"],
  T2: ["Research Data Management", "S1804", "Library and Information Sciences", "F33", "Social Sciences"],
  T3: ["Citation Analysis and Bibliometrics", "S1804", "Library and Information Sciences", "F33", "Social Sciences"],
  T4: ["Reproducibility in Science", "S3312", "Sociology and Political Science", "F33", "Social Sciences"],
  T5: ["Peer Review Processes", "S3312", "Sociology and Political Science", "F33", "Social Sciences"],
  T6: ["Scientific Software Development", "S1712", "Software", "F17", "Computer Science"],
  T7: ["Altmetrics and Social Media", "S1802", "Information Systems and Management", "F18", "Decision Sciences"],
};
const PEOPLE = {
  A1: "Ada Okafor",
  A2: "Lena Varga",
  A3: "Tomás Ruiz",
  A4: "Mei Chen",
  A5: "Jonah Weiss",
  A6: "Priya Raman",
  A7: "Sven Holm",
  A8: "Nadia Haddad",
};
const VENUES = { S1: "Journal of Open Research", S2: "Scientometrics", S3: "PeerJ Computer Science", S4: "Learned Publishing" };
// title, year, topics, authors, venue, tags, references (earlier works), collections
const WORKS = [
  ["The cost of closed science", 2016, ["T1", "T7"], ["A1", "A2"], "S4", ["open access", "policy"], [], ["thesis"]],
  ["Green and gold routes to open access", 2017, ["T1"], ["A1", "A3"], "S4", ["open access"], [1], ["thesis"]],
  ["Who reads preprints?", 2018, ["T1", "T7", "T3"], ["A2", "A4"], "S2", ["preprints", "open access"], [1], []],
  ["Counting citations to datasets", 2018, ["T3", "T2"], ["A4", "A5"], "S2", ["data", "metrics"], [3], ["thesis"]],
  ["Data sharing mandates in practice", 2019, ["T2", "T1"], ["A1", "A5"], "S1", ["data", "policy"], [1, 4], ["thesis", "reading"]],
  ["A replication crisis in software?", 2019, ["T4", "T6"], ["A6", "A7"], "S3", ["reproducibility", "software"], [], ["reading"]],
  ["Open peer review at scale", 2020, ["T5", "T1"], ["A2", "A8"], "S1", ["peer review", "open access"], [2, 3], ["thesis"]],
  ["Badges for reproducible research", 2020, ["T4", "T2"], ["A6", "A1"], "S1", ["reproducibility", "data"], [5, 6], ["reading"]],
  ["Altmetrics as early signals", 2020, ["T7", "T3"], ["A4", "A2"], "S2", ["metrics"], [3, 4], []],
  ["Research software citation", 2021, ["T6", "T3"], ["A7", "A5"], "S3", ["software", "metrics"], [4, 6], ["thesis"]],
  ["Funder policies on open access", 2021, ["T1"], ["A3", "A1"], "S4", ["policy", "open access"], [1, 2, 5], ["thesis"]],
  ["Registered reports five years on", 2021, ["T4", "T5"], ["A8", "A6"], "S1", ["reproducibility", "peer review"], [7, 8], ["reading"]],
  ["The economics of article charges", 2022, ["T1", "T3"], ["A3", "A2"], "S4", ["open access", "policy"], [1, 11], []],
  ["FAIR data in the long tail", 2022, ["T2"], ["A5", "A1"], "S1", ["data"], [4, 5], ["thesis"]],
  ["Containers and computational reproducibility", 2022, ["T6", "T4"], ["A7", "A6"], "S3", ["software", "reproducibility"], [6, 10], ["reading"]],
  ["Preprint review communities", 2023, ["T5", "T1", "T7"], ["A8", "A2", "A4"], "S1", ["preprints", "peer review"], [3, 7], ["thesis"]],
  ["Open science indicators", 2023, ["T3", "T1", "T2"], ["A4", "A1"], "S2", ["metrics", "open access", "data"], [9, 11, 14], ["thesis"]],
  ["Teaching open research practices", 2024, ["T4", "T1"], ["A6", "A3"], "S1", ["reproducibility", "teaching"], [8, 12], ["reading"]],
];
const wid = (i) => `W90000${String(i).padStart(2, "0")}`;
const doi = (i) => `10.5555/key-map.${i}`;

function work(i) {
  const [title, year, topics, authors, venue, , refs] = WORKS[i - 1];
  const topic = (id, n) => {
    const [name, sub, subName, field, fieldName] = TOPICS[id];
    return {
      id: `https://openalex.org/${id}`,
      display_name: name,
      score: 0.99 - n * 0.1,
      subfield: { id: `https://openalex.org/subfields/${sub.slice(1)}`, display_name: subName },
      field: { id: `https://openalex.org/fields/${field.slice(1)}`, display_name: fieldName },
      domain: { id: "https://openalex.org/domains/2", display_name: "Social Sciences" },
    };
  };
  return {
    id: `https://openalex.org/${wid(i)}`,
    doi: `https://doi.org/${doi(i)}`,
    display_name: title,
    title,
    publication_year: year,
    publication_date: `${year}-03-01`,
    ids: { openalex: `https://openalex.org/${wid(i)}`, doi: `https://doi.org/${doi(i)}` },
    language: "en",
    primary_location: { source: { id: `https://openalex.org/${venue}`, display_name: VENUES[venue], issn_l: null, issn: [], type: "journal", is_oa: true, is_in_doaj: false } },
    type: "article",
    open_access: { is_oa: true, oa_status: "gold" },
    authorships: authors.map((a, n) => ({ author_position: n ? "middle" : "first", author: { id: `https://openalex.org/${a}`, display_name: PEOPLE[a], orcid: null }, institutions: [] })),
    biblio: {},
    is_retracted: false,
    cited_by_count: 10 + i * 7,
    fwci: 1.2,
    primary_topic: topic(topics[0], 0),
    topics: topics.map(topic),
    keywords: [],
    funders: [],
    awards: [],
    referenced_works: refs.map((r) => `https://openalex.org/${wid(r)}`),
    abstract_inverted_index: null,
  };
}

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-relation-map-"));
  const fixtures = path.join(temp, "openalex");
  await mkdir(fixtures);
  for (let i = 1; i <= WORKS.length; i++) await writeFile(path.join(fixtures, `${wid(i)}.json`), JSON.stringify(work(i)));
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: {
      ...process.env,
      KEY_SKIP_ONBOARDING: "1",
      KEY_USER_DATA: path.join(temp, "profile"),
      KEY_WORKSPACE_PARENT: path.join(temp, "workspaces"),
      KEY_OPENALEX_FIXTURES: fixtures,
    },
  });
  const shot = (page, name) => page.screenshot({ path: path.join(temp, `${name}.png`) });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 960));
    await page.emulateMedia({ colorScheme: "light" });
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => page.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });
    const tabAction = (action, payload) => page.evaluate(({ action, payload }) => window.key.tabAction(action, payload), { action, payload });

    // The library: 18 articles in two collections, looked up from the recorded answers.
    const thesis = await call("store_collection_create", { name: "Thesis", parentId: null });
    const reading = await call("store_collection_create", { name: "Reading group", parentId: null });
    const ids = [];
    for (let i = 1; i <= WORKS.length; i++) {
      const [title, year, , authors, , tags, , collections] = WORKS[i - 1];
      const source = await call("store_create", {
        source: {
          kind: "reference",
          itemType: "article",
          title,
          year,
          doi: doi(i),
          tags,
          creators: authors.map((a) => ({ given: PEOPLE[a].split(" ")[0], family: PEOPLE[a].split(" ").slice(1).join(" ") })),
          collections: collections.map((c) => (c === "thesis" ? thesis.id : reading.id)),
        },
      });
      ids.push(source.id);
    }
    for (let round = 0; round < 160; round++) {
      const states = await Promise.all(ids.map((id) => call("store_source", { id }).then((s) => s.enrichStatus)));
      if (states.every((s) => s === "done")) break;
      assert.ok(round < 159, `looked up: ${states.join(", ")}`);
      await page.waitForTimeout(250);
    }

    // The store's map: shared counts, capped kinds, ties between what is shown.
    const map = await call("store_relation_map", { kind: "topic", id: "T1", limit: 8 });
    assert.equal(map.center.name, "Open Access Publishing");
    assert.equal(map.center.count, 10);
    assert.equal(map.nodes.find((n) => n.kind === "tag" && n.id === "open access")?.count, 7);
    assert.ok(map.nodes.some((n) => n.kind === "venue" && n.name === "Learned Publishing"));
    assert.ok(map.links.length > 0, "ties between the shown nodes");

    // A topic's overview: its map under "Relations".
    await tabAction("open-content", { section: "topic", workspaceId: ws.id, entityId: "T1", title: "Open Access Publishing" });
    const topicPage = page.locator(".kx-entity-page:visible");
    const mapBox = topicPage.locator(".kx-map");
    await mapBox.locator(".kx-map-node.kx-map-center").waitFor();
    await mapBox.locator('.kx-map-node[data-kind="person"]').first().waitFor();
    assert.ok((await mapBox.locator(".kx-map-node").count()) >= 15, "a full map");
    await mapBox.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await shot(page, "topic-map-light");
    await mapBox.screenshot({ path: path.join(temp, "topic-map-light-crop.png") });

    // Hover: neighbours light up, the rest dims, the caption says what it shares.
    const ada = mapBox.locator('.kx-map-node[data-kind="person"]', { hasText: "Ada Okafor" });
    await ada.locator(".kx-map-hit").hover();
    await mapBox.locator(".kx-map-svg[data-hovering]").waitFor();
    await mapBox.locator(".kx-map-caption", { hasText: "Ada Okafor" }).waitFor();
    assert.ok((await mapBox.locator(".kx-map-node[data-dim]").count()) > 0, "others dim");
    await page.waitForTimeout(250);
    await mapBox.screenshot({ path: path.join(temp, "topic-map-hover.png") });

    // Kinds toggle from the legend; the strength slider thins the map.
    const before = await mapBox.locator(".kx-map-node").count();
    await mapBox.locator('.kx-map-kind[data-kind="tag"]').click();
    assert.equal(await mapBox.locator('.kx-map-node[data-kind="tag"]').count(), 0);
    await mapBox.locator('.kx-map-kind[data-kind="tag"]').click();
    await mapBox.locator(".kx-map-strength input").fill("3");
    await page.waitForFunction((n) => document.querySelectorAll(".kx-entity-page .kx-map-node").length < n, before);
    await mapBox.locator(".kx-map-strength input").fill("1");

    // A node's choice; Centre map here re-centres (and Back returns).
    await page.mouse.move(5, 5);
    await ada.locator(".kx-map-hit").click();
    const popover = page.locator(".kx-entity-popover");
    await popover.locator("strong", { hasText: "Ada Okafor" }).waitFor();
    await popover.getByRole("button", { name: /Search library/ }).waitFor();
    await popover.getByRole("button", { name: /Open overview/ }).waitFor();
    await page.waitForTimeout(200);
    await shot(page, "map-node-choice");
    await popover.getByRole("button", { name: /Centre map here/ }).click();
    await mapBox.locator('.kx-map-center[data-kind="person"]').waitFor();
    await mapBox.locator(".kx-map-back", { hasText: "Open Access Publishing" }).waitFor();
    await page.waitForTimeout(700);
    await mapBox.screenshot({ path: path.join(temp, "person-map-recentred.png") });
    await mapBox.locator(".kx-map-back").click();
    await mapBox.locator('.kx-map-center[data-kind="topic"]').waitFor();

    // Dark.
    await page.emulateMedia({ colorScheme: "dark" });
    await page.mouse.move(5, 5);
    await page.waitForTimeout(400);
    await shot(page, "topic-map-dark");
    await mapBox.screenshot({ path: path.join(temp, "topic-map-dark-crop.png") });
    await ada.locator(".kx-map-hit").hover();
    await page.waitForTimeout(250);
    await mapBox.screenshot({ path: path.join(temp, "topic-map-dark-hover.png") });
    await page.emulateMedia({ colorScheme: "light" });

    // Entity links on the page: right-click offers the two choices first.
    await topicPage.locator(".kx-page-details-toggle").click().catch(() => {});
    const personLink = topicPage.locator('.kx-research-row[data-research="People"] .kx-entity-link').first();
    await personLink.click({ button: "right" });
    const menu = page.locator(".kx-item-menu");
    await menu.getByRole("menuitem", { name: /Search library/ }).waitFor();
    await menu.getByRole("menuitem", { name: /Open overview/ }).waitFor();
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });

    // A tag has an overview page with its map.
    await tabAction("open-content", { section: "tag", workspaceId: ws.id, entityId: "reproducibility", title: "reproducibility" });
    const tagPage = page.locator(".kx-entity-page:visible", { hasText: "reproducibility" });
    await tagPage.locator(".kx-entity-title", { hasText: "reproducibility" }).waitFor();
    await tagPage.locator('.kx-map-center[data-kind="tag"]').waitFor();
    await tagPage.locator('.kx-map-node[data-kind="topic"]', { hasText: "Reproducibility in Science" }).waitFor();
    await page.waitForTimeout(400);
    await shot(page, "tag-page");

    // A source page: the small map, folded until opened.
    const paper = ids[16];
    await tabAction("open-source-page", { workspaceId: ws.id, sourceId: paper, title: "Open science indicators", read: false });
    const sourcePage = page.locator(".kx-source-page[data-side=false]");
    const relations = sourcePage.locator("details.kx-map-section");
    await relations.waitFor();
    assert.equal(await relations.getAttribute("open"), null, "folded by default");
    await relations.locator("summary").click();
    await relations.locator('.kx-map[data-variant="paper"] .kx-map-node[data-kind="source"]').first().waitFor();
    await relations.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await relations.screenshot({ path: path.join(temp, "paper-map-light.png") });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(300);
    await relations.screenshot({ path: path.join(temp, "paper-map-dark.png") });
    await page.emulateMedia({ colorScheme: "light" });

    // Topic chips on the source page: a click offers the choice; Search library filters.
    const topicsRow = sourcePage.locator('.kx-research-row[data-research="Topics"]');
    if (!(await topicsRow.isVisible())) await sourcePage.locator(".kx-page-details-toggle").click();
    await sourcePage.locator('.kx-research-row[data-research="Topics"] .kx-entity-link', { hasText: "Open Access Publishing" }).click();
    await popover.getByRole("button", { name: /Search library/ }).click();
    const library = page.locator(".kx-library:visible");
    await library.locator('.kx-token[data-field="topic"]', { hasText: "Open Access Publishing" }).waitFor();

    // In the library, an author's name offers the choice too, and searching adds a token.
    const row = library.locator(".kx-row", { hasText: "Green and gold routes" });
    await row.locator(".kx-entity-link", { hasText: "Okafor" }).click();
    await popover.locator("strong", { hasText: "Ada Okafor" }).waitFor();
    await popover.getByRole("button", { name: /Search library/ }).click();
    await library.locator('.kx-token[data-field="person"]', { hasText: "Ada Okafor" }).waitFor();
    await library.locator('.kx-token[data-field="topic"]').waitFor();
    await shot(page, "library-tokens");

    // A note embeds a map with the Relation map block.
    const note = await call("store_note_save", { id: null, sourceId: null, title: "Mapping open access", body: "Where it sits:\n\n" });
    await tabAction("open-content", { section: "note", workspaceId: ws.id, noteId: note.id, title: note.title });
    const editor = page.locator(".kx-note-page:visible .ProseMirror").first();
    await editor.waitFor();
    await editor.click();
    await page.keyboard.press("End");
    await page.keyboard.press("Meta+ArrowDown");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/relation");
    await page.locator(".ne-menu").getByText("Relation map", { exact: true }).click();
    await page.keyboard.type("open acc");
    await page.locator(".ne-menu").getByText("Open Access Publishing").first().click();
    const embed = page.locator('.kx-note-page:visible .ne-item-embed[data-view="map"]');
    await embed.locator(".kx-map-node.kx-map-center").waitFor();
    await embed.locator('.kx-map-kind[data-kind="collection"]').click();
    await page.waitForTimeout(1500);
    const saved = await call("store_note", { id: note.id });
    assert.match(saved.body, /```embed href="key:\/\/topic\/T1" view="map"/);
    assert.match(saved.body, /kinds="topic,field,person,venue,tag,source"|kinds="topic,field,person,venue,tag"/, "the kinds shown are saved");
    assert.match(saved.body, /Relation map of Open Access Publishing: /, "a plain-text line for other readers");
    await embed.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await shot(page, "note-embed");
    await embed.screenshot({ path: path.join(temp, "note-embed-crop.png") });

    // A link to a topic in a note offers the same choice.
    const linking = await call("store_note_save", { id: null, sourceId: null, title: "Reading list", body: "See [Peer Review Processes](key://topic/T5).\n" });
    await tabAction("open-content", { section: "note", workspaceId: ws.id, noteId: linking.id, title: linking.title });
    const link = page.locator('.kx-note-page:visible a[href="key://topic/T5"]');
    await link.waitFor();
    await link.click();
    await popover.locator("strong", { hasText: "Peer Review Processes" }).waitFor();
    await popover.getByRole("button", { name: /Open overview/ }).click();
    await page.locator(".kx-entity-page:visible .kx-entity-title", { hasText: "Peer Review Processes" }).waitFor();

    assert.deepEqual(errors, []);
    console.log(`relation map smoke passed; screenshots in ${temp}`);
  } finally {
    await app.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
