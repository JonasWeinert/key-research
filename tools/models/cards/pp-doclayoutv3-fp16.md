---
license: apache-2.0
library_name: onnx
pipeline_tag: object-detection
base_model:
- PaddlePaddle/PP-DocLayoutV3
tags:
- onnx
- document-layout
- layout-detection
- pdf
- key-app
---

# PP-DocLayoutV3 (ONNX, fp16) for Key

This repository holds the document-layout model used by the
Key research workspace to find headings, paragraphs,
columns, tables, figures and reading order when it analyses PDFs on the user's computer.
Key downloads this file once, the first time it analyses a PDF, from a pinned revision of
this repository, checks its SHA-256 and keeps it on the device.

## What it is

An ONNX (fp16) export of **PP-DocLayoutV3** by the PaddlePaddle team (Baidu).

- Original model: <https://huggingface.co/PaddlePaddle/PP-DocLayoutV3> (PaddleOCR / PaddlePaddle authors)
- ONNX export: taken unmodified from the `embedpdf/embed-pdf-viewer` dataset,
  `models/PP-DocLayoutV3-ONNX/model_fp16.onnx` at revision
  [`0833193a430ce271aa434cf1eecfab19412ac6a0`](https://huggingface.co/datasets/embedpdf/embed-pdf-viewer/blob/0833193a430ce271aa434cf1eecfab19412ac6a0/models/PP-DocLayoutV3-ONNX/model_fp16.onnx)
- Redistributed **unmodified** (byte-for-byte the file above) for the Key app. No weights were changed.

## Files

| File | Size (bytes) | SHA-256 |
| --- | ---: | --- |
| `model_fp16.onnx` | 65546435 | `e549a04370b88c3f26fe8a975d7f15d76cb15876b54588270c977426793445ad` |

## Licence

Apache License 2.0, as the original model. The licence text is in [`LICENSE`](LICENSE).
Copyright for the model belongs to its original authors (PaddlePaddle); see the original
model card for details and citation.

## Use outside Key

The file loads with ONNX Runtime. Key's own code that runs it is
`crates/opendataloader-pdf-rs` in the Key repository.
