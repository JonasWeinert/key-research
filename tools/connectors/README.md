# Connector tools

Scripts for the database search connectors in `connectors/` (format: `connectors/SPEC.md`).
Each script runs the `key-connectors` binary from `crates/key-connectors` (built on first use;
set `KEY_CONNECTORS_BIN` to reuse a build).

| script | what it does |
| --- | --- |
| `validate [files]` | checks every spec (or the given files) against the JSON Schema and the engine |
| `test` | runs every spec's embedded tests on the recorded fixtures (`connectors/fixtures`) |
| `test --live [--id pubmed] [--report out.json]` | the same against the real services |
| `test --record --id pubmed` | live, and saves the answers as the new fixtures |
| `translate <id> query.json` | prints the native query string and warnings for a neutral query |
| `bundle --out dist --sequence N` | writes `index.json` and `specs/` (unsigned) |
| `sign --dir dist` | signs `dist/index.json` with `KEY_CONNECTORS_SIGNING_KEY` (or `--key FILE`) and copies `connectors/keys.json` |
| `verify --dir dist [--dev]` | verifies a bundle the way the app does |
| `keygen --out FILE` | makes a new Ed25519 key file (secret) and `FILE.pub.json` (public) |
| `certify --root ROOT --key KEY.pub.json --not-after T` | the root key certifies a signing key in `connectors/keys.json` |

Live tests read keys from the environment: `KEY_CONNECTOR_<SECRET>`, where `<SECRET>` is the
credential's `secret` in upper case with `-` as `_` (for example `KEY_CONNECTOR_ELSEVIER`,
`KEY_CONNECTOR_CLARIVATE_WOS`, `KEY_CONNECTOR_NCBI`). `KEY_CONNECTORS_MAILTO` sets the contact
address that polite APIs ask for.

## Signing: what the owner sets up once

The app trusts only the root public keys in `connectors/trust.json`, which are compiled in.
Until a root is added, the app uses the connectors built into it and "Check for updates" says
updates are not set up. Nothing unsigned is ever activated.

1. Make a root key and a signing key on a trusted machine, outside the repository:
   ```
   tools/connectors/keygen --out ~/key-connectors-root.json --note "Key connectors root"
   tools/connectors/keygen --out ~/key-connectors-signing-2026.json --note "Key connectors signing 2026"
   ```
   Keep the root key offline (a password manager or an encrypted USB stick). It is only needed
   to certify a new signing key.
2. Certify the signing key for a period (this writes the public certificate into
   `connectors/keys.json`, which is committed):
   ```
   tools/connectors/certify --root ~/key-connectors-root.json --key ~/key-connectors-signing-2026.pub.json --not-after 2028-01-01T00:00:00Z
   ```
3. Add the root's public key (from `~/key-connectors-root.pub.json`) to `connectors/trust.json`:
   ```json
   { "roots": [ { "keyId": "…", "publicKey": "…", "note": "Key connectors root" } ],
     "revoked": [], "updateUrl": "https://raw.githubusercontent.com/JonasWeinert/key-research/connectors-dist" }
   ```
   and commit `trust.json` and `keys.json`. Apps built from then on accept bundles signed by
   any key this root certified.
4. In the GitHub repository settings, add the secret `CONNECTORS_SIGNING_KEY` with the whole
   content of `~/key-connectors-signing-2026.json`. The publish workflow signs with it; it is
   never printed or committed.
5. Optional: secrets for live tests of keyed services (`KEY_CONNECTOR_ELSEVIER`,
   `KEY_CONNECTOR_CLARIVATE_WOS`, `KEY_CONNECTOR_NCBI`, …) and `KEY_CONNECTORS_MAILTO`.

Key rotation: make a new signing key, certify it (step 2), commit `keys.json`, replace the
secret. Old apps keep working because they trust the root, not the signing key. If a signing key
leaks, put its `keyId` into `revoked` in `trust.json` (this takes effect in the next app
release) and certify a new one. Keep certificate periods short (a year or two), so a leaked key
also stops working on its own.

## Development keys

`dev-bundle` signs with a development key derived from a fixed public text
(`bundle::dev_root`). It is not a secret and is trusted only when `KEY_CONNECTORS_DEV_TRUST=1`
is set (tests and smokes). Never set that variable for a real app.
