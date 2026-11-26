# Key's on-device models

Key ships no model weights. The host (`crates/key-models`) downloads each model on first
need from a pinned revision of its Hugging Face repository, checks every file's SHA-256 and
keeps it once per machine in `~/Library/Application Support/Key/models/<id>/<revision>/`.
`crates/key-models/manifest.json` is the list: repository, revision, files, sizes, hashes.

| Model | Repository | Files |
| --- | --- | --- |
| `embeddinggemma-2-q8`: search | `JonasWeinert/key-embeddinggemma-2-gguf` | `embeddinggemma-2-Q8_0.gguf` (310 MB) |
| `pp-doclayoutv3-fp16`: PDF layout | `JonasWeinert/key-pp-doclayoutv3-onnx` | `model_fp16.onnx` (66 MB) |
| `arctic-embed-xs-q`: reader search | `JonasWeinert/key-arctic-embed-xs-q` | `onnx/model_quantized.onnx`, `tokenizer.json`, `config.json`, `tokenizer_config.json`, `special_tokens_map.json` (24 MB) |

Each repository holds `README.md` (the card in `cards/<id>.md`), `LICENSE` (Apache-2.0) and
the files at the paths above. Until a manifest revision is a commit id, `main` is used and
the hashes still pin the bytes; when the Key repository cannot be reached, a file is taken
from its original source (`upstream` in the manifest), which must match the same hash.

## Development and smokes

```
node tools/models/fetch.mjs                  # all models into ~/Library/Caches/Key/dev-models
node tools/models/fetch.mjs --from <folder>  # take files already on disk when their hash matches
export KEY_MODEL_DIR=~/Library/Caches/Key/dev-models
```

Smokes run with `KEY_SKIP_ONBOARDING=1` and never download unless they set
`KEY_MODELS_AUTO_DOWNLOAD=1`. Smokes that need a model copy it from the dev cache
(`models.cjs`'s `copyReady`) or serve it from a local mock of the Hub (`mockHub`, set as
`KEY_MODELS_BASE_URL`); `scripts/smoke-models.cjs` covers download, progress and removal.

Overrides: `KEY_MODEL_DIR` (models folder), `KEY_MODELS_BASE_URL` (a mirror in place of
https://huggingface.co, for proxies and tests), `KEY_MODELS_AUTO_DOWNLOAD=0|1`,
`KEY_LAYOUT_MODEL` (a layout model file), `KEY_SEMANTIC_MODEL_DIR` (a reader model folder).

## Publishing (the repository owner)

```
hf auth login
node tools/models/fetch.mjs
node tools/models/publish.mjs --dry-run   # stages each repository and prints the commands
node tools/models/publish.mjs             # creates the public repos, uploads, pins revisions
git commit -m "Pin the models to their Hugging Face revisions" crates/key-models/manifest.json
```

`publish.mjs` runs, per model, `hf repos create JonasWeinert/<name> --type model --public
--exist-ok` and `hf upload JonasWeinert/<name> <staged folder> .`, then writes the new
commit id into the manifest. A new model version: add its files to the manifest (new hashes),
publish, and the app fetches the new revision into its own folder; remove the old one in
Settings.
