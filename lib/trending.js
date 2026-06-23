// Trending-entity extraction for the rolling ticker bar (CNBC/Bloomberg
// style). Pure + testable: no DOM, no network. Given the loaded chat
// comments it returns a ranked list of "what's being talked about right
// now" — stock tickers, @mentioned people, and topic keywords — each
// capped to 1-2 words so they fit a scrolling chip.
//
// Design notes (see also the v0.6 design review):
//   - Tickers are gated by KNOWN_TICKERS (or a $-prefix), so false
//     positives are near-zero. They rank first because they're the most
//     ticker-tape-like and they carry a live price.
//   - People come from each comment's `mentions` map (the @name targets) —
//     literally "the people being discussed." Near-zero false positives.
//   - Topics are free words and are the noisy class. They're quality-gated:
//     a strong stoplist, length >= 4, and — critically — must appear in
//     messages from >= 2 DISTINCT authors (one person repeating a word is
//     not "trending"). They rank last.
//
// Scoring: every occurrence contributes an exponentially time-decayed
// weight (newer messages count more) — this is the RECENCY axis. By itself
// it's steeply recency-biased: a 3x burst in the last 2 minutes buries a
// symbol the room discussed 8x earlier today. So ranking blends two axes:
//
//   rank = recencyScore^α · effectiveFreq^(1-α)
//
//   - recencyScore   = the decayed-weight sum above ("how hot right now")
//   - effectiveFreq  = occurrence count, but each author capped (see
//                      PER_AUTHOR_FREQ_CAP) so one person hammering a symbol
//                      can't fake broad interest ("how much it's discussed")
//   - α ∈ [0,1]      = recencyAlpha opt. α=1 reproduces the old pure-recency
//                      ranking exactly (the library default, so unchanged for
//                      callers that don't opt in); lower α lets a sustained
//                      mover out-rank a momentary blip.

import { KNOWN_TICKERS } from "./tickers.js";

// Words that are never interesting as a "topic" chip. Chat skews heavily to
// filler, so this list is deliberately broad. Tickers/people are gated
// elsewhere; this only guards the free-word topic class.
const TOPIC_STOPWORDS = new Set([
  // articles / pronouns / conjunctions / prepositions
  "the", "a", "an", "and", "or", "but", "nor", "for", "yet", "so",
  "of", "to", "in", "on", "at", "by", "with", "from", "into", "onto",
  "over", "under", "about", "above", "below", "after", "before",
  "between", "through", "during", "without", "within", "along",
  "this", "that", "these", "those", "they", "them", "their", "theirs",
  "you", "your", "yours", "yourself", "yall", "ours", "mine", "ourselves",
  "we", "us", "our", "he", "him", "his", "she", "her", "hers", "its",
  "it", "i", "me", "my", "myself", "himself", "herself", "itself",
  "who", "whom", "whose", "which", "what", "where", "when", "why", "how",
  // common verbs / auxiliaries
  "is", "am", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "having", "do", "does", "did", "doing", "done",
  "will", "would", "shall", "should", "can", "could", "may", "might",
  "must", "ought", "need", "dare", "used",
  "get", "gets", "got", "gotten", "getting", "go", "goes", "going",
  "gone", "went", "make", "makes", "made", "making", "take", "takes",
  "took", "taken", "taking", "come", "comes", "came", "coming",
  "say", "says", "said", "saying", "see", "sees", "saw", "seen",
  "seeing", "know", "knows", "knew", "known", "knowing", "think",
  "thinks", "thought", "thinking", "want", "wants", "wanted", "wanting",
  "look", "looks", "looked", "looking", "give", "gives", "gave", "given",
  "use", "uses", "feel", "feels", "felt", "feeling", "seem", "seems",
  "tell", "told", "ask", "asked", "work", "works", "worked", "let",
  "lets", "put", "keep", "keeps", "kept", "find", "found", "try",
  "tries", "tried", "trying", "call", "calls", "called", "show", "shows",
  // generic chat filler / qualifiers / fillers
  "yeah", "yep", "nope", "yes", "no", "not", "okay", "ok", "lol", "lmao",
  "haha", "hahaha", "thanks", "thank", "please", "pls", "hey", "hello",
  "hi", "sup", "well", "just", "really", "very", "much", "many", "some",
  "any", "all", "more", "most", "less", "least", "both", "few", "each",
  "every", "either", "neither", "such", "same", "other", "another",
  "than", "then", "there", "here", "again", "ever", "never", "always",
  "still", "also", "too", "even", "only", "quite", "rather", "almost",
  "maybe", "perhaps", "probably", "definitely", "actually", "basically",
  "literally", "honestly", "kinda", "sorta", "gonna", "wanna", "gotta",
  "now", "today", "tomorrow", "yesterday", "soon", "later", "back",
  "good", "great", "nice", "bad", "sure", "right", "wrong", "true",
  "thing", "things", "stuff", "lot", "lots", "bit", "way", "ways",
  "guy", "guys", "dude", "folks", "everyone", "someone", "anyone",
  "nobody", "anybody", "everybody", "something", "anything", "nothing",
  "everything", "people", "person", "time", "times", "day", "days",
  "week", "year", "point", "kind", "sort", "part", "lot",
  "down", "up", "out", "off", "away", "around", "because", "though",
  "while", "since", "until", "unless", "whether", "thats", "dont",
  "doesnt", "didnt", "cant", "wont", "isnt", "arent", "wasnt", "werent",
  "ive", "youre", "theyre", "were", "hes", "shes", "its", "im", "id",
  "ill", "wouldnt", "couldnt", "shouldnt", "havent", "hasnt", "hadnt",
]);

// Recency weight halves every 45 min. Paired with the 2h trending window:
// a fresh mention clearly dominates, but a heavily-discussed symbol from
// ~1-2h ago still retains enough weight (≈0.40 at 1h, ≈0.16 at 2h) to
// surface on volume — so earlier-today movers don't vanish the instant
// chatter quiets down.
const HALF_LIFE_MS = 45 * 60 * 1000;

// Default recency/frequency blend. α=1.0 keeps the library's default
// behavior identical to the old pure-recency ranking — the experiment is
// opt-in via the recencyAlpha opt (app.js passes the tuned value). This
// makes the whole change a one-line revert at the call site.
const DEFAULT_RECENCY_ALPHA = 1.0;

// Per-author cap on how much a single author can contribute to a symbol's
// "effective frequency". Multiple distinct authors still accumulate freely;
// one author posting $NVDA 10x counts as PER_AUTHOR_FREQ_CAP, not 10. Guards
// the frequency axis against becoming a single-author spam vector (tickers
// and people have no distinct-author gate the way topics do).
const DEFAULT_PER_AUTHOR_FREQ_CAP = 3;

// Mirror of the matchers in lib/util.js, narrowed to extraction. We don't
// reuse linkifyText() because it also produces link/text segments and walks
// mention placeholders we strip up front — a focused pass is clearer here.
const BARE_TICKER_RE = /\b[A-Z]{3,5}\b/g;            // case-sensitive
const DOLLAR_TICKER_RE = /(?<![A-Za-z0-9])\$([A-Za-z]{1,6})\b/g;
const MENTION_PLACEHOLDER_RE = /\$\{\d+\}/g;
const WORD_RE = /[A-Za-z][A-Za-z'-]{2,}/g;           // topic candidates

// Pull a display-friendly first-name-ish label from a mention's text.
// "@John Smith" → "John Smith" (2 words kept); "@verylongsinglehandle"
// stays as-is. Caps to 2 words so a chip never wraps.
const cleanMentionLabel = (text) => {
  if (!text) return "";
  const stripped = String(text).replace(/^@/, "").trim();
  if (!stripped) return "";
  const words = stripped.split(/\s+/).slice(0, 2);
  return words.join(" ");
};

// recency weight for a message given the reference "now".
const recencyWeight = (createdAt, now) => {
  const t = new Date(createdAt).getTime();
  if (!Number.isFinite(t)) return 0;
  const age = Math.max(0, now - t);
  return Math.pow(0.5, age / HALF_LIFE_MS);
};

/**
 * Extract ranked trending entities from chat comments.
 *
 * @param {Array<object>} comments  comment objects: {body, mentions, created_at, author}
 * @param {object} [opts]
 * @param {number} [opts.now]              reference time (ms); defaults to Date.now()
 * @param {number} [opts.windowMs]         only consider comments newer than this; default 2h
 * @param {number} [opts.maxItems]         cap on returned chips; default 24
 * @param {number} [opts.minTopicAuthors]  distinct authors required for a topic; default 2
 * @param {number} [opts.recencyAlpha]     recency/frequency blend exponent in [0,1]; 1=pure recency (default)
 * @param {number} [opts.perAuthorFreqCap] max per-author contribution to effective frequency; default 3
 * @returns {Array<{kind:'ticker'|'person'|'topic', label:string, term:string, symbol?:string, score:number, count:number, freq:number, rank:number}>}
 */
export function extractTrending(comments, opts = {}) {
  const now = opts.now != null ? opts.now : Date.now();
  const windowMs = opts.windowMs != null ? opts.windowMs : 2 * 60 * 60 * 1000;
  const maxItems = opts.maxItems != null ? opts.maxItems : 24;
  const minTopicAuthors =
    opts.minTopicAuthors != null ? opts.minTopicAuthors : 2;
  const alpha =
    opts.recencyAlpha != null ? opts.recencyAlpha : DEFAULT_RECENCY_ALPHA;
  const freqCap =
    opts.perAuthorFreqCap != null
      ? opts.perAuthorFreqCap
      : DEFAULT_PER_AUTHOR_FREQ_CAP;

  const cutoff = now - windowMs;

  // Each entry carries an `authors` Map<authorId, perAuthorCount> so we can
  // compute a spam-resistant effective frequency (and, for topics, the
  // distinct-author gate). Occurrences with no known author are not recorded
  // per-author; effectiveFreq() pools them into a single capped bucket.
  // symbol(upper) → {score, count, authors:Map}
  const tickers = new Map();
  // nameKey(lower) → {label, term, score, count, authors:Map}
  const people = new Map();
  // word(lower) → {label, term, score, count, authors:Map}
  const topics = new Map();

  const bump = (map, key, init, w, authorId) => {
    let e = map.get(key);
    if (!e) {
      e = init();
      map.set(key, e);
    }
    e.score += w;
    e.count += 1;
    if (authorId != null) {
      e.authors.set(authorId, (e.authors.get(authorId) || 0) + 1);
    }
    return e;
  };

  // Total occurrences with each author's contribution capped at `freqCap`,
  // plus a single capped bucket for author-less occurrences.
  const effectiveFreq = (e) => {
    let f = 0;
    let accounted = 0;
    for (const n of e.authors.values()) {
      f += Math.min(n, freqCap);
      accounted += n;
    }
    const anon = e.count - accounted;
    if (anon > 0) f += Math.min(anon, freqCap);
    return f || 1; // keep the geometric blend well-defined when count >= 1
  };

  // rank = recencyScore^α · effectiveFreq^(1-α). α=1 → pure recencyScore.
  const blendedRank = (recencyScore, freq) =>
    Math.pow(recencyScore, alpha) * Math.pow(freq, 1 - alpha);

  for (const c of comments || []) {
    if (!c || c._aiGenerated) continue; // skip local AI rows
    const t = new Date(c.created_at).getTime();
    if (Number.isFinite(t) && t < cutoff) continue;
    const w = recencyWeight(c.created_at, now);
    if (w <= 0) continue;

    const authorId =
      (c.author && (c.author.id != null ? c.author.id : c.author.user_id)) ??
      null;

    // ---- people (from mention targets) ----
    if (c.mentions && typeof c.mentions === "object") {
      // De-dup mentions WITHIN one message so a single message naming the
      // same person twice doesn't double-count.
      const seenHere = new Set();
      for (const m of Object.values(c.mentions)) {
        const label = cleanMentionLabel(m && m.text);
        if (!label) continue;
        const key = label.toLowerCase();
        if (seenHere.has(key)) continue;
        seenHere.add(key);
        bump(
          people,
          key,
          () => ({
            label,
            term: "@" + label,
            score: 0,
            count: 0,
            authors: new Map(),
          }),
          w,
          authorId
        );
      }
    }

    const body = typeof c.body === "string" ? c.body : "";
    if (!body) continue;
    const clean = body.replace(MENTION_PLACEHOLDER_RE, " ");

    // ---- tickers: $-prefixed (1-6 letters) ----
    const seenSym = new Set();
    let dm;
    DOLLAR_TICKER_RE.lastIndex = 0;
    while ((dm = DOLLAR_TICKER_RE.exec(clean))) {
      const sym = dm[1].toUpperCase();
      if (seenSym.has(sym)) continue;
      seenSym.add(sym);
      bump(
        tickers,
        sym,
        () => ({ score: 0, count: 0, authors: new Map() }),
        w,
        authorId
      );
    }
    // ---- tickers: bare ALL-CAPS in KNOWN_TICKERS ----
    let bm;
    BARE_TICKER_RE.lastIndex = 0;
    while ((bm = BARE_TICKER_RE.exec(clean))) {
      const sym = bm[0];
      if (!KNOWN_TICKERS.has(sym)) continue;
      if (seenSym.has(sym)) continue;
      seenSym.add(sym);
      bump(
        tickers,
        sym,
        () => ({ score: 0, count: 0, authors: new Map() }),
        w,
        authorId
      );
    }

    // ---- topics (free words) ----
    // Lowercase, strip the ticker-cased tokens we already captured so a
    // symbol never also shows up as a topic. De-dup within the message.
    const seenWord = new Set();
    let wm;
    WORD_RE.lastIndex = 0;
    while ((wm = WORD_RE.exec(clean))) {
      const raw = wm[0];
      const upper = raw.toUpperCase();
      // skip anything that is (or matched as) a ticker symbol
      if (seenSym.has(upper) || KNOWN_TICKERS.has(upper)) continue;
      const lower = raw.toLowerCase().replace(/['-]+$/g, "");
      if (lower.length < 4) continue;
      if (TOPIC_STOPWORDS.has(lower)) continue;
      if (seenWord.has(lower)) continue;
      seenWord.add(lower);
      bump(
        topics,
        lower,
        () => ({
          label: lower,
          term: lower,
          score: 0,
          count: 0,
          authors: new Map(),
        }),
        w,
        authorId
      );
    }
  }

  // ---- assemble + rank ----
  const tickerList = [...tickers.entries()]
    .map(([symbol, e]) => {
      const freq = effectiveFreq(e);
      return {
        kind: "ticker",
        label: symbol,
        term: symbol,
        symbol,
        score: e.score,
        count: e.count,
        freq,
        rank: blendedRank(e.score, freq),
      };
    })
    .sort((a, b) => b.rank - a.rank);

  const personSet = new Set(); // avoid a person dup'ing a ticker label
  for (const t of tickerList) personSet.add(t.label.toLowerCase());

  const personList = [...people.values()]
    .filter((e) => !personSet.has(e.label.toLowerCase()))
    .map((e) => {
      const freq = effectiveFreq(e);
      return {
        kind: "person",
        label: e.label,
        term: e.term,
        score: e.score,
        count: e.count,
        freq,
        rank: blendedRank(e.score, freq),
      };
    })
    .sort((a, b) => b.rank - a.rank);

  const takenLabels = new Set([
    ...tickerList.map((t) => t.label.toLowerCase()),
    ...personList.map((p) => p.label.toLowerCase()),
  ]);

  const topicList = [...topics.values()]
    .filter(
      (e) =>
        e.authors.size >= minTopicAuthors &&
        e.count >= 2 &&
        !takenLabels.has(e.label.toLowerCase())
    )
    .map((e) => {
      const freq = effectiveFreq(e);
      return {
        kind: "topic",
        label: e.label,
        term: e.term,
        score: e.score,
        count: e.count,
        freq,
        rank: blendedRank(e.score, freq),
      };
    })
    .sort((a, b) => b.rank - a.rank);

  // Tickers first (ticker-tape feel + they carry prices), then people,
  // then the noisier topic class. Cap to maxItems.
  return [...tickerList, ...personList, ...topicList].slice(0, maxItems);
}
