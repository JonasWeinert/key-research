# Upstream provenance

Apache-2.0 source cloned from https://github.com/genspark-ai/genoffice at de139a061537bea40f0cc81ef8f09a95f77ac52a.

Key modifies product branding and shell integration. Copyright and license notices are retained. The separately licensed `ee/` directory and upstream PDF application/converter package are excluded. Key uses its original PDF reader and Rust services. The replacement desktop shell is Key's own `apps/key` (`@key/electron`), including its tab strips (`src/renderer/tab-strip.tsx`, `tab-drag.ts`, `tab-strip.css`), which are Key's own implementation and contain no GenOffice code.

Key removes GenOffice and Genspark branding from the editors: the Genspark account sign-in, the Genspark LLM and cloud tools, the bundled `@genspark/cli`, the Genspark and GenOffice logos and app icons, and the product names in user-visible strings and document metadata. AI features use the providers configured in Key's Settings. The bundled fallback fonts are renamed per SIL OFL 1.1 to Key names (`Key Sans KR`, `Key Serif KR`, `Key Gothic KR`, `Key Che Latin KR`, `Key Poppins`, `Key Tamil`, `Key UI Kana JP`, `Key PUA Blank`); their licence (`apps/docs/src/renderer/fonts/LICENSE-OFL.txt`) is kept. Copyright notices, `LICENSE`, `NOTICE` and this attribution are kept as Apache-2.0 requires; internal identifiers (CSS class names, command IDs, temporary folder names) and comments citing upstream issues are not user-visible and stay.

## Licensing

Everything cloned from GenOffice stays under Apache-2.0 (`LICENSE`, `NOTICE`), whether Key changed it or not; `UPSTREAM-CHANGES.txt` (from `node tools/list-upstream-changes.mjs`) lists the files Key modified, added and removed, as Apache-2.0 section 4(b) asks. Key's own code added here (`apps/key`, `packages/design-system`) is MIT. See `LICENSES.md` at the repository root.
