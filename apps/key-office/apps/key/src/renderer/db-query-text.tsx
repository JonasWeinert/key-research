// The text mode of the query builder: the same search written out, as in the common databases'
// advanced search: (health OR doctor) AND ((AI OR ML) NOT regression), "phrases", word*, field
// tags such as title: or mesh:. The host reads it (db_query_parse) as the user types; a valid
// text becomes the blocks at once, a problem is shown in plain words at its place, and the last
// valid search stays in force until it is fixed. Edits in the blocks rewrite the text.
import { useEffect, useRef, useState } from "react";
import { cleanQuery, queryKey, readQuery } from "./db-query";
import type { DbQuery, DbSearchApi, TextProblem } from "./db-search-api";
import { Explain } from "./explain";
import { Icon } from "./icons";

export function QueryText({ api, query, onChange }: { api?: DbSearchApi; query: DbQuery; onChange: (q: DbQuery) => void }) {
  const [text, setText] = useState<string>();
  const [problem, setProblem] = useState<TextProblem>();
  const [notes, setNotes] = useState<TextProblem[]>([]);
  const area = useRef<HTMLTextAreaElement>(null);
  // The query key this text stands for: blocks edited elsewhere rewrite it.
  const own = useRef<string>(undefined);
  const key = queryKey(query);
  useEffect(() => {
    if (!api || own.current === key) return;
    let live = true;
    void api.formatTree(cleanQuery(query).expr).then(
      (t) => {
        if (!live) return;
        own.current = key;
        setText(t);
        setProblem(undefined);
      },
      () => {},
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key]);
  useEffect(() => {
    if (!api || text === undefined) return;
    let live = true;
    const timer = setTimeout(() => {
      void api.parseText(text).then(
        (out) => {
          if (!live) return;
          if (!out.ok) {
            setProblem(out.error);
            return;
          }
          setProblem(undefined);
          setNotes(out.notes);
          const expr = readQuery({ expr: out.tree }).expr;
          // Block names are not part of the text: keep them where the blocks line up.
          const items = expr.items.map((n, i) => {
            const was = query.expr.items[i];
            return n.type === "group" && was?.type === "group" && was.label && !n.label ? { ...n, label: was.label } : n;
          });
          const next = { ...query, expr: { ...expr, items } };
          const nextKey = queryKey(next);
          if (nextKey !== key) {
            own.current = nextKey;
            onChange(next);
          }
        },
        () => {},
      );
    }, 280);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  const show = (p: TextProblem) => {
    const el = area.current;
    if (!el) return;
    el.focus();
    // Character offsets from the host; the textarea counts UTF-16 units.
    const at = (n: number) => [...(text ?? "")].slice(0, n).join("").length;
    el.setSelectionRange(at(p.start), at(Math.max(p.end, p.start + 1)));
  };
  const chars = [...(text ?? "")];
  const snippet = (p: TextProblem) => {
    const from = Math.max(0, p.start - 24);
    const to = Math.min(chars.length, Math.max(p.end, p.start + 1) + 24);
    return (
      <code className="kx-db-text-snippet">
        {from > 0 && "…"}
        {chars.slice(from, p.start).join("")}
        <mark>{chars.slice(p.start, Math.max(p.end, p.start + 1)).join("") || " "}</mark>
        {chars.slice(Math.max(p.end, p.start + 1), to).join("")}
        {to < chars.length && "…"}
      </code>
    );
  };
  return (
    <div className="kx-db-text-mode">
      <textarea
        ref={area}
        className="kx-db-text-input"
        aria-label="The search as text"
        aria-invalid={!!problem || undefined}
        aria-describedby="kx-db-text-status"
        spellCheck={false}
        placeholder={'(health OR doctor) AND ((AI OR "machine learning") NOT regression)'}
        rows={Math.min(10, Math.max(3, Math.ceil((text?.length ?? 0) / 80) + 1))}
        value={text ?? ""}
        onChange={(e) => setText(e.target.value)}
      />
      <div id="kx-db-text-status" className="kx-db-text-status" role="status" aria-live="polite">
        {problem ? (
          <div className="kx-db-text-problem">
            <Icon name="warning" size={12} />
            <span>{problem.message}</span>
            {snippet(problem)}
            <button type="button" className="kx-db-link" onClick={() => show(problem)}>
              Show
            </button>
            <span className="kx-db-muted">The blocks keep the last search that could be read.</span>
          </div>
        ) : notes.length ? (
          notes.map((n) => (
            <div key={`${n.start}:${n.message}`} className="kx-db-text-note">
              <Icon name="info" size={12} />
              <span>{n.message}</span>
              {snippet(n)}
            </div>
          ))
        ) : (
          <span className="kx-db-muted">
            AND, OR, NOT, (brackets), "phrases", word* and field tags like title: or mesh:. <Explain help="dbsearch.syntax" label="How to write a search" />
          </span>
        )}
      </div>
    </div>
  );
}
