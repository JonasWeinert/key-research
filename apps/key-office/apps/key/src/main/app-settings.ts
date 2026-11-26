// App-wide preferences (appearance, whether onboarding is done) and the facts the
// Settings page shows about this install. Workspace and AI settings live elsewhere.
import { app, nativeTheme } from 'electron'
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isTestRun } from './app-notices'

/** Set by whoever launched the app (a smoke opting in to downloads); wins over the setting. */
const launchedAutoDownload = process.env.KEY_MODELS_AUTO_DOWNLOAD
/** The machine-wide models folder every library host shares (key-models in the host). */
export const modelDir = () => process.env.KEY_MODEL_DIR ?? join(app.getPath('appData'), 'Key', 'models')

export type Theme = 'system' | 'light' | 'dark'
export interface AppSettings {
  theme: Theme
  onboarded: boolean
  /** Run the layout model when analysing PDFs (better reading order, tables, headings). */
  layoutModel: boolean
  /** Download on-device models from Hugging Face by themselves when first needed. */
  modelsAutoDownload: boolean
  /** Keep the imported Zotero library in step with Zotero (off: import once). */
  zoteroSync: boolean
  /** Look sources up in OpenAlex when they arrive with a DOI, and refresh counts when viewed. */
  openalex: boolean
  /** Sent with OpenAlex requests (their polite pool); empty uses the app's own address. */
  openalexMailto: string
  /** Only in settings files from before the secret store (moved there on load; always blank now). */
  openalexApiKey: string
  /** Web search providers by id (see main/web-search): turned off, or given an API key. */
  webProviders: Record<string, WebProviderSetting>
  /** A work added from another source's context (its references, a citation card): ask which
   *  collections, put it in the origin source's collections, or in the library only. */
  addFromSource: 'ask' | 'origin' | 'library'
  /** Find PDF (open-access copies) for references as they are added. Off by default. */
  findPdfOnAdd: boolean
  /** The CSL style (bundled or installed id) and locale citations and bibliographies use. */
  citationStyle: string
  citationLocale: string
  /** What Key shows when it opens: the workspaces window, last time's windows, or the last workspace. */
  openAtLaunch: OpenAtLaunch
}
export type OpenAtLaunch = 'workspaces' | 'restore' | 'last'
export interface WebProviderSetting {
  enabled?: boolean
  apiKey?: string
}
const DEFAULTS: AppSettings = { theme: 'system', onboarded: false, layoutModel: true, modelsAutoDownload: true, zoteroSync: false, openalex: true, openalexMailto: '', openalexApiKey: '', webProviders: {}, addFromSource: 'ask', citationStyle: 'apa', citationLocale: 'en-US', findPdfOnAdd: false, openAtLaunch: 'workspaces' }

export class AppSettingsStore {
  private value: AppSettings = { ...DEFAULTS }
  constructor(private readonly path: string) {}

  async load(): Promise<AppSettings> {
    try {
      const stored = JSON.parse(await readFile(this.path, 'utf8'))
      this.value = sanitize({ ...DEFAULTS, ...stored })
    } catch {
      this.value = { ...DEFAULTS }
    }
    apply(this.value)
    return this.get()
  }
  get(): AppSettings {
    return { ...this.value }
  }
  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.value = sanitize({ ...this.value, ...patch })
    apply(this.value)
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(this.value, null, 2))
    await rename(temporary, this.path)
    return this.get()
  }
}

function sanitize(input: AppSettings): AppSettings {
  return {
    theme: (['system', 'light', 'dark'] as const).includes(input.theme) ? input.theme : 'system',
    onboarded: input.onboarded === true,
    layoutModel: input.layoutModel !== false,
    modelsAutoDownload: input.modelsAutoDownload !== false,
    zoteroSync: input.zoteroSync === true,
    openalex: input.openalex !== false,
    openalexMailto: typeof input.openalexMailto === 'string' && /^[^\s@]+@[^\s@]+$/.test(input.openalexMailto.trim()) ? input.openalexMailto.trim() : '',
    openalexApiKey: typeof input.openalexApiKey === 'string' ? input.openalexApiKey.trim().slice(0, 200) : '',
    webProviders: webProviders(input.webProviders),
    addFromSource: (['ask', 'origin', 'library'] as const).includes(input.addFromSource) ? input.addFromSource : 'ask',
    findPdfOnAdd: input.findPdfOnAdd === true,
    citationStyle: typeof input.citationStyle === 'string' && /^[A-Za-z0-9._-]{1,200}$/.test(input.citationStyle) ? input.citationStyle : 'apa',
    openAtLaunch: (['workspaces', 'restore', 'last'] as const).includes(input.openAtLaunch) ? input.openAtLaunch : 'workspaces',
    citationLocale: typeof input.citationLocale === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/.test(input.citationLocale) ? input.citationLocale : 'en-US',
  }
}

function webProviders(input: unknown): Record<string, WebProviderSetting> {
  const out: Record<string, WebProviderSetting> = {}
  if (!input || typeof input !== 'object') return out
  for (const [id, value] of Object.entries(input as Record<string, WebProviderSetting>).slice(0, 20)) {
    if (!/^[a-z0-9-]{1,32}$/.test(id) || !value || typeof value !== 'object') continue
    const entry: WebProviderSetting = {}
    if (typeof value.enabled === 'boolean') entry.enabled = value.enabled
    if (typeof value.apiKey === 'string' && value.apiKey.trim()) entry.apiKey = value.apiKey.trim().slice(0, 200)
    out[id] = entry
  }
  return out
}

// Every view (shell, readers, browser pages) follows prefers-color-scheme, which this sets.
// Library hosts read the layout setting from the environment when they start.
function apply(settings: AppSettings) {
  nativeTheme.themeSource = settings.theme
  process.env.KEY_LAYOUT_MODEL_ENABLED = settings.layoutModel ? '1' : '0'
  process.env.KEY_MODEL_DIR = modelDir()
  // Test runs never download unless the launcher opted in (the hosts' default under tests).
  if (launchedAutoDownload === undefined && !isTestRun()) process.env.KEY_MODELS_AUTO_DOWNLOAD = settings.modelsAutoDownload ? '1' : '0'
  process.env.KEY_OPENALEX_ENABLED = settings.openalex ? '1' : '0'
  process.env.KEY_OPENALEX_MAILTO = settings.openalexMailto
  // API keys never go through the environment (children would inherit them): hosts get the
  // OpenAlex key over their IPC channel (see services/ and the registry's prelude).
  delete process.env.KEY_OPENALEX_API_KEY
}

/** Versions, data locations and whether a Zotero library is present on this Mac. */
export async function appInfo(workspaceParent: string) {
  // KEY_ZOTERO_DATA_DIR points automated checks at a fixture library.
  const zoteroDir = process.env.KEY_ZOTERO_DATA_DIR ?? join(homedir(), 'Zotero')
  const zoteroFound = await access(join(zoteroDir, 'zotero.sqlite')).then(
    () => true,
    () => false,
  )
  return {
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
    userData: app.getPath('userData'),
    workspaceParent,
    modelDir: modelDir(),
    zoteroDir,
    zoteroFound,
    notices: await bundledNotices(),
  }
}

/** The acknowledgements file packaging ships (Resources/), or the generated copy in a dev build. */
async function bundledNotices(): Promise<string | null> {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'THIRD-PARTY-NOTICES.txt')]
    : [join(app.getAppPath(), 'build', 'THIRD-PARTY-NOTICES.txt')]
  for (const path of candidates) {
    if (await access(path).then(() => true, () => false)) return path
  }
  return null
}
