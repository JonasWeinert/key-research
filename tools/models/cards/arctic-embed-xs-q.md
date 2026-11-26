---
license: apache-2.0
library_name: onnx
pipeline_tag: feature-extraction
base_model:
- Snowflake/snowflake-arctic-embed-xs
tags:
- onnx
- sentence-similarity
- embeddings
- quantized
- key-app
---

# Snowflake Arctic Embed XS (ONNX, quantised) for Key

The small text-embedding model the Key research
workspace uses to search an open PDF by meaning. Key downloads these files once, when it
first needs them, from a pinned revision of this repository, checks each SHA-256 and keeps
them on the device.

## What it is

The quantised ONNX build of **snowflake-arctic-embed-xs** by Snowflake, with its tokenizer
and configuration.

- Original model: <https://huggingface.co/Snowflake/snowflake-arctic-embed-xs> (Snowflake Inc.)
- Files taken unmodified from that repository at revision
  [`d8c86521100d3556476a063fc2342036d45c106f`](https://huggingface.co/Snowflake/snowflake-arctic-embed-xs/tree/d8c86521100d3556476a063fc2342036d45c106f)
  (`onnx/model_quantized.onnx` is Snowflake's own quantised export).
- Redistributed **unmodified** for the Key app (384 dimensions, CLS pooling, normalised).

## Files

| File | Size (bytes) | SHA-256 |
| --- | ---: | --- |
| `onnx/model_quantized.onnx` | 22972992 | `e6aa5e656466a73d7c3111e9a3378bd13e5b93af30eaac2b3f13fd56692589a1` |
| `tokenizer.json` | 711649 | `91f1def9b9391fdabe028cd3f3fcc4efd34e5d1f08c3bf2de513ebb5911a1854` |
| `config.json` | 737 | `d7d071046ab952af96b7abad788db7ab3fc997b465e1b9914ff39707092254ec` |
| `tokenizer_config.json` | 1433 | `9ca59277519f6e3692c8685e26b94d4afca2d5438deff66483db495e48735810` |
| `special_tokens_map.json` | 695 | `5d5b662e421ea9fac075174bb0688ee0d9431699900b90662acd44b2a350503a` |

## Licence

Apache License 2.0, as the original model. The licence text is in [`LICENSE`](LICENSE).
Copyright for the model belongs to Snowflake Inc.; see the original model card for the
paper and citation (arXiv:2405.05374, arXiv:2407.18887).
