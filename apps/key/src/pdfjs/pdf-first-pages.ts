// A PDF's title (document information) and the text of its first pages, for hosts that need to
// recognise a file (matching dropped PDFs to records) without opening a reader.
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

if (!GlobalWorkerOptions.workerSrc) GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export async function pdfFirstPages(data: ArrayBuffer, pages = 2): Promise<{ title: string; text: string; pages: number }> {
  const task = getDocument({ data: new Uint8Array(data) });
  const doc = await task.promise;
  try {
    const info = (await doc.getMetadata().catch(() => null))?.info as { Title?: string } | undefined;
    let text = '';
    for (let i = 1; i <= Math.min(pages, doc.numPages); i++) {
      const content = await (await doc.getPage(i)).getTextContent();
      text += content.items.map(item => ('str' in item ? item.str : '')).join(' ') + '\n';
    }
    return { title: info?.Title?.trim() ?? '', text: text.slice(0, 12000), pages: doc.numPages };
  } finally {
    void task.destroy();
  }
}
