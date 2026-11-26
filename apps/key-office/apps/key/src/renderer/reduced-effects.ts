// Marks low-end machines (few cores or little memory) so the shell and readers drop live
// blur (reduced-effects.css). "Reduce transparency" is honoured by the stylesheet itself.
import "./reduced-effects.css";

const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
if ((navigator.hardwareConcurrency || 8) <= 4 || (memory !== undefined && memory <= 4))
  document.documentElement.setAttribute("data-reduced-effects", "");
