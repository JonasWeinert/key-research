import { describe, expect, it } from 'vitest';
import { chipLabel, printedReference, workByline } from './CitationCard';

const metadata = {
  source: 'OpenAlex',
  title: 'Utility of a deep-learning algorithm',
  authors: ['Akhil Narang', 'Richard Bae', 'Ha Hong'],
  year: 2021,
  journal: 'JAMA Cardiology',
  journalShort: 'JAMA Cardiol',
};

describe('citation card text', () => {
  it('puts surnames, year and the short venue on one line', () => {
    expect(workByline(metadata)).toBe('Narang, Bae et al. · 2021 · JAMA Cardiol');
    expect(workByline({ ...metadata, authors: ['Ha Hong'], year: undefined, journalShort: undefined, journal: undefined })).toBe('Hong');
  });
  it('labels chips by first author and year when known, else by number or position', () => {
    expect(chipLabel(12, true, 0, metadata)).toBe('12 · Narang 2021');
    expect(chipLabel(12, true, 0)).toBe('12');
    expect(chipLabel(3, false, 1, metadata)).toBe('Narang 2021');
    expect(chipLabel(3, false, 1)).toBe('Work 2');
  });
  it('shows a reference as printed, without its list number', () => {
    expect(printedReference({ number: 7, page: 8, text: '7. Narula S, et al. Machine-learning…', textRuns: [] })).toBe(
      'Narula S, et al. Machine-learning…',
    );
  });
});
