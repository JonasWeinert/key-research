// Exports a chart drawn by charts/*.tsx as a standalone SVG or PNG. On screen the charts
// colour themselves with `var(--kx-…)` tokens; an export is a document, so it gets one fixed
// print palette (dark ink on white) whatever the app's theme.

/** The print colour for each token the charts use. */
export const PRINT_PALETTE: Record<string, string> = {
  "--kx-text": "#1d1d1f",
  "--kx-text-2": "#3a3a3c",
  "--kx-text-3": "#6e6e73",
  "--kx-text-muted": "#8e8e93",
  "--kx-line": "#d2d2d7",
  "--kx-line-strong": "#a1a1a6",
  "--kx-line-content": "#e5e5ea",
  "--kx-bg": "#ffffff",
  "--kx-bg-raised": "#ffffff",
  "--kx-bg-sunken": "#f5f5f7",
  "--kx-fill": "#f2f2f7",
  "--kx-fill-2": "#e5e5ea",
  "--kx-accent": "#0a64d6",
  "--kx-accent-soft": "#dbe8fb",
  "--kx-accent-text": "#0a57bb",
  "--kx-green": "#1f8a3b",
  "--kx-red": "#c4302b",
  "--kx-amber": "#b86e00",
  "--kx-indigo": "#4b4fc4",
};
const FONT = "-apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif";

/** `var(--x)` and `var(--x, fallback)` replaced by print colours. */
export function printColors(markup: string, palette = PRINT_PALETTE): string {
  return markup.replace(/var\((--[a-z0-9-]+)(?:\s*,\s*([^)]+))?\)/gi, (_, name: string, fallback?: string) => palette[name] ?? fallback?.trim() ?? "#000000");
}

/** The chart as a standalone SVG document. */
export function svgMarkup(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("font-family", FONT);
  clone.removeAttribute("class");
  clone.removeAttribute("style");
  const box = svg.viewBox.baseVal;
  const width = box?.width || svg.clientWidth || 600,
    height = box?.height || svg.clientHeight || 400;
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  const background = `<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>`;
  const inner = clone.innerHTML;
  clone.innerHTML = background + inner;
  return `<?xml version="1.0" encoding="UTF-8"?>\n${printColors(new XMLSerializer().serializeToString(clone))}`;
}

/** The chart as a PNG at `scale` times its size. */
export async function pngBlob(svg: SVGSVGElement, scale = 2): Promise<Blob> {
  const markup = svgMarkup(svg);
  const box = svg.viewBox.baseVal;
  const width = box?.width || svg.clientWidth || 600,
    height = box?.height || svg.clientHeight || 400;
  const url = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Could not draw the chart"));
      image.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not draw the chart");
    context.scale(scale, scale);
    context.drawImage(image, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not encode the PNG"))), "image/png"));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Saves a blob or text as a download named `filename`. */
export function saveFile(filename: string, content: Blob | string, mime = "image/svg+xml") {
  const blob = typeof content === "string" ? new Blob([content], { type: mime }) : content;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
