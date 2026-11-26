// The workspaces window's own entry: no workspace, no library host, none of the shell's
// startup work, so it shows at once (main/launcher.ts).
import { createRoot } from "react-dom/client";
import "@key/ui/tokens.css";
import "../native.css";
import "../settings.css";
import "../global-drawer.css";
import "../modal.css";
import "./launcher.css";
import Launcher from "./Launcher";

if (/Macintosh/.test(navigator.userAgent)) document.documentElement.classList.add("kx-vibrancy");
createRoot(document.getElementById("root")!).render(<Launcher />);
