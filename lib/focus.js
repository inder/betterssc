// Focus mode — the "intelligent" feed filter.
//
// A Focus filter is { terms: string[], userIds: (string|number)[] }. A
// message PASSES the filter when it — OR ANY ANCESTOR in its reply/quote
// chain — matches. "Matches" means:
//   - the body contains one of the focus terms (case-insensitive substring), OR
//   - the message's author is one of the focused people, OR
//   - the message @mentions one of the focused people.
//
// The ancestor-walk is the whole point: focus on "$SPCX" and a reply that
// says only "agreed, huge" still passes because its parent is about $SPCX.
// Focus on a person and every reply to that person's messages passes too.
//
// Substack chat threads via TWO fields — parent_id (threaded reply) and
// quote_id (quote reply) — so we follow BOTH edges upward. Diamond shapes
// and (malformed) cycles are handled by a visited set.
//
// This module is intentionally pure: it takes a `getComment(id)` accessor
// instead of reaching into app state, so it unit-tests headlessly and the
// app can pass `(id) => state.comments.get(id)`.

// True when the filter selects nothing — caller should treat as "show all".
export const isFocusEmpty = (filter) =>
  !filter ||
  ((!filter.terms || filter.terms.length === 0) &&
    (!filter.userIds || filter.userIds.length === 0));

// Normalize a userId for comparison. Substack ids come through as numbers
// in some payloads and strings in others; compare as strings so a filter
// built from a member-rail click (string) matches a comment.user_id (number).
const idKey = (v) => (v == null ? "" : String(v));

// Does THIS comment match directly (ignoring ancestors)?
export const commentDirectlyMatchesFocus = (comment, filter) => {
  if (!comment) return false;
  const terms = filter.terms || [];
  const userIds = new Set((filter.userIds || []).map(idKey));

  if (terms.length) {
    const body = (comment.body || "").toLowerCase();
    for (const term of terms) {
      const t = (term || "").toLowerCase();
      if (t && body.includes(t)) return true;
    }
  }

  if (userIds.size) {
    // Author is a focused person.
    if (userIds.has(idKey(comment.user_id))) return true;
    if (comment.author && userIds.has(idKey(comment.author.id))) return true;
    // Message @mentions a focused person. mentions is a map keyed by
    // mention token → { user_id, ... } (see app.js commentMentionsUser).
    if (comment.mentions) {
      for (const m of Object.values(comment.mentions)) {
        if (m && userIds.has(idKey(m.user_id))) return true;
      }
    }
  }

  return false;
};

// Walk UP the reply/quote chain from `comment`, returning true if the
// comment or any ancestor matches. `getComment(id)` returns the cached
// comment for an id (or undefined if not loaded — we simply stop walking
// that edge). `memo` (optional Map id→boolean) caches per-comment verdicts
// across calls within one filter generation; pass a fresh Map when the
// filter changes. `visited` guards against malformed cycles.
export const commentMatchesFocus = (
  comment,
  filter,
  getComment,
  memo,
  visited
) => {
  if (isFocusEmpty(filter)) return true;
  if (!comment) return false;

  const id = comment.id;
  if (memo && id != null && memo.has(id)) return memo.get(id);

  // `seen` tracks the lineage currently on the recursion stack so a
  // malformed cycle (A→B→A) terminates instead of looping forever. With
  // real Substack data there are no cycles, so `seen` only ever holds a
  // node's strict ancestors — meaning the memo below never caches a
  // "false" that was an artifact of an in-progress cycle. (Caller clears
  // the memo each applySearch pass regardless, so any such artifact would
  // self-heal on the next render.)
  const seen = visited || new Set();
  if (id != null) {
    if (seen.has(id)) return false; // cycle — already on the current stack
    seen.add(id);
  }

  let result = commentDirectlyMatchesFocus(comment, filter);

  if (!result) {
    // Follow both reply edges upward. Either may be absent.
    const parentIds = [comment.parent_id, comment.quote_id].filter(
      (p) => p != null && p !== ""
    );
    for (const pid of parentIds) {
      const parent = typeof getComment === "function" ? getComment(pid) : null;
      if (!parent) continue;
      if (commentMatchesFocus(parent, filter, getComment, memo, seen)) {
        result = true;
        break;
      }
    }
  }

  if (memo && id != null) memo.set(id, result);
  return result;
};

// Build a focus filter from raw inputs, trimming/deduping. Returns null
// when nothing meaningful was provided (so callers can store null = off).
export const buildFocusFilter = (terms, userIds) => {
  const cleanTerms = Array.from(
    new Set(
      (terms || [])
        .map((t) => (t == null ? "" : String(t).trim()))
        .filter(Boolean)
    )
  );
  const cleanIds = Array.from(
    new Set((userIds || []).map(idKey).filter(Boolean))
  );
  if (cleanTerms.length === 0 && cleanIds.length === 0) return null;
  return { terms: cleanTerms, userIds: cleanIds };
};
