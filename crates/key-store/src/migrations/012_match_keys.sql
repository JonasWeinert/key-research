-- What each library source is found by when asking "is this work in the library?" and
-- "which sources might be duplicates?": its normalised identifiers, link, file, first author
-- and title start (duplicates.rs `row_keys`, through the `key_match_keys` function). Kept up
-- to date by the triggers below, so a lookup is an index probe instead of a library scan.
CREATE TABLE source_match_keys (
  source_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  -- The source's year: a very common author or title start is narrowed to nearby years.
  year INTEGER
);
CREATE INDEX source_match_keys_value ON source_match_keys(kind, value, year);
CREATE INDEX source_match_keys_source ON source_match_keys(source_id);

-- Sources whose matching fields changed, in order: the duplicate engine's in-memory index
-- applies them instead of rebuilding. Only the latest are kept (pruned when the library opens).
CREATE TABLE source_key_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL
);

INSERT INTO source_match_keys(source_id, kind, value, year)
SELECT s.id, json_extract(k.value, '$[0]'), json_extract(k.value, '$[1]'), s.year
FROM sources s, json_each(key_match_keys(s.title, s.year, s.doi, s.isbn, s.pmid, s.pmcid, s.arxiv_id, s.file_hash, s.url, s.openalex_id, s.creators)) k
WHERE s.trashed_at IS NULL;

CREATE TRIGGER sources_match_keys_insert AFTER INSERT ON sources BEGIN
  INSERT INTO source_match_keys(source_id, kind, value, year)
  SELECT NEW.id, json_extract(k.value, '$[0]'), json_extract(k.value, '$[1]'), NEW.year
  FROM json_each(key_match_keys(NEW.title, NEW.year, NEW.doi, NEW.isbn, NEW.pmid, NEW.pmcid, NEW.arxiv_id, NEW.file_hash, NEW.url, NEW.openalex_id, NEW.creators)) k
  WHERE NEW.trashed_at IS NULL;
  INSERT INTO source_key_changes(source_id) VALUES (NEW.id);
END;

CREATE TRIGGER sources_match_keys_update AFTER UPDATE OF title, year, item_type, doi, isbn, pmid, pmcid, arxiv_id, file_hash, url, openalex_id, creators, container_title, work_type, edition, trashed_at ON sources
WHEN OLD.title IS NOT NEW.title OR OLD.year IS NOT NEW.year OR OLD.item_type IS NOT NEW.item_type OR OLD.doi IS NOT NEW.doi OR OLD.isbn IS NOT NEW.isbn
  OR OLD.pmid IS NOT NEW.pmid OR OLD.pmcid IS NOT NEW.pmcid OR OLD.arxiv_id IS NOT NEW.arxiv_id OR OLD.file_hash IS NOT NEW.file_hash OR OLD.url IS NOT NEW.url
  OR OLD.openalex_id IS NOT NEW.openalex_id OR OLD.creators IS NOT NEW.creators OR OLD.container_title IS NOT NEW.container_title
  OR OLD.work_type IS NOT NEW.work_type OR OLD.edition IS NOT NEW.edition OR OLD.trashed_at IS NOT NEW.trashed_at
BEGIN
  DELETE FROM source_match_keys WHERE source_id = OLD.id;
  INSERT INTO source_match_keys(source_id, kind, value, year)
  SELECT NEW.id, json_extract(k.value, '$[0]'), json_extract(k.value, '$[1]'), NEW.year
  FROM json_each(key_match_keys(NEW.title, NEW.year, NEW.doi, NEW.isbn, NEW.pmid, NEW.pmcid, NEW.arxiv_id, NEW.file_hash, NEW.url, NEW.openalex_id, NEW.creators)) k
  WHERE NEW.trashed_at IS NULL;
  INSERT INTO source_key_changes(source_id) VALUES (NEW.id);
END;

CREATE TRIGGER sources_match_keys_delete AFTER DELETE ON sources BEGIN
  DELETE FROM source_match_keys WHERE source_id = OLD.id;
  INSERT INTO source_key_changes(source_id) VALUES (OLD.id);
END;
