# Key desktop packaging

From `apps/key-office`, build the Key shell with `npm run build`. Then run `npm run dist:mac -w @key/electron`: it builds
the shared PDF/search host with the release profile first
(`npm run build:backend:release`, about 5 minutes from clean on an M-series Mac,
seconds when nothing changed) into `apps/key/src-tauri/target/release`.
Development runs keep using the debug host (`npm run build:backend`).

The release host is 55 MB instead of 145 MB and much faster: on a 1,000-source
library, source pages 21 → 3 ms, tag index 26 → 3 ms, search 9 → 3 ms; indexing
three PDFs 29 s → 13 s (`node scripts/bench-host.cjs <debug host> <release host>`).

The current macOS artifact is an **unsigned development build**, using the
optimized Rust host. Signing,
notarization, installer updates and cross-platform qualification remain
separate release work. Do not describe this as a signed production release.

The package includes:

- The Key shell and the shared PDF reader.
- `Resources/backend/key-desktop-host` and PDFium's native library.
- No machine-learning models. The search model (EmbeddingGemma 2), the PDF
  layout model (PP-DocLayoutV3) and the reader search model (Arctic Embed XS)
  are downloaded on first need from Key's pinned Hugging Face repositories
  (`JonasWeinert/key-*`, listed with sizes and SHA-256 in
  `crates/key-models/manifest.json`), verified and kept once per machine in
  `~/Library/Application Support/Key/models`. Settings › Search & indexing can
  download, remove or add them from a file (for computers without internet);
  `tools/models/README.md` covers publishing and the dev cache.
- Third-party notices for imported npm packages and the host's crates,
  Chromium notices, PDFium's licences and Key's licence.

The preparation step checks every resource before packaging and refuses to
package model weights. It does not replace an existing source library.
Workspaces and their SQLite databases live outside the application bundle.

PDF imports and text extraction use Key's Rust PDFium backend.

## Vendored third-party code

Vendored crates are pristine upstream plus an ordered patch series, recorded in
`vendor/upstream.json` and updated with `node tools/vendor-update.mjs` (see `vendor/README.md`).
Run `node tools/vendor-update.mjs check` before a release to see newer upstream versions.
