import { describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TempPdfs, fileSha256 } from "./temp-pdfs";
import { browserUserAgent, citationPdfUrl, hostLabel, looksLikePdf, navigable, pdfTitle, safeFileName, systemUrl, uniqueName, webUrl } from "./urls";

describe("browser URLs", () => {
  it("opens only web pages in the browser, and mail links in the system", () => {
    expect(webUrl("https://arxiv.org/abs/1706.03762")).toBe("https://arxiv.org/abs/1706.03762");
    expect(webUrl("file:///etc/passwd")).toBeUndefined();
    expect(webUrl("key-media://x")).toBeUndefined();
    expect(webUrl("https://user:pw@example.com/")).toBeUndefined();
    expect(webUrl("not a url")).toBeUndefined();
    expect(systemUrl("mailto:a@b.org")).toBe("mailto:a@b.org");
    expect(systemUrl("javascript:alert(1)")).toBeUndefined();
    expect(navigable("about:blank")).toBe(true);
    expect(navigable("file:///tmp/x")).toBe(false);
    expect(hostLabel("https://www.plos.org/a")).toBe("plos.org");
  });
  it("looks like Chrome to sites", () => {
    const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Key/0.1.0 Chrome/140.0.0.0 Electron/43.3.0 Safari/537.36";
    expect(browserUserAgent(ua)).toBe("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36");
  });
  it("recognises PDFs and names them", () => {
    expect(looksLikePdf("application/pdf", "x")).toBe(true);
    expect(looksLikePdf("application/octet-stream", "paper.PDF")).toBe(true);
    expect(looksLikePdf("text/html", "index.html")).toBe(false);
    expect(pdfTitle("1706.03762v7.pdf", "https://arxiv.org/pdf/1706.03762v7")).toBe("1706.03762v7");
    expect(pdfTitle("download.pdf", "https://journals.plos.org/article/file?id=10.1371/x&type=printable")).toBe("journals.plos.org");
    expect(pdfTitle("1706.03762v7.pdf", "https://arxiv.org/pdf/1706.03762v7", "[1706.03762] Attention Is All You Need")).toBe("Attention Is All You Need");
    expect(pdfTitle("file.pdf", "https://x.org/file", "Sharing Detailed Research Data | PLOS One")).toBe("Sharing Detailed Research Data");
    expect(pdfTitle("Vaswani attention transformer.pdf", "https://x.org/a.pdf", "Some page")).toBe("Vaswani attention transformer");
    expect(safeFileName("a/b:c?.pdf")).toBe("a_b_c_.pdf");
    expect(uniqueName("a.pdf", (n) => n === "a.pdf" || n === "a (2).pdf")).toBe("a (3).pdf");
    expect(citationPdfUrl('<meta name="citation_pdf_url" content="/doi/pdf/10.1/x?a=1&amp;b=2">', "https://pub.org/doi/10.1/x")).toBe("https://pub.org/doi/pdf/10.1/x?a=1&b=2");
  });
});

describe("temporary PDFs", () => {
  const setup = async () => {
    const dir = await mkdtemp(join(tmpdir(), "key-temp-pdfs-"));
    const calls: [string, any][] = [];
    let clock = 1000;
    const library = {
      workspace: async () => ({ id: "scratch", root: join(dir, "library") }),
      invoke: async (command: string, args: any): Promise<any> => {
        calls.push([command, args]);
        if (command === "library_import_file") return { hash: await fileSha256(args.path), id: `src-${calls.length}` };
        return {};
      },
    };
    const store = new TempPdfs(dir, library, () => clock);
    const download = async (body: string) => {
      const path = store.incomingPath(String(Math.random()));
      await store.list();
      await writeFile(path, body);
      return path;
    };
    return { dir, calls, store, download, advance: (ms: number) => (clock += ms) };
  };
  it("keeps a PDF, analyses it in the scratch library, and cleans up what is old or too much", async () => {
    const { dir, calls, store, download, advance } = await setup();
    try {
      const a = await store.add(await download("%PDF-1.7 one"), "https://a.org/1.pdf", "One");
      expect(existsSync(a.file)).toBe(true);
      expect(calls.map((c) => c[0])).toEqual(["library_import_file", "store_update", "library_processing_control"]);
      advance(5000);
      const b = await store.add(await download("%PDF-1.7 two two"), "https://b.org/2.pdf", "Two");
      // Same content again: one entry.
      await store.add(await download("%PDF-1.7 one"), "https://a.org/1.pdf", "One");
      expect((await store.list()).length).toBe(2);
      await expect(store.add(await download("<html>"), "https://c.org", "C")).rejects.toThrow("not a PDF");
      advance(10_000);
      // Open ones stay whatever their age.
      expect(await store.cleanup({ ttlMs: 8000, keep: new Set([a.hash, b.hash]) })).toEqual([]);
      expect(await store.cleanup({ ttlMs: 8000, keep: new Set([b.hash]) })).toEqual([a.hash]);
      expect(existsSync(a.file)).toBe(false);
      expect(calls.some(([c, args]) => c === "store_delete" && args.ids.length === 1)).toBe(true);
      // Over the size cap, the least recently opened goes first.
      expect(await store.cleanup({ ttlMs: 1e9, maxBytes: 1 })).toEqual([b.hash]);
      expect(await readdir(store.pdfDir)).toEqual([]);
      // The manifest survives a restart.
      const c = await store.add(await download("%PDF-1.7 three"), "https://c.org/3.pdf", "Three");
      const again = new TempPdfs(dir, { workspace: async () => ({ id: "s", root: dir }), invoke: async (): Promise<any> => ({}) });
      expect((await again.get(c.hash))?.title).toBe("Three");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
