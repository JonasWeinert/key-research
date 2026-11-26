// The citable shape of a source the UI passes around. Citations themselves are formatted by
// the host's citation engine (key-cite, through cite.ts).
export interface Creator {
  family?: string;
  given?: string;
  literal?: string;
  role?: string;
  /** The person this creator is in the library (read-only; see the store's graph). */
  personId?: string;
}
export interface CitableSource {
  id: string;
  kind: string;
  itemType?: string;
  title?: string;
  creators: Creator[];
  year?: number;
  date?: string;
  containerTitle?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  publisher?: string;
  place?: string;
  edition?: string;
  doi?: string;
  url?: string;
  isbn?: string;
  issn?: string;
  citationKey?: string;
  institution?: string;
  genre?: string;
}
