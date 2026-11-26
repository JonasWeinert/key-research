/**
 * Aggregates licenses of third-party components shipped with the installer
 * into apps/key/build/THIRD-PARTY-NOTICES.txt.
 *
 * The shipped set is derived from what the source actually imports, then closed
 * over the dependency graph — not from `dependencies` vs `devDependencies`,
 * which in this repo says nothing about what ships: electron-vite bundles the
 * renderer/main graph into out/ and no node_modules directory is packaged, so
 * several genuinely-bundled libraries are declared as devDependencies.
 *
 * The Chromium part is too large (18MB); electron-builder extraResources ships
 * LICENSES.chromium.html separately, referenced from the body text.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { builtinModules, createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUILTIN = new Set(builtinModules)

/**
 * Source trees whose imports end up in a shipped bundle. Deliberately only
 * `src/` — vite configs and scripts pull in the whole build toolchain, which
 * is not distributed.
 */
const SRC_GLOBS = [
  'apps/docs/src',
  'apps/html/src',
  'apps/markdown/src',
  'apps/sheets/src',
  'apps/key/src',
  'apps/slides/src',
  '../key/src',
  ...readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `packages/${e.name}/src`),
]
// CSS @imports include bundled font packages, whose OFL notices must ship too.
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|css)$/
const SKIP_DIR = /^(node_modules|out|dist|release|tests|__tests__|target)$/

/** Runtime that is always present but never imported by specifier */
const IMPLICIT = ['electron']

/**
 * Packages copied into the installer verbatim by electron-builder rather than
 * bundled are never imported, so they are invisible to the import scan.
 */
function extraResourceSeeds() {
  // the electron-builder config lives in its own cjs module (not package.json
  // "build") so the publish URL can be injected from the environment
  const build = require(join(ROOT, 'apps/key/package.json')).build
  const entries = [build.extraResources, build.mac?.extraResources, build.win?.extraResources]
  const names = []
  for (const e of entries.flat()) {
    const m = e?.from && /node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(e.from)
    if (m) names.push(m[1])
  }
  return names
}

/** license file lives somewhere non-obvious */
const LICENSE_PATH = { electron: 'dist/LICENSE' }

/** license text is not published to npm; supply the notice by hand */
const NOTE = {
  '@fluentui/react-icons':
    'Copyright (c) Microsoft Corporation. Licensed under the MIT License.\nhttps://github.com/microsoft/fluentui-system-icons',
}

/** SPDX strings that need a word on which side of a dual license we take */
const SPDX_NOTE = {
  jszip: 'MIT (dual MIT/GPL-3.0-or-later, used under MIT)',
  'r-efi': 'MIT (tri-licensed MIT/Apache-2.0/LGPL-2.1-or-later, used under MIT)',
}

const walk = (dir, out = []) => {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIR.test(e.name)) walk(join(dir, e.name), out)
    } else if (CODE_EXT.test(e.name)) out.push(join(dir, e.name))
  }
  return out
}

// the lookbehind keeps Array.from('x') / obj.import out of the results
const SPECIFIER = /(?<![.\w])(?:from|import|require)\s*\(?\s*['"]([^'"\n]+)['"]/g

const IN_NODE_MODULES = /node_modules\/((?:@[^/]+\/)?[^/?]+)/

/** 'foo/bar' -> 'foo'; '@a/b/c' -> '@a/b'; relative/builtin/workspace -> null */
function bareName(spec) {
  if (!spec || spec.startsWith('node:')) return null
  // a few deep imports reach into node_modules by relative path (harfbuzzjs wasm)
  const viaPath = IN_NODE_MODULES.exec(spec)
  if (viaPath) return viaPath[1]
  if (spec.startsWith('.') || spec.startsWith('/')) return null
  const parts = spec.split('/')
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  if (BUILTIN.has(name) || (name.startsWith('@key/') || name.startsWith('@key-reader/'))) return null
  // the specifier regex also fires on prose inside string concatenations
  return NPM_NAME.test(name) ? name : null
}

const NPM_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

function importedNames() {
  const names = new Set([...IMPLICIT, ...extraResourceSeeds()])
  for (const g of SRC_GLOBS) {
    for (const file of walk(join(ROOT, g))) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(SPECIFIER)) {
        const n = bareName(m[1])
        if (n) names.add(n)
      }
    }
  }
  return names
}

const WORKSPACE_MODULES = SRC_GLOBS.map((g) => join(ROOT, g.replace(/\/src$/, ''), 'node_modules'))

/** installed package names, unscoped first so existing resolutions keep winning */
function topLevelPackages() {
  const dirs = (at) => readdirSync(at, { withFileTypes: true }).filter((e) => e.isDirectory())
  const top = dirs(join(ROOT, 'node_modules')).map((e) => e.name)
  const scoped = top.filter((n) => n.startsWith('@'))
  return [
    ...top.filter((n) => !n.startsWith('@')),
    ...scoped.flatMap((s) => dirs(join(ROOT, 'node_modules', s)).map((e) => `${s}/${e.name}`)),
  ]
}

/** npm hoists, so the root copy is the usual answer; fall back to a nested one */
function pkgDir(name) {
  const root = join(ROOT, 'node_modules', name)
  if (existsSync(join(root, 'package.json'))) return root
  for (const owner of topLevelPackages()) {
    const nested = join(ROOT, 'node_modules', owner, 'node_modules', name)
    if (existsSync(join(nested, 'package.json'))) return nested
  }
  for (const modules of WORKSPACE_MODULES) {
    const own = join(modules, name)
    if (existsSync(join(own, 'package.json'))) return own
  }
  return null
}

const manifest = (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))

/** transitive closure over runtime deps (build-only devDependencies of a dep never ship) */
function closure(seed) {
  const seen = new Map()
  const queue = [...seed].map((name) => ({ name, optional: false }))
  const missing = new Set()
  while (queue.length > 0) {
    const { name, optional } = queue.shift()
    if (seen.has(name)) continue
    const dir = pkgDir(name)
    if (dir === null) {
      // an uninstalled optional dep is a platform variant for another host, not a gap
      if (!optional) missing.add(name)
      seen.set(name, null)
      continue
    }
    const pkg = manifest(dir)
    seen.set(name, { dir, pkg })
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      if (!seen.has(dep)) queue.push({ name: dep, optional: false })
    }
    for (const dep of Object.keys(pkg.optionalDependencies ?? {})) {
      if (!seen.has(dep)) queue.push({ name: dep, optional: true })
    }
  }
  return { resolved: [...seen].filter(([, v]) => v !== null), missing }
}

const LICENSE_FILE = /^(LICENSE|LICENCE|COPYING)([._-]|$)/i

/** platform binary packages that publish no licence file of their own: their parent's applies */
const LICENSE_FROM = {
  '@esbuild/darwin-arm64': 'esbuild',
  '@rollup/rollup-darwin-arm64': 'rollup',
  '@napi-rs/canvas-darwin-arm64': '@napi-rs/canvas',
}

const SKIA_NOTE =
  'The native module embeds Skia (https://skia.org), Copyright (c) 2011 Google Inc.,\n' +
  'BSD-3-Clause: https://skia.googlesource.com/skia/+/main/LICENSE'

/**
 * For packages that declare a permissive SPDX identifier but publish no licence file,
 * reproduce the standard text of that licence with the package's declared author.
 */
function standardText(spdx, pkg) {
  const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name
  const holder = (author ?? `the ${pkg.name} authors`).replace(/\s*<[^>]*>/, '').replace(/\s*\([^)]*\)/, '')
  const intro = `[${pkg.name} publishes no licence file; below is the standard ${spdx} text with the copyright holder its package.json names.]\n\n`
  if (spdx === 'MIT') {
    const body = readFileSync(join(REPO, 'LICENSE'), 'utf8').trim().replace(/^Copyright .*$/m, `Copyright (c) ${holder}`)
    return intro + body
  }
  if (spdx === 'ISC') {
    return intro + `ISC License\n\nCopyright (c) ${holder}\n\nPermission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.`
  }
  if (spdx === 'BSD-2-Clause') {
    return intro + `BSD 2-Clause License\n\nCopyright (c) ${holder}\n\nRedistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`
  }
  if (spdx === 'Apache-2.0') {
    return intro.replace('below is the standard Apache-2.0 text with the copyright holder its package.json names', `licensed under Apache-2.0 by ${holder.replace(/\.$/, '')}`) +
      readFileSync(join(ROOT, 'LICENSE'), 'utf8').trim()
  }
  return null
}

function licenseText(name, dir) {
  const override = LICENSE_PATH[name]
  if (override && existsSync(join(dir, override))) {
    return readFileSync(join(dir, override), 'utf8').trim()
  }
  const files = readdirSync(dir).filter((f) => LICENSE_FILE.test(f))
  files.sort((a, b) => a.length - b.length)
  if (files.length > 0) return readFileSync(join(dir, files[0]), 'utf8').trim()
  return null
}

function noticeText(dir) {
  for (const f of ['NOTICE', 'NOTICE.txt', 'NOTICE.md']) {
    if (existsSync(join(dir, f))) return readFileSync(join(dir, f), 'utf8').trim()
  }
  return null
}

function spdxOf(name, pkg) {
  if (SPDX_NOTE[name]) return SPDX_NOTE[name]
  const raw = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type
  if (raw) return raw
  // some packages ship the file but omit the field (e.g. @univerjs/telemetry)
  return 'see license text below'
}

function repoOf(pkg) {
  const r = pkg.repository
  const url = typeof r === 'string' ? r : r?.url
  return url ? url.replace(/^git\+/, '').replace(/\.git$/, '') : null
}

/** Repository root (Key's own MIT code, vendored trees, models, CSL data). */
const REPO = join(ROOT, '../..')

/**
 * Key's own crates (MIT, covered by Key's licence in section 0). Vendored third-party
 * path crates (hayagriva, pdfium-render, gpui, opendataloader-pdf) are not listed here
 * and stay in the crate list with their own terms.
 */
const firstPartyCrate = (p) => p.source == null && (p.name.startsWith('key-') || p.name === 'key')

/** Rust crates linked into both Key native services. */
function rustCrates() {
  const targets = [join(ROOT, 'apps/sheets/native/xlsx-engine/Cargo.toml'), join(REPO, 'crates/key-desktop-host/Cargo.toml')]
  try {
    const packages = targets.flatMap(target => JSON.parse(execFileSync(
      'cargo',
      ['metadata', '--format-version', '1', '--manifest-path', target],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    )).packages)
    return [...new Map(packages.map(p => [p.name + '@' + p.version, p])).values()]
      .filter((p) => p.name !== 'xlsx-sidecar' && !firstPartyCrate(p))
      .map((p) => ({
        name: p.name,
        version: p.version,
        spdx: SPDX_NOTE[p.name] ?? p.license ?? 'see repository',
        url: p.repository ?? `https://crates.io/crates/${p.name}`,
        dir: p.manifest_path ? dirname(p.manifest_path) : null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return null
  }
}

const hr = (title) => `\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}\n`
const sub = (title) => `\n${'-'.repeat(72)}\n${title}\n${'-'.repeat(72)}\n`

const seed = importedNames()
const { resolved, missing } = closure(seed)
resolved.sort(([a], [b]) => a.localeCompare(b))

let out = `Key — Third-Party Software Notices

This application includes third-party software components under the licenses
reproduced below. Key's own code is MIT licensed (section 0). Third-party
components keep their own licences; combining them with Key does not relicense
them. LICENSES.md in Key's source repository maps every component to its licence.

Chromium (bundled via Electron) is licensed under BSD-style and other
licenses — see LICENSES.chromium.html next to this file.
`

const readRepo = (path) => readFileSync(join(REPO, path), 'utf8').trim()

out += hr('0. Key and the GenOffice editors')
out += sub('Key — MIT') + readRepo('LICENSE') + '\n'
out += sub('GenOffice (Docs, Sheets, Slides, Markdown and HTML editors and shared packages) — Apache-2.0')
out += `Key's Office editors and their packages are derived from GenOffice
(https://github.com/genspark-ai/genoffice, commit de139a061537bea40f0cc81ef8f09a95f77ac52a)
and remain under the Apache License 2.0. Key modified them (product branding,
shell integration, theming, fixes); see UPSTREAM.md in the source. Key's tab
strip (TabBar.tsx, tabbar.css) also derives from GenOffice's shell and stays
Apache-2.0. The licence text ships as licenses/GENOFFICE-LICENSE.

NOTICE:
${readFileSync(join(ROOT, 'NOTICE'), 'utf8').trim()}
`

out += hr(`1. npm packages (${resolved.length})`)
const noText = []
for (const [name, { dir, pkg }] of resolved) {
  out += sub(`${name} v${pkg.version} — ${spdxOf(name, pkg)}`)
  const parent = LICENSE_FROM[name] && pkgDir(LICENSE_FROM[name])
  let text = licenseText(name, dir) ?? NOTE[name] ?? (parent ? licenseText(LICENSE_FROM[name], parent) : null)
  text ??= standardText(spdxOf(name, pkg), pkg)
  if (text && name.startsWith('@napi-rs/canvas')) text += '\n\n' + SKIA_NOTE
  if (text) {
    out += text + '\n'
  } else {
    noText.push(name)
    const repo = repoOf(pkg)
    out += `Licensed under ${spdxOf(name, pkg)}.${repo ? `\n${repo}` : ''}\n`
  }
  const notice = noticeText(dir)
  if (notice) out += `\nNOTICE:\n${notice}\n`
}

const crates = rustCrates()
out += hr(`2. Rust crates (Key PDF/search host and spreadsheet worker)`)
if (crates === null) {
  out += '\ncargo metadata unavailable at generation time; see'
  out += ' apps/sheets/native/xlsx-engine/Cargo.lock for the full crate list.\n'
} else {
  out += `\n${crates.length} crates, all under permissive terms:\n\n`
  for (const c of crates) out += `  ${c.name} ${c.version}  —  ${c.spdx}\n    ${c.url}\n`
  const texts = new Map()
  for (const c of crates) {
    if (!c.dir) continue
    const text = licenseText(c.name, c.dir)
    if (text && !texts.has(text)) texts.set(text, c.name)
  }
  out += sub('Crate license texts (deduplicated)')
  for (const [text, first] of texts) out += `\n[first seen in ${first}]\n${text}\n`
  // Apache-2.0 section 4(d): NOTICE files of the crates travel with the binary
  const notices = crates.filter((c) => c.dir && noticeText(c.dir))
  if (notices.length > 0) {
    out += sub('Crate NOTICE files')
    for (const c of notices) out += `\n[${c.name} ${c.version}]\n${noticeText(c.dir)}\n`
  }
}

const GOTHIC_KR_COPYRIGHT = [
  'Copyright (c) 2010, NHN Corporation (http://www.nhncorp.com),',
  'with Reserved Font Name Nanum, Naver Nanum, NanumGothic, Naver ',
  'NanumGothic, NanumMyeongjo, Naver NanumMyeongjo, NanumBrush, Naver',
  'NanumBrush, NanumPen, Naver NanumPen.',
].join('\n')

/**
 * Bundled web/document fonts. KaTeX code remains separately covered by its
 * npm-package MIT notice above; its webfonts carry OFL terms.
 */
const FONTS = [
  [
    'Liberation Sans / Serif / Mono 2.1.5',
    'SIL OFL 1.1',
    'Digitized data © 2010 Google Corporation with Reserved Font Names Arimo, Tinos and Cousine.\n© 2012 Red Hat, Inc. with Reserved Font Name Liberation.',
  ],
  [
    'Carlito',
    'SIL OFL 1.1',
    '© 2010-2013 tyPoland Lukasz Dziedzic with Reserved Font Name "Carlito".',
  ],
  [
    'Caladea',
    'Apache-2.0',
    '© Huerta Tipográfica. Licensed under the Apache License, Version 2.0.',
  ],
  [
    'Noto Sans CJK SC / Noto Serif CJK SC (subset)',
    'SIL OFL 1.1',
    '© Adobe / Google. This bundle ships a subset of the original fonts (reduced glyph coverage for size);\nno other modifications were made.',
  ],
  [
    'Key Sans KR (Noto Sans CJK KR derivative)',
    'SIL OFL 1.1',
    'Copyright 2014-2021 Adobe (http://www.adobe.com/), Google LLC, Reserved Font Name "Source".\nSubset with modified advance widths and horizontally transformed Noto CJK outlines to match measured\nKorean Office-family metrics; renamed per OFL 1.1. No Microsoft font outlines are included.',
  ],
  [
    'Key Serif KR (Noto Serif CJK KR derivative)',
    'SIL OFL 1.1',
    'Copyright 2017-2024 Adobe (http://www.adobe.com/), Reserved Font Name "Source".\nSubset with modified advance widths and horizontally transformed Noto CJK outlines to match measured\nKorean Office-family metrics; renamed per OFL 1.1. No Microsoft font outlines are included.',
  ],
  [
    'Key Che Latin KR (Noto Sans CJK KR derivative)',
    'SIL OFL 1.1',
    'Copyright 2014-2021 Adobe (http://www.adobe.com/), Google LLC, Reserved Font Name "Source".\nASCII subset with fixed 0.5em advances and horizontally transformed Noto CJK outlines; Microsoft\nDotumChe is used only as a metric reference. Renamed per OFL 1.1. No Microsoft outlines are included.',
  ],
  [
    'Noto Naskh Arabic / Noto Sans Arabic (subset)',
    'SIL OFL 1.1',
    '© The Noto Project Authors. This bundle ships a subset of the original fonts;\nglyphs and metrics are unmodified.',
  ],
  [
    'Key Gothic KR (NanumGothic derivative)',
    'SIL OFL 1.1',
    `${GOTHIC_KR_COPYRIGHT}\nSubset with unmodified metrics; renamed per OFL 1.1.`,
  ],
  [
    'Key Poppins (Poppins derivative)',
    'SIL OFL 1.1',
    'Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins).\nLatin subset with unmodified metrics and advances; renamed.',
  ],
  [
    'Key Tamil (Noto Sans Tamil derivative)',
    'SIL OFL 1.1',
    '© The Noto Project Authors, original Reserved Font Name "Noto". Modified advance widths;\nrenamed per OFL 1.1.',
  ],
  [
    'Key UI Kana JP (Noto Sans JP derivative)',
    'SIL OFL 1.1',
    'Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name "Source".\nSubset to kana/JP punctuation, instanced at wght 400/700 with modified advances and horizontally\ncondensed outlines; renamed per OFL 1.1.',
  ],
  [
    'Key PUA Blank',
    'Apache-2.0 (part of GenOffice)',
    'Generated from scratch by GenOffice (two empty glyphs, no upstream font outlines).',
  ],
  [
    'KaTeX webfonts',
    'SIL OFL 1.1',
    'Copyright (c) 2009-2010, Design Science, Inc. (<www.mathjax.org>)\n' +
      'Copyright (c) 2014-2018 Khan Academy (<www.khanacademy.org>),\n' +
      'with Reserved Font Names KaTeX_AMS, KaTeX_Caligraphic, KaTeX_Fraktur, ' +
      'KaTeX_Main, KaTeX_Math, KaTeX_SansSerif, KaTeX_Script, KaTeX_Size1, ' +
      'KaTeX_Size2, KaTeX_Size3, KaTeX_Size4, and KaTeX_Typewriter.',
  ],
]

out += hr('3. Bundled fonts')
for (const [name, spdx, copyright] of FONTS) out += sub(`${name} — ${spdx}`) + copyright + '\n'
out += sub('SIL Open Font License 1.1 — full text')
out +=
  readFileSync(join(ROOT, 'apps/docs/src/renderer/fonts/LICENSE-OFL.txt'), 'utf8').trim() + '\n'

out += hr('4. Unicode Character Database data')
out += `
Retained from GenOffice's NOTICE. In GenOffice, apps/pdf/src/shared/radicals.ts
(not part of Key) contains a generated mapping derived from
Unicode Character Database 17.0.0, EquivalentUnifiedIdeograph.txt
(2025-08-01):
https://www.unicode.org/Public/17.0.0/ucd/EquivalentUnifiedIdeograph.txt

`
out += readFileSync(join(ROOT, 'LICENSE-UNICODE.txt'), 'utf8').trim() + '\n'

out += hr('5. Third-party source code adapted inside Key and GenOffice')
out += sub('beUI (motion drawer, table, design-system primitives; adapted by Key) — MIT') + 'https://beui.dev\n' +
  readFileSync(join(ROOT, 'apps/key/src/renderer/motion/BEUI-LICENSE.txt'), 'utf8').trim() + '\n'
out += sub('libeot MicroType Express decoder (TypeScript port in GenOffice pptx-engine) — MPL-2.0')
out += `https://github.com/umanwizard/libeot
The ported files (packages/pptx-engine/src/vendor/mtx/*.ts) remain under the
Mozilla Public License 2.0; their source form is available in Key's source
repository at that path.

${readFileSync(join(ROOT, 'packages/pptx-engine/src/vendor/mtx/LICENSE'), 'utf8').trim()}
`
out += sub('emf-converter 2.0.2 (modified copy in GenOffice docx-engine) — Apache-2.0')
out += `https://github.com/ChristopherVR/emf-converter
Modified (WMF font, escapement, alignment and symbol-font fixes); the changes are
listed in packages/docx-engine/src/vendor/emf-converter/README.md. The Apache
License 2.0 text is reproduced in section 0 (licenses/GENOFFICE-LICENSE).
`

out += hr('6. Native binaries')
out += sub('PDFium (Chromium build 7763, via bblanchon/pdfium-binaries)')
out += readRepo('vendor/pdfium/LICENSE') + '\n'
const pdfiumLicenses = join(REPO, 'vendor/pdfium/licenses')
for (const f of readdirSync(pdfiumLicenses).sort()) {
  out += `\n--- PDFium bundled component: ${f}\n` + readFileSync(join(pdfiumLicenses, f), 'utf8').trim() + '\n'
}
out += sub('llama.cpp server (ggml-org/llama.cpp release build) — MIT')
const llamaLicense = ['release', 'debug']
  .map((p) => join(REPO, 'apps/key/src-tauri/target', p, 'llama/LICENSE'))
  .find((p) => existsSync(p))
out += 'https://github.com/ggml-org/llama.cpp\n'
out += llamaLicense
  ? readFileSync(llamaLicense, 'utf8').trim() + '\n'
  : 'MIT License, Copyright (c) 2023-2026 The ggml authors (fetch the release to include its LICENSE).\n'

out += sub('ONNX Runtime (statically linked into the Key host by the ort crate) — MIT')
out += `https://github.com/microsoft/onnxruntime
ONNX Runtime's own third-party notices:
https://github.com/microsoft/onnxruntime/blob/main/ThirdPartyNotices.txt

${readRepo('LICENSE').replace(/^Copyright .*$/m, 'Copyright (c) Microsoft Corporation')}
`

out += hr('7. Machine-learning models')
const MODELS = [
  [
    'PP-DocLayoutV3 layout model (ONNX fp16 export) — Apache-2.0',
    'models/layout/model_fp16.onnx. Upstream: https://huggingface.co/PaddlePaddle/PP-DocLayoutV3\n' +
      'ONNX export obtained from https://huggingface.co/datasets/embedpdf/embed-pdf-viewer\n' +
      '(SHA-256 e549a04370b88c3f26fe8a975d7f15d76cb15876b54588270c977426793445ad).',
  ],
  [
    'Snowflake Arctic Embed XS (quantized ONNX) — Apache-2.0',
    'models/snowflake-arctic-embed-xs-q. Upstream: https://huggingface.co/Snowflake/snowflake-arctic-embed-xs\n' +
      'revision d8c86521100d3556476a063fc2342036d45c106f. Copyright Snowflake Inc.',
  ],
]
for (const [name, text] of MODELS) out += sub(name) + text + '\nThe Apache License 2.0 text is reproduced in section 0.\n'

out += hr('8. Citation Style Language styles and locales — CC BY-SA 3.0')
out += readRepo('data/citation/NOTICE') + '\n'
out += `
Licence: Creative Commons Attribution-ShareAlike 3.0 Unported,
https://creativecommons.org/licenses/by-sa/3.0/legalcode
These data files are shipped unmodified as separate files beside the app
(Key.app/Contents/Resources/citation/styles and .../citation/locales) and are
read at run time; they are not compiled into Key's program. The same files are
available from the source URLs above and in Key's source repository
(data/citation/styles, data/citation/locales). The CC BY-SA licence applies to
these files only, not to Key's program code.
`
const xmlText = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'").replace(/&quot;/g, '"').trim()
const people = (info, tag) => [...info.matchAll(new RegExp(`<${tag}>[\\s\\S]*?<name>([^<]*)</name>[\\s\\S]*?</${tag}>`, 'g'))].map((m) => xmlText(m[1]))
const credit = (dir, title) => {
  const lines = []
  for (const f of readdirSync(join(REPO, dir)).filter((f) => /\.(csl|xml)$/.test(f)).sort()) {
    const info = /<info>([\s\S]*?)<\/info>/.exec(readFileSync(join(REPO, dir, f), 'utf8'))?.[1] ?? ''
    const name = xmlText(/<title>([^<]*)<\/title>/.exec(info)?.[1] ?? f)
    const authors = [...people(info, 'author'), ...people(info, 'translator')]
    const contributors = people(info, 'contributor')
    let line = `${f} — ${name}`
    if (authors.length) line += `\n    by ${authors.join(', ')}`
    if (contributors.length) line += `\n    contributors: ${contributors.join(', ')}`
    lines.push(line)
  }
  return sub(title) + lines.join('\n') + '\n'
}
out += credit('data/citation/styles', 'Styles (https://github.com/citation-style-language/styles)')
out += credit('data/citation/locales', 'Locales (https://github.com/citation-style-language/locales)')

// `--out <file>` writes elsewhere (checks); the default is the file packaging ships
const outArg = process.argv.indexOf('--out')
const dest = outArg > 0 ? resolve(process.argv[outArg + 1]) : join(ROOT, 'apps/key/build/THIRD-PARTY-NOTICES.txt')
mkdirSync(dirname(dest), { recursive: true })
writeFileSync(dest, out)
console.log(
  `written: ${relative(ROOT, dest)} (${(out.length / 1024).toFixed(0)} KB) — ` +
    `${resolved.length} npm packages, ${crates?.length ?? 0} crates`,
)
if (noText.length > 0) console.warn(`no license file published: ${noText.join(', ')}`)
if (missing.size > 0) console.warn(`not installed, skipped: ${[...missing].join(', ')}`)
