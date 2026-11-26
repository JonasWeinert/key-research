# CLAUDE.md

Guidance for AI agents and human contributors working on Key's Electron app
(`apps/key`, `@key/electron`) and its packages in this npm workspace.

## Theming rules (mandatory)

Key supports light, dark and system themes. Colors are CSS custom properties
defined once in `apps/key/src/renderer/native.css`: the `--kx-*` tokens, with
light values in `:root`, dark values in `:root[data-theme="dark"]` and the same
dark values under `@media (prefers-color-scheme: dark)` for system mode.
`chrome-tokens.css` aliases a few short names (`--surface`, `--text`,
`--danger`, …) to them for older stylesheets; `packages/design-system` maps its
`--key-ui-*` variables onto them.

1. **UI colors use tokens.** Never write raw `#hex`, `rgb()`, `hsl()` or
   `oklch()` values in renderer CSS rules or inline styles: use `var(--kx-…)`.
   Raw values are allowed only on lines that define a custom property
   (`--x: #…;`). `npm run check:theme-colors` checks changed renderer CSS.
2. **A new token gets every value.** Add it to all three blocks in
   `native.css` (light, dark, system dark).
3. **Document content is never re-themed.** PDF pages, note and canvas
   content colors chosen by the user, highlight colors, exports and printed
   output are document data: they keep their real colors in both themes.
4. **Canvas-drawn UI reads its colors from the theme** (computed token
   values), never from inline hex in draw calls.

## Build gotchas

- Main-process and preload code is bundled by electron-vite: after changing it,
  run `npm run build -w @key/electron` again, or the app runs the old code. A
  stale preload leaves the renderer blank.
- The app's main and preload bundles include their dependencies
  (`externalizeDeps: false`) and the package ships no `node_modules`, so a new
  runtime dependency must be importable by the bundler; native modules are
  not supported.
- `npm run notices` regenerates `apps/key/build/THIRD-PARTY-NOTICES.txt` from
  what the sources import; packaging (`dist:mac`) runs it.

## Not here

Key has no bundled Word, Excel or PowerPoint editors. Such files in a
workspace are listed and linked, preview with Quick Look and open in their
default app. Document editing will be reimplemented separately.
