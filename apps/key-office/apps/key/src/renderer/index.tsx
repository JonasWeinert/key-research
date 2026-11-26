import React from "react";
import { createRoot } from "react-dom/client";
import "@key/ui/tokens.css";
import { openLayers, trackDetailsMenus } from "@key-reader/ui/dismiss";
import App from "./App";
import { preloadNoteEditorWhenIdle } from "./note-editor";
import QuickCapture from "./QuickCapture";
import "@key/design-system/styles.css";
import "./design-shell.css";
import "./native.css";
import "./chrome.css";
import "./reduced-effects";
// The macOS window uses sidebar vibrancy; let the sidebar stay translucent there.
if (/Macintosh/.test(navigator.userAgent))
  document.documentElement.classList.add("kx-vibrancy");
// Native full screen hides the traffic lights; the chrome drops their inset (mac-shell.css).
{
  const key = (window as unknown as { key?: { on?: (e: string, f: (v: unknown) => void) => void; tabAction?: (a: string) => Promise<unknown> } }).key;
  const set = (on: unknown) => document.documentElement.toggleAttribute("data-full-screen", on === true);
  key?.on?.("full-screen", set);
  void key?.tabAction?.("full-screen-state").then(set, () => {});
}
// <details> menus close like every other overlay (outside press, scrolling away, Escape).
trackDetailsMenus("details.kx-menu, details.key-library-tools-menu");
(window as unknown as { __keyOpenOverlays?: () => number }).__keyOpenOverlays = openLayers;
// The note editor is out of the startup bundle; fetch it once the shell has settled so the
// first note or source page shows its editor at once, without shifting the page.
if (location.hash !== "#capture") preloadNoteEditorWhenIdle();
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {location.hash === "#capture" ? <QuickCapture /> : <App />}
  </React.StrictMode>,
);

import "./mac-shell.css";
// Menus last: one look over every surface's own values.
import "./menu.css";
