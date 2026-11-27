# Smokes and scripts

The `smoke-*.cjs` scripts drive the real, built Electron app with Playwright. Build first
(`npm run build -w @key/electron` from `apps/key-office`) and point them at a host binary:

```sh
export KEY_HOST_EXECUTABLE=…/key-desktop-host
export KEY_MODEL_DIR=~/Library/Caches/Key/dev-models   # smokes that load the bundled models
```

## Running them

```sh
npm run smoke -w @key/electron                        # all of them
npm run smoke -w @key/electron -- tabs search menus   # some (names with or without smoke-)
node scripts/run-smokes.cjs --jobs 3 --repeat 5 tabs  # the runner itself
```

Options: `--jobs N` (default: from free cores, load and memory), `--repeat N`, `--retries N`
(default 0: a failure is a failure), `--timeout S` (default 300 s, or a `// smoke-timeout: S`
line at the top of a smoke), `--out DIR` (logs; default a fresh folder under the temp
directory), `--keep` (keep each run's temp folder), `--list`, `--visible` (test mode off).

Each run gets its own temp folder (`TMPDIR`, so every profile, workspace, screenshot and the
host's files land there), its own environment and a timeout. At the end the runner prints one
line per smoke: pass, flaky (passed on a retry or in some repeats) or fail, with the failing
assertion's line and the paths of its log and kept files. It exits non-zero when one failed.
On a timeout, or when a smoke exits, the app's whole process tree is killed; nothing is left
running.

## Test mode

Every script starts Key through `lib/launch.cjs`, which turns on the app's test mode
(`KEY_TEST_MODE=1`, `src/main/test-mode.ts`):

- windows are never on screen and never take focus; the app is not in the Dock or Cmd-Tab.
  Visibility and focus are virtual (`show`, `focus`, `isFocused`, `getFocusedWindow`, full
  screen …), with the same events, so the app behaves as with a front-most window. Pages run
  unthrottled, screenshots and `capturePage` work as before;
- the clipboard is per run, in memory, for main (`clipboard`) and pages (copy, cut, paste,
  `navigator.clipboard`);
- native context menus, global shortcuts, file drags and `shell.open*` are recorded in
  `globalThis.__keyTest` (`menus[i].pick(label)` runs an item) instead of happening; message
  boxes and open/save panels answer themselves (`app-notices.ts`);
- the app losing the foreground only happens when a test says so:
  `app.evaluate(() => globalThis.__keyTest.resignActive())`;
- Zotero folders, browser profiles to import from and the workspace parent default to empty
  folders in the run's temp folder; Chromium keeps nothing in the login Keychain;
- Chromium resolves loopback only (`--host-resolver-rules` from the smoke are kept); hosts a
  run tried to reach are printed when the app closes. `network: "allow"` in the launch options
  (or `KEY_TEST_NETWORK=allow`) lets a smoke reach the network; `KEY_TEST_NETWORK=strict` fails
  a smoke that tried.

Input in smokes is Playwright's (devtools protocol): it never needs OS focus and never comes
from the real keyboard or mouse. Use `locator.click()`/`page.keyboard`, never OS-level input;
for keys a page must see as native (Ctrl-Tab) use `webContents.sendInputEvent`.

`KEY_TEST_MODE=0` (or `--visible`) runs the app on screen, as before, to watch a smoke.
