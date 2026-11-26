# Key workspace (npm)

The npm workspace Key's desktop app builds in. It holds:

| Path | What it is |
|---|---|
| `apps/key` (`@key/electron`) | The Key app: Electron main process, preload, React interface and smokes. See its [README](apps/key/README.md). |
| `packages/design-system` (`@key/design-system`) | Key's controls and `--key-ui-*` variables, adapted from beUI (MIT). |
| `tools/` | `gen-third-party-notices.mjs` (the app's acknowledgements) and `check-theme-colors.mjs`. |

The PDF reader the app hosts lives in `../key/src` and is aliased as `@key-reader`.

```sh
npm install
npm run build        # the Key app
npm run start        # build and launch
npm test
npm run typecheck
npm run dist:mac     # unsigned Key.app in apps/key/release/mac-arm64
```

Rules for theming and builds are in [CLAUDE.md](CLAUDE.md). Licences: see `LICENSES.md` at the
repository root.
