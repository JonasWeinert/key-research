// Installs the bundled Key Sync plugin into the user's Zotero profile, so nobody has to find
// the .xpi and drag it into Tools → Plugins.
//
// Zotero (like Firefox) only looks for new files in <profile>/extensions/ when its build
// changes, and disables what it finds there unless told otherwise. So while Zotero is closed
// Key drops `extensions.lastAppBuildId` (Zotero writes it back on start) and clears the
// profile bit from `extensions.autoDisableScopes`; the plugin puts that pref back the first
// time it starts. Zotero rewrites prefs.js when it quits, so these edits wait until it is
// closed: Key applies them when it sees Zotero closed, or quits Zotero politely to restart it.
import { execFile, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const PLUGIN_ID = "key-sync@key.dev";
const MARK = "extensions.key-sync.restoreAutoDisableScopes";
/** Zotero's add-on scope for the profile's extensions folder. */
const SCOPE_PROFILE = 1;

export type InstallState =
  /** No Zotero profile on this Mac. */
  | "no-zotero"
  | "not-installed"
  /** An older Key Sync is installed. */
  | "outdated"
  /** The file is in place; Zotero turns it on at its next start. */
  | "pending"
  | "installed"
  /** Installed but switched off in Zotero → Tools → Plugins. */
  | "disabled";

export interface InstallStatus {
  state: InstallState;
  running: boolean;
  profile: string | null;
  installedVersion: string | null;
  bundledVersion: string | null;
}

const appPath = () => process.env.KEY_ZOTERO_APP || "/Applications/Zotero.app";
const zoteroDir = () => process.env.KEY_ZOTERO_PROFILE_ROOT || join(homedir(), "Library/Application Support/Zotero");

/** The profile Zotero starts with: the default one in profiles.ini, else the only one. */
export function zoteroProfile(): string | null {
  const root = zoteroDir();
  try {
    const ini = readFileSync(join(root, "profiles.ini"), "utf8");
    const sections = ini.split(/^\[/m).map((s) => Object.fromEntries(s.split("\n").map((l) => l.split("=").map((x) => x.trim())).filter((p) => p.length === 2)));
    const chosen = sections.find((s) => s.Path && s.Default === "1") ?? sections.find((s) => s.Path);
    if (chosen) {
      const dir = chosen.IsRelative === "0" ? chosen.Path : join(root, chosen.Path);
      if (existsSync(join(dir, "prefs.js"))) return dir;
    }
  } catch {
    // No profiles.ini: look in Profiles/.
  }
  try {
    const dirs = readdirSync(join(root, "Profiles"))
      .map((d) => join(root, "Profiles", d))
      .filter((d) => existsSync(join(d, "prefs.js")));
    return dirs.length === 1 ? dirs[0] : (dirs.find((d) => d.endsWith(".default")) ?? dirs[0] ?? null);
  } catch {
    return null;
  }
}

/** Whether Zotero is running, by its executable. */
export function zoteroRunning(): boolean {
  try {
    execFileSync("pgrep", ["-f", join(appPath(), "Contents/MacOS/zotero")], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const versionOf = (xpi: string): string | null => {
  try {
    return JSON.parse(execFileSync("unzip", ["-p", xpi, "manifest.json"], { encoding: "utf8" })).version ?? null;
  } catch {
    return null;
  }
};

/** Whether version a is newer than b ("1.0.10" > "1.0.9"). */
export const newer = (a: string, b: string) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

const registered =(profile: string): { version?: string; active?: boolean; userDisabled?: boolean; path?: string } | undefined => {
  try {
    const db = JSON.parse(readFileSync(join(profile, "extensions.json"), "utf8"));
    return (db.addons ?? []).find((a: { id: string }) => a.id === PLUGIN_ID);
  } catch {
    return undefined;
  }
};

const target = (profile: string) => join(profile, "extensions", `${PLUGIN_ID}.xpi`);

export function installStatus(bundle: string | null): InstallStatus {
  const profile = zoteroProfile();
  const running = zoteroRunning();
  const bundledVersion = bundle ? versionOf(bundle) : null;
  if (!profile) return { state: "no-zotero", running, profile, installedVersion: null, bundledVersion };
  const entry = registered(profile);
  const file = target(profile);
  const fileVersion = existsSync(file) ? versionOf(file) : null;
  const installedVersion = entry?.version ?? null;
  let state: InstallState;
  if (!fileVersion) state = "not-installed";
  else if (bundledVersion && newer(bundledVersion, fileVersion)) state = "outdated";
  else if (!entry || entry.version !== fileVersion) state = "pending";
  else if (entry.userDisabled) state = "disabled";
  else state = "installed";
  return { state, running, profile, installedVersion, bundledVersion };
}

const userPref = (prefs: string, name: string): string | undefined =>
  prefs.match(new RegExp(`^user_pref\\("${name.replace(/\./g, "\\.")}",\\s*(.+?)\\);\\s*$`, "m"))?.[1];
const withoutPref = (prefs: string, name: string) => prefs.replace(new RegExp(`^user_pref\\("${name.replace(/\./g, "\\.")}",.*\\n?`, "gm"), "");

/** While Zotero is closed: make its next start pick up and enable the plugin. Idempotent. */
export function prepareProfile(profile: string) {
  if (zoteroRunning()) return false;
  const file = join(profile, "prefs.js");
  const before = readFileSync(file, "utf8");
  let prefs = withoutPref(before, "extensions.lastAppBuildId");
  if (userPref(prefs, MARK) === undefined) {
    const current = userPref(prefs, "extensions.autoDisableScopes");
    const value = current === undefined ? 15 : Number(current);
    if (value & SCOPE_PROFILE) {
      prefs = withoutPref(prefs, "extensions.autoDisableScopes");
      prefs += `user_pref("extensions.autoDisableScopes", ${value & ~SCOPE_PROFILE});\nuser_pref("${MARK}", ${current === undefined ? -1 : value});\n`;
    }
  }
  if (prefs !== before) writeAtomic(file, prefs);
  return true;
}

/** Puts back autoDisableScopes if the plugin never got to (Zotero closed, plugin known). */
function restoreProfile(profile: string) {
  if (zoteroRunning()) return;
  const file = join(profile, "prefs.js");
  const before = readFileSync(file, "utf8");
  const mark = userPref(before, MARK);
  if (mark === undefined) return;
  let prefs = withoutPref(withoutPref(before, MARK), "extensions.autoDisableScopes");
  if (Number(mark) >= 0) prefs += `user_pref("extensions.autoDisableScopes", ${Number(mark)});\n`;
  writeAtomic(file, prefs);
}

function writeAtomic(file: string, text: string) {
  const temp = `${file}.key-sync-tmp`;
  writeFileSync(temp, text, { mode: statSync(file).mode });
  renameSync(temp, file);
}

/** Applies pending profile edits when Zotero is closed, so a quit-and-reopen by hand works too. */
export function settleInstall(bundle: string | null): InstallStatus {
  const status = installStatus(bundle);
  try {
    if (status.profile && !status.running) {
      if (status.state === "pending") prepareProfile(status.profile);
      else if (status.state === "installed" || status.state === "disabled") restoreProfile(status.profile);
    }
  } catch (e) {
    console.warn("Key Sync install:", e);
  }
  return status;
}

/** Copies the plugin into the profile; when Zotero is closed it is ready for its next start. */
export function installPlugin(bundle: string | null): InstallStatus {
  if (!bundle) throw new Error("Key could not find its Zotero plugin.");
  const profile = zoteroProfile();
  if (!profile) throw new Error("Key could not find a Zotero profile on this Mac.");
  const file = target(profile);
  const temp = join(profile, `${PLUGIN_ID}.key-sync-tmp`);
  mkdirSync(dirname(file), { recursive: true });
  copyFileSync(bundle, temp);
  renameSync(temp, file);
  return settleInstall(bundle);
}

const run = (cmd: string, args: string[], timeout = 15_000) =>
  new Promise<void>((resolve, reject) => execFile(cmd, args, { timeout }, (e) => (e ? reject(e) : resolve())));

/** Quits Zotero the way the user would (it may ask to save), then starts it again. */
export async function restartZotero(bundle: string | null): Promise<InstallStatus> {
  if (zoteroRunning()) {
    // A Zotero elsewhere (tests) is asked to quit by its process, never the user's one by id.
    if (process.env.KEY_ZOTERO_APP) await run("pkill", ["-TERM", "-f", join(appPath(), "Contents/MacOS/zotero")]).catch(() => {});
    else await run("osascript", ["-e", 'tell application id "org.zotero.zotero" to quit']).catch(() => {});
    const until = Date.now() + 30_000;
    while (zoteroRunning() && Date.now() < until) await new Promise((r) => setTimeout(r, 300));
    if (zoteroRunning()) throw new Error("Zotero did not quit. Quit it yourself, then open it again.");
    // Zotero writes prefs.js as it quits; give the file a moment.
    await new Promise((r) => setTimeout(r, 500));
  }
  return openZotero(bundle);
}

export async function openZotero(bundle: string | null): Promise<InstallStatus> {
  settleInstall(bundle);
  await run("open", [appPath()]);
  return installStatus(bundle);
}
