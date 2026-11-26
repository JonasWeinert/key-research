# Third-party notices

## PP-DocLayoutV3 ONNX model

`models/model_fp16.onnx` (not in the repository; downloaded on demand) is an ONNX export
of PaddlePaddle PP-DocLayoutV3, redistributed unmodified at
<https://huggingface.co/JonasWeinert/key-pp-doclayoutv3-onnx>.

- File SHA-256: `e549a04370b88c3f26fe8a975d7f15d76cb15876b54588270c977426793445ad`
- Original source of the export: <https://huggingface.co/datasets/embedpdf/embed-pdf-viewer/resolve/0833193a430ce271aa434cf1eecfab19412ac6a0/models/PP-DocLayoutV3-ONNX/model_fp16.onnx>
- Upstream model: <https://huggingface.co/PaddlePaddle/PP-DocLayoutV3>
- License: Apache License 2.0

## PDFium

The crate uses PDFium through `pdfium-render`. PDFium is not stored in this
crate; the build script downloads a pinned prebuilt binary from
`bblanchon/pdfium-binaries` unless the caller provides `PDFIUM_LIB_PATH` or
sets `PDFIUM_SKIP_DOWNLOAD=1`.

- Binary distribution: <https://github.com/bblanchon/pdfium-binaries>
- PDFium source: <https://pdfium.googlesource.com/pdfium/>
- License and notices: <https://pdfium.googlesource.com/pdfium/+/refs/heads/main/LICENSE>

The remaining Rust dependencies and their versions are recorded in
`Cargo.lock`; their own license terms apply.
