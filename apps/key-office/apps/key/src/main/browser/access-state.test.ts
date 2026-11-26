import { describe, expect, it } from "vitest";
import { choose, decide, learn, mayProbe, newNetwork, PROBE_EVERY_MS, sanitizeNetworks, type LearnedNetwork } from "./access-state";

const net = () => newNetwork("abcdef0123456789", "Network at 14:02", 1);
const at = (network: LearnedNetwork, host: string) => decide({ mode: "auto", network, proxyId: "p", host });

describe("learning where the proxy is needed", () => {
  it("an unknown network tries directly first", () => {
    expect(at(net(), "www.jstor.org")).toEqual({ decision: "try", because: "unknown" });
    expect(decide({ mode: "auto", proxyId: "p", host: "x.org", offline: true })).toEqual({ decision: "try", because: "offline" });
  });
  it("one refusal sends the network through the proxy", () => {
    const n = learn(net(), { proxyId: "p", host: "www.jstor.org", access: "proxy", how: "page", now: 2 });
    expect(at(n, "www.nature.com")).toEqual({ decision: "proxy", because: "learned" });
    expect(at(n, "www.jstor.org")).toEqual({ decision: "proxy", because: "site" });
  });
  it("two sites loading directly make the network direct; one only the site", () => {
    const one = learn(net(), { proxyId: "p", host: "www.jstor.org", access: "direct", how: "page", now: 2 });
    expect(at(one, "www.jstor.org").decision).toBe("direct");
    expect(at(one, "www.nature.com").decision).toBe("try");
    const two = learn(one, { proxyId: "p", host: "www.nature.com", access: "direct", how: "page", now: 3 });
    expect(at(two, "link.springer.com")).toEqual({ decision: "direct", because: "learned" });
  });
  it("a probe or the proxy bouncing back speaks for the whole network", () => {
    expect(at(learn(net(), { proxyId: "p", access: "direct", how: "probe", now: 2 }), "a.org").decision).toBe("direct");
    expect(at(learn(net(), { proxyId: "p", host: "a.org", access: "direct", how: "bounce", now: 2 }), "b.org").decision).toBe("direct");
    expect(at(learn(net(), { proxyId: "p", access: "proxy", how: "probe", now: 2 }), "b.org").decision).toBe("proxy");
  });
  it("a split tunnel: on a direct network one publisher needing the proxy stays per site", () => {
    let n = learn(net(), { proxyId: "p", access: "direct", how: "probe", now: 2 });
    n = learn(n, { proxyId: "p", host: "www.sciencedirect.com", access: "proxy", how: "page", now: 3 });
    expect(at(n, "www.sciencedirect.com").decision).toBe("proxy");
    expect(at(n, "www.jstor.org").decision).toBe("direct");
    // Three different sites refused: the network was mistaken for direct, it heals.
    n = learn(n, { proxyId: "p", host: "a.org", access: "proxy", how: "page", now: 4 });
    n = learn(n, { proxyId: "p", host: "b.org", access: "proxy", how: "page", now: 5 });
    expect(at(n, "www.jstor.org").decision).toBe("proxy");
  });
  it("a refused site that later loads directly (a VPN came up) changes back", () => {
    let n = learn(net(), { proxyId: "p", host: "a.org", access: "proxy", how: "page", now: 2 });
    n = learn(n, { proxyId: "p", host: "a.org", access: "direct", how: "fetch", now: 3 });
    expect(at(n, "a.org").decision).toBe("direct");
  });
  it("a choice wins over what was learned, and is kept when learning goes on", () => {
    let n = learn(net(), { proxyId: "p", host: "a.org", access: "proxy", how: "page", now: 2 });
    n = choose(n, { host: "a.org" }, "direct", 3);
    n = learn(n, { proxyId: "p", host: "a.org", access: "proxy", how: "page", now: 4 });
    expect(at(n, "a.org")).toEqual({ decision: "direct", because: "user" });
    n = choose(n, { proxyId: "p" }, "proxy", 5);
    n = learn(n, { proxyId: "p", access: "direct", how: "probe", now: 6 });
    expect(at(n, "b.org")).toEqual({ decision: "proxy", because: "user" });
    // Forgetting the proxy's choice forgets what its sites learned, not what was chosen.
    n = choose(n, { proxyId: "p" }, undefined, 7);
    expect(at(n, "a.org").because).toBe("user");
    expect(at(n, "b.org").decision).toBe("try");
  });
  it("modes and the network's domain", () => {
    const n = learn(net(), { proxyId: "p", access: "direct", how: "probe", now: 2 });
    expect(decide({ mode: "always", network: n, proxyId: "p", host: "a.org" }).decision).toBe("proxy");
    expect(decide({ mode: "never", network: net(), proxyId: "p", host: "a.org" }).decision).toBe("ask");
    expect(decide({ mode: "auto", network: net(), proxyId: "p", host: "a.org", domainMatch: true })).toEqual({ decision: "direct", because: "domain" });
  });
  it("probes at most once a day per network", () => {
    const n = { ...net(), probed: { p: 1000 } };
    expect(mayProbe(n, "p", 1000 + PROBE_EVERY_MS - 1)).toBe(false);
    expect(mayProbe(n, "p", 1000 + PROBE_EVERY_MS)).toBe(true);
    expect(mayProbe(n, "q", 1001)).toBe(true);
  });
  it("keeps stored networks tidy", () => {
    const n = learn(net(), { proxyId: "p", host: "a.org", access: "direct", how: "page", now: 2 });
    const stored = sanitizeNetworks([n, { id: "nothex!" }, { ...n, proxies: { gone: { access: "direct", how: "probe", at: 1 } } }, null], new Set(["p"]));
    expect(stored).toHaveLength(1);
    expect(stored[0].proxies.p).toMatchObject({ access: "pending", granted: ["a.org"] });
    expect(stored[0].hosts["a.org"].access).toBe("direct");
    expect(JSON.stringify(stored)).not.toMatch(/gateway|ssid|mac/i);
  });
});
