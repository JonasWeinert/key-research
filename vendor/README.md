# Vendored code

Third-party code kept in this repository stays identifiable as upstream plus Key's changes,
so moving to a new upstream release is routine.

- `vendor/upstream.json` records, for every tree here, where it came from: crate and version
  (or binary build), source URL, upstream commit and checksum. Trees Key wrote itself
  (`*-compat`) are marked `original`.
- A patched crate is pristine upstream (pruned of tests and docs) plus an ordered patch
  series in `vendor/patches/<name>/`. The `series` file lists the patches in order, each with
  a one-line rationale and whether it is (or should be) submitted upstream. Never edit the
  vendored tree directly: change or add a patch, then rebuild the tree.
- Crates are wired in with `[patch.crates-io]` in the workspace manifests (root `Cargo.toml`
  and `crates/key-desktop-host/Cargo.toml`), while dependents ask for the exact upstream
  version (`hayagriva = "=0.10.1"`). Dropping a fork is deleting its `[patch]` lines.
- `node tools/vendor-update.mjs update <name> --version X` fetches upstream X (Cargo's cache
  first, then crates.io), replaces the tree, re-applies the series (stops on any conflict),
  updates the pins and `upstream.json`, and runs the crate's tests (`cargo test -p key-cite`
  for hayagriva).
- `node tools/vendor-update.mjs verify <name>` fails when a tree has drifted from upstream +
  patches; `node tools/vendor-update.mjs check [--strict]` reports newer upstream releases
  (offline it warns and exits 0; `--strict` makes outdated or unchecked trees fail CI).
- Binaries (`vendor/pdfium`) record their build and checksums; `scripts/fetch-pdfium.sh`
  installs them.

Not yet converted: `pdfium-render-tile` (its tile patch is described in `TILE_PATCH.md`) and
`gpui-0.2.2-display-fix` (a backport of zed-industries/zed#38269) are still whole copies; their
upstream versions are recorded, and `check` reports newer releases.
