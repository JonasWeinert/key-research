import React from "react";
import { createRoot } from "react-dom/client";
import "@key/ui/tokens.css";
import { openLayers, trackDetailsMenus } from "@key-reader/ui/dismiss";
import App from "./App";
import QuickCapture from "./QuickCapture";
import "@key/design-system/styles.css";
import "./design-shell.css";
import "./native.css";
// The macOS window uses sidebar vibrancy; let the sidebar stay translucent there.
if (/Macintosh/.test(navigator.userAgent))
  document.documentElement.classList.add("kx-vibrancy");
// <details> menus close like every other overlay (outside press, scrolling away, Escape).
trackDetailsMenus("details.kx-menu, details.key-library-tools-menu");
(window as unknown as { __keyOpenOverlays?: () => number }).__keyOpenOverlays = openLayers;
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {location.hash === "#capture" ? <QuickCapture /> : <App />}
  </React.StrictMode>,
);

import "./mac-shell.css";
