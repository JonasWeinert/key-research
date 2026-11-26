// `key://` links opened from other apps (an exported Markdown note in Obsidian links each
// highlight as key://source/<id>#highlight:<id>). The packaged app registers the scheme
// (Info.plist through electron-builder's `protocols`, and at run time); a link that arrives
// before a window is ready waits for one.
import { app } from "electron";

const SCHEME = "key";
let deliver: ((url: string) => boolean) | undefined;
const waiting: string[] = [];

function take(url: string) {
  if (!url.startsWith(`${SCHEME}://`)) return;
  if (!deliver?.(url)) waiting.push(url);
}

/** Call before the app is ready, so a link that launched it is not missed. */
export function listenForDeepLinks() {
  if (app.isPackaged && !process.env.KEY_USER_DATA) app.setAsDefaultProtocolClient(SCHEME);
  app.on("open-url", (event, url) => {
    event.preventDefault();
    take(url);
  });
  // Windows and Linux pass the link to a second instance on its command line.
  app.on("second-instance", (_event, argv) => argv.filter((a) => a.startsWith(`${SCHEME}://`)).forEach(take));
}

/** Once a shell window can open items: `send` returns false while none can. */
export function deliverDeepLinks(send: (url: string) => boolean) {
  deliver = send;
  while (waiting.length && send(waiting[0])) waiting.shift();
}
