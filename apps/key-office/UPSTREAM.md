# Upstream provenance

Apache-2.0 source cloned from https://github.com/genspark-ai/genoffice at de139a061537bea40f0cc81ef8f09a95f77ac52a.

Key modifies product branding and shell integration. Copyright and license notices are retained. The separately licensed `ee/` directory and upstream PDF application/converter package are excluded. Key uses its original PDF reader and Rust services. The replacement desktop shell is Key's own `apps/key` (`@key/electron`).

Key's `apps/key/src/renderer/TabBar.tsx` and `tabbar.css` also retain the upstream shell's tab-strip implementation and icon artwork. Its pointer-capture drag algorithm, live neighbour transforms, overflow controls and appearance are connected to Key's owned tab groups. Unlike upstream's fixed Home slot, Key's Home tabs are movable; split groups reorder as indivisible units.

## Licensing

Everything cloned from GenOffice stays under Apache-2.0 (`LICENSE`, `NOTICE`), whether Key changed it or not; `UPSTREAM-CHANGES.txt` (from `node tools/list-upstream-changes.mjs`) lists the files Key modified, added and removed, as Apache-2.0 section 4(b) asks. Key's own code added here (`apps/key`, `packages/design-system`) is MIT, except `apps/key/src/renderer/TabBar.tsx` and `tabbar.css`, which carry `SPDX-License-Identifier: Apache-2.0` headers because they derive from GenOffice's shell. See `LICENSES.md` at the repository root.
