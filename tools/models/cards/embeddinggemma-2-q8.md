---
license: apache-2.0
library_name: gguf
pipeline_tag: feature-extraction
base_model:
- google/embeddinggemma-2
tags:
- gguf
- embeddings
- quantized
- llama.cpp
- key-app
---

# EmbeddingGemma 2 (GGUF, Q8_0) for Key

The search model of the Key research workspace: it turns
passages of the user's library into vectors so search finds them by meaning. Key runs it
on the device with llama.cpp's `llama-server` (Metal, CUDA, Vulkan or CPU). Key downloads
this file once, when search first needs it, from a pinned revision of this repository,
checks its SHA-256 and keeps it on the device.

## What it is

The Q8_0 GGUF conversion of **EmbeddingGemma 2** by Google.

- Original model: <https://huggingface.co/google/embeddinggemma-2> (Google)
- GGUF conversion: taken unmodified from
  [`ggml-org/embeddinggemma-2-GGUF`](https://huggingface.co/ggml-org/embeddinggemma-2-GGUF/blob/6ea3e3a309d12a4779cfda98b8c19800d2d5da71/embeddinggemma-2-Q8_0.gguf)
  at revision `6ea3e3a309d12a4779cfda98b8c19800d2d5da71` (converted by the ggml-org project
  with https://github.com/ggml-org/convert).
- Redistributed **unmodified** for the Key app (768 dimensions, mean pooling).

## Files

| File | Size (bytes) | SHA-256 |
| --- | ---: | --- |
| `embeddinggemma-2-Q8_0.gguf` | 309855456 | `2188ac1deca4b77dffefd603c2776a9d76d9d74ec01841392982ebb840b09135` |

## Licence

Apache License 2.0, as the original model and the GGUF conversion. The licence text is in
[`LICENSE`](LICENSE). Copyright for the model belongs to Google; see the original model
card for details and citation.
