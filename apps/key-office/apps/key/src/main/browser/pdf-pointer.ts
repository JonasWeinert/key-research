// Find PDF on a publisher's page: points at the page's own PDF link (or a viewer's Download
// button) so the person clicks it themselves. Many publishers only serve the PDF from that
// click, with their session and referrer. A soft halo and a small "PDF" tag sit over the
// element in a closed shadow root of their own (the page's styles cannot reach them, and they
// never catch a click). The halo goes when the element is clicked or the page navigates. Key
// never clicks for the person. Runs in an isolated world, so the page's scripts cannot see it.
import type { WebContents } from "electron";

/** The isolated world the pointer lives in (its state is kept there between calls). */
const WORLD = 1998;

export interface PointAt {
  /** Addresses of the PDF links found on the page, best first. */
  urls: string[];
  /** Labels of download controls without an address (viewers, interstitials). */
  labels: string[];
}

const script = (target: PointAt, options: { scroll: boolean; accent: string }) => String.raw`(() => {
  const K = window.__keyPdfPointer || (window.__keyPdfPointer = {});
  if (K.remove) K.remove();
  const urls = ${JSON.stringify(target.urls)}, labels = ${JSON.stringify(target.labels.map((l) => l.trim().toLowerCase()))};
  const norm = (u) => { try { const x = new URL(u, location.href); x.hash = ""; return x.href; } catch { return ""; } };
  const wanted = urls.map(norm);
  const shown = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 1 && r.height > 1 && s.visibility !== "hidden" && s.display !== "none"; };
  const addressOf = (el) => el.getAttribute("href") || el.getAttribute("data-href") || el.getAttribute("data-url") || el.getAttribute("data-pdf-url") || "";
  let el;
  for (const url of wanted) {
    el = [...document.querySelectorAll("a[href], area[href], [data-href], [data-url], [data-pdf-url]")].find((e) => norm(addressOf(e)) === url && shown(e));
    if (el) break;
  }
  const said = (e) => [e.innerText, e.getAttribute("aria-label"), e.getAttribute("title"), e.value].map((v) => String(v || "").replace(/\s+/g, " ").trim().toLowerCase()).filter(Boolean);
  if (!el && labels.length) el = [...document.querySelectorAll("button, [role=button], a, input[type=button], input[type=submit]")].find((e) => shown(e) && said(e).some((s) => labels.includes(s)));
  if (!el) return { found: false };
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const host = document.createElement("div");
  host.setAttribute("data-key-pdf-pointer", "");
  host.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647";
  const root = host.attachShadow({ mode: "closed" });
  const accent = ${JSON.stringify(options.accent)};
  root.innerHTML = '<style>' +
    '.ring{position:fixed;box-sizing:border-box;border-radius:8px;border:2.5px solid ' + accent + ';box-shadow:0 0 0 3px rgba(255,255,255,.92),0 0 0 7px ' + accent + '40;transition:none}' +
    '.ring.pulse{animation:k 1.6s ease-in-out 3}' +
    '@keyframes k{50%{box-shadow:0 0 0 3px rgba(255,255,255,.92),0 0 0 13px ' + accent + '1f}}' +
    '.tag{position:fixed;display:flex;align-items:center;gap:3px;height:20px;padding:0 7px 0 6px;border-radius:10px;background:' + accent + ';color:#fff;' +
    'font:600 11px/1 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;letter-spacing:.02em;box-shadow:0 0 0 2px rgba(255,255,255,.92),0 2px 6px rgba(0,0,0,.25);white-space:nowrap}' +
    '.tag svg{width:10px;height:10px}' +
    '</style><div class="ring"></div><div class="tag"><svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 1.5v7M2 5.5 5 8.5 8 5.5"/></svg>PDF</div>';
  document.documentElement.appendChild(host);
  const ring = root.querySelector(".ring"), tag = root.querySelector(".tag");
  let frame = 0;
  const place = () => {
    frame = 0;
    if (!el.isConnected) return remove();
    const r = el.getBoundingClientRect();
    Object.assign(ring.style, { left: r.left - 5 + "px", top: r.top - 5 + "px", width: r.width + 10 + "px", height: r.height + 10 + "px" });
    const above = r.top > 34;
    Object.assign(tag.style, { left: Math.max(4, r.left - 5) + "px", top: (above ? r.top - 30 : r.bottom + 10) + "px" });
    tag.querySelector("svg").style.transform = above ? "" : "rotate(180deg)";
  };
  const later = () => { if (!frame) frame = requestAnimationFrame(place); };
  const timer = setInterval(later, 400);
  const pulse = () => { if (reduce) return; ring.classList.remove("pulse"); void ring.offsetWidth; ring.classList.add("pulse"); };
  function remove() {
    clearInterval(timer);
    cancelAnimationFrame(frame);
    removeEventListener("scroll", later, true);
    removeEventListener("resize", later);
    el.removeEventListener("click", clicked, true);
    host.remove();
    K.remove = undefined;
    K.show = undefined;
  }
  // The person's own click goes through untouched; the halo just leaves.
  function clicked() { remove(); }
  addEventListener("scroll", later, { capture: true, passive: true });
  addEventListener("resize", later, { passive: true });
  el.addEventListener("click", clicked, true);
  K.remove = remove;
  K.show = () => { el.scrollIntoView({ block: "center", inline: "nearest", behavior: reduce ? "auto" : "smooth" }); later(); pulse(); return true; };
  place();
  pulse();
  if (${options.scroll ? "true" : "false"}) { const r = el.getBoundingClientRect(); if (r.top < 0 || r.bottom > innerHeight) K.show(); }
  const label = said(el)[0] || "PDF";
  return { found: true, label: label.slice(0, 60) };
})()`;

/** Points at the PDF link or download control on the page; whether one was found, and what it says. */
export async function pointAtPdf(contents: WebContents, target: PointAt, options: { scroll: boolean; accent: string }) {
  if (contents.isDestroyed() || (!target.urls.length && !target.labels.length)) return { found: false as const };
  const answer = (await contents.executeJavaScriptInIsolatedWorld(WORLD, [{ code: script(target, options) }], false).catch(() => undefined)) as { found: boolean; label?: string } | undefined;
  return answer?.found ? { found: true as const, label: String(answer.label ?? "PDF") } : { found: false as const };
}

/** "Show me": scrolls to the pointed-at element and pulses it again; false when it is gone. */
export async function showPdfPointer(contents: WebContents) {
  if (contents.isDestroyed()) return false;
  return !!(await contents.executeJavaScriptInIsolatedWorld(WORLD, [{ code: `!!(window.__keyPdfPointer && window.__keyPdfPointer.show && window.__keyPdfPointer.show())` }], false).catch(() => false));
}
