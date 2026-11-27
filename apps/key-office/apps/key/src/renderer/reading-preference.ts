// Which view a kind of source opens in: reading mode or the original. The view the user last
// switched to is remembered for its kind (Key Settings › General › Reading shows and sets it),
// so PDFs and saved web pages each open the way they were last read.
type Kind = "pdf" | "web";
type Bridge = { appSettings?(): Promise<{ settings: { readingMode?: Record<Kind, boolean> } }>; setAppSettings?(patch: unknown): Promise<unknown> };
const bridge = () => (window as unknown as { key?: Bridge }).key;

export async function opensInReadingMode(kind: Kind): Promise<boolean> {
  try {
    return (await bridge()?.appSettings?.())?.settings.readingMode?.[kind] === true;
  } catch {
    return false;
  }
}

export async function rememberReadingMode(kind: Kind, on: boolean) {
  try {
    const current = (await bridge()?.appSettings?.())?.settings.readingMode ?? { pdf: false, web: false };
    if (current[kind] === on) return;
    await bridge()?.setAppSettings?.({ readingMode: { pdf: current.pdf === true, web: current.web === true, [kind]: on } });
  } catch {
    /* the view still switches; it is only not remembered */
  }
}
