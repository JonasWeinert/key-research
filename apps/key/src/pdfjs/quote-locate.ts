import type { NativeTextPage } from '../engines/types';
import type { TextRange } from './reader-model';

// Finds a quoted passage on a page although the quote's spacing, line breaks, hyphenation
// and punctuation spacing differ from the PDF's text layer: both sides are compared on their
// letters and digits only.

const fold = (value: string) => value.normalize('NFKD').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** The characters of `quote` on `page`, or null when the page does not contain it. */
export function locateQuote(page: NativeTextPage, quote: string): TextRange | null {
  const needle = fold(quote);
  if (needle.length < 4) return null;
  const owners: number[] = [];
  let haystack = '';
  page.characters.forEach((character, index) => {
    const folded = fold(character.value);
    for (let n = 0; n < folded.length; n += 1) owners.push(index);
    haystack += folded;
  });
  const range = (start: number, end: number): TextRange => ({
    start: { page: page.page, index: owners[start] },
    end: { page: page.page, index: owners[end] },
  });
  const whole = haystack.indexOf(needle);
  if (whole >= 0) return range(whole, whole + needle.length - 1);
  // A quote edited a little in the note: its opening and its close still anchor it.
  const probe = Math.min(32, Math.floor(needle.length / 3));
  if (probe < 12) return null;
  const head = haystack.indexOf(needle.slice(0, probe));
  if (head < 0) return null;
  const tail = haystack.indexOf(needle.slice(-probe), head);
  if (tail < 0 || tail - head > needle.length * 2) return range(head, head + probe - 1);
  return range(head, tail + probe - 1);
}
