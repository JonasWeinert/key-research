-- Library hygiene: an operations journal for undo/redo, duplicate merges, fields the user
-- edited by hand, and retraction and correction notices.

-- A source merged into another stays as a hidden row (trashed, never listed) so its id
-- keeps resolving to the one it was merged into, and the merge can be undone.
ALTER TABLE sources ADD COLUMN merged_into TEXT;
CREATE INDEX sources_merged ON sources(merged_into) WHERE merged_into IS NOT NULL;

-- Bibliographic fields (camelCase names, JSON array) the user set by hand: refreshes and
-- background lookups leave them alone.
ALTER TABLE sources ADD COLUMN edited_fields TEXT NOT NULL DEFAULT '[]';

-- `retracted` (from OpenAlex) already exists. What the notice is (retraction, correction,
-- expression_of_concern, withdrawal …), its DOI, when the work was last checked, when it was
-- first flagged, and the user's "not a concern" dismissal.
ALTER TABLE sources ADD COLUMN retraction_kind TEXT;
ALTER TABLE sources ADD COLUMN retraction_notice TEXT;
ALTER TABLE sources ADD COLUMN retraction_date TEXT;
ALTER TABLE sources ADD COLUMN retraction_checked_at INTEGER;
ALTER TABLE sources ADD COLUMN retraction_flagged_at INTEGER;
ALTER TABLE sources ADD COLUMN retraction_dismissed INTEGER NOT NULL DEFAULT 0;

-- Each library operation with what it changed: per source the values before and after,
-- rows it moved from one source to another, and pairs it linked. `undone` entries are the
-- redo stack; a new operation drops them.
CREATE TABLE journal (
  seq INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL,
  undone INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Decisions about two sources (a < b): `distinct` (not duplicates) or `version` (preprint
-- and published version of one work).
CREATE TABLE source_pairs (
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (a, b, kind)
);
CREATE INDEX source_pairs_b ON source_pairs(b);
