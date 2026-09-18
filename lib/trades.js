// lib/trades.js — trade-call parser for the trades strip + Telegram BUY/SELL
// alerts (see ~/.claude/projects/-Users-indersabharwal-betterssc/trade-ticker-arc.md).
//
// Pure: no DOM, no state, no fetch, no LLM (arc non-goal). Regex only,
// calibrated against a committed corpus of REAL chat messages plus
// hand-built near-misses — test/fixtures/trade-messages.json, asserted row by
// row in test/trades-meta.test.mjs. Change a regex here, run that test.
//
// WHY THIS DOES NOT USE KNOWN_TICKERS (lib/tickers.js): that list is a curated
// chart-autolink allowlist. CBRS — the ticker in this arc's own DONE-ORACLE —
// is not in it, and neither are most of the small caps this chat actually
// trades. Gating on it would fail the oracle. Policy here is positional
// instead: a ticker is whatever sits in the object slot right after a trade
// verb — a $-cashtag, or a bare 2-5 letter token in ANY case (the real chat
// writes "Bought MO", "bought orcu", "trim mull") — plus $-cashtags, OCC
// option symbols and bare 3-5 letter CAPS elsewhere in that verb's own
// clause, all minus the stoplists below. Consequence, named on purpose: the strip can show a ticker
// the message body does not auto-link. Do not "fix" this into the allowlist.
//
// CALLER CONTRACT (arc invariant #2): pass the comment's OWN `body` only.
// Substack keeps a quoted parent in a separate `quote` object — it is never
// inlined into `body` — so the invariant is "never concatenate quote text
// before calling this". There is nothing to strip here.
//
// RETURN CONTRACT: `parseTradeMessage(body)` returns an ARRAY of trades, one
// per verb segment, in message order. `[]` when nothing qualifies. A verb
// with no extractable ticker contributes NOTHING — there is never a
// tickerless trade (the strip and the alert both need a symbol).
//
// A trade narrated today but executed earlier ("bought CBRS back in March",
// "added more on Friday") is rejected HERE, by the parser, not by the date
// filter — isTodayET() only knows the message timestamp. Pinned in fixture.

import { TOPIC_STOPWORDS } from "./trending.js";

// ---------------------------------------------------------------------------
// Verb classes. Order matters inside each alternation only for readability;
// the class is decided by which named group matched. `long`/`short` are NOT
// verbs in v1 — they state a position, not a transaction, and collide with
// "long term" / "short squeeze" (START review, slice 1). Bare "buy"/"sell"
// are NOT verbs either: in this chat they are almost always intent or advice
// ("time to buy", "sell into strength"). Present participles ARE accepted
// (trader shorthand for a live fill) but only with a ticker in the object
// slot and no hedge word before the verb.
// ---------------------------------------------------------------------------
const VERB_RE = new RegExp(
  [
    // BUY
    "(?<buy>\\b(?:bought|buying|added|adding|add|entered|entering|picked up|grabbed|scaled into|starter)\\b)",
    // SELL — closed (whole position gone)
    // bare "close" is a fill in this chat ("close DIA lottos"); as a noun
    // ("into the close", "at the close") it has no ticker object and yields
    // nothing, and "close to buying" is caught by the hedge list.
    "(?<closed>\\b(?:closed out|closed|closing|close(?!\\s+to\\b)|exited|exiting|stopped out|covered|dumped|out of|got out of|cut)\\b)",
    // SELL — partial
    // "took profits" in every size — "took small profits in GEV" is how a member
    // actually wrote it (2026-09-18). "take profits" (imperative) stays OUT: it
    // is advice in this chat ("take profits on NVDA here").
    "(?<partial>\\b(?:trimmed|trimming|trim|took (?:some |small |a few |a little |quick |partial |nice |big |)profits?|taking profits|locked in (?:some )?profits?|lightened|scaled out)\\b)",
    // SELL — qualifier decided by what follows (all/out → closed, half/some → partial, else null)
    "(?<sold>\\b(?:sold|selling)\\b)",
  ].join("|"),
  "gi"
);

// Sentence boundaries. Colons are deliberately NOT boundaries ("Bought: CBRS").
// " - " and "…" are: members write "sold GEV - we will handle it". The
// terminator STAYS attached to its sentence (zero-width split after it) so
// the question guard below can still see the "?" — a split that consumed it
// shipped once and made that guard dead code (END review, slice 1, C1).
const SENTENCE_SPLIT_RE = /(?<=[!?;\n…])|(?<=\.)(?!\d)|\s[-–—]\s/; // "12.40?" stays one sentence

// Anything before the verb (within its sentence, after the previous verb) that
// turns a trade verb into intent, hypothesis, regret, negation, or advice.
const HEDGE_RE = new RegExp(
  "\\b(?:not|no|never|n't|dont|don't|didnt|didn't|cant|can't|cannot|wont|won't|wouldnt|wouldn't|" +
    "shouldnt|shouldn't|couldnt|couldn't|havent|haven't|hasnt|hasn't|almost|nearly|tempted|thinking|think|" +
    "considering|consider|planning|plan|plans|will|gonna|going to|want|wants|wanna|would|should|shouldve|" +
    "should've|could|may|might|if|unless|wish|hoping|hope|about to|close to|watching|wait|waiting|debating|" +
    "looking|let's|lets|time to|need to|needs to|ready to|reluctant|before|instead of|rather|without|" +
    "no longer|please|why|when|where|whether|maybe|supposed to|have to|has to|had to|trying to|try to|" +
    "get to|able to|whoever|anyone|someone|somebody|everyone|nobody|glad)\\b|\\bn['’]t\\b",
  "i"
);

// A subject that is not the author. The strip attributes every row to the
// message author, so a trade described about someone else must not parse.
const THIRD_PARTY_RE =
  /\b(?:he|she|they|him|her|his|hers|their|you|u|ya|yall|y'all|buddy|friend|friends|wife|husband|brother|sister|dad|mom|guy|guys|people|folks|fund|funds|insider|insiders|reportedly|whale|whales|somebody|someone|everyone|anyone|whoever|cramer|pelosi|bezos|ellison|musk|za)\b/i;

// "move out of", "breaking out of", "get out of" — motion verbs that make
// "out of" an idiom, never an exit.
const MOTION_BEFORE_OUT_OF_RE =
  /\b(?:move|moves|moved|moving|break|breaks|broke|broken|breaking|breakout|come|comes|coming|came|get|gets|got|getting|kicked|run|runs|ran|running|way|stay|stays|staying|keep|keeps|kept|want|wants|wanted|go|going|went|climb|climbing|jump|jumping|pull|pulled|pulling|snap|snapping)\s*$/i;

// Past-time narration: the trade happened on another day, so it is not one of
// today's trades even though the message is. "for Monday" / "into Friday"
// point FORWARD and are allowed; "from yesterday" / "yesterday's low" are
// references, not trade times.
const PAST_ABS_RE = new RegExp(
  "(?<!\\b(?:from|since)\\s)\\byesterday\\b(?!['’]s)|" +
    "\\blast\\s+(?:week|month|year|night|quarter|weekend|summer|winter|fall|spring|earnings|mon|tue|tues|wed|thu|thur|thurs|fri|monday|tuesday|wednesday|thursday|friday)\\b|" +
    "\\bearlier (?:in|this) (?:the )?(?:week|month|year|summer|quarter)\\b|\\bover the (?:weekend|summer)\\b|\\bin may\\b|" +
    "\\b\\d+\\s+(?:days?|weeks?|months?|years?)\\s+ago\\b|\\bago\\b|\\bback in\\b|" +
    "\\bearlier this (?:week|month|year)\\b|\\bthis past\\b|\\bthe other day\\b|" +
    "\\bin (?:january|february|march|april|june|july|august|september|october|november|december)\\b|" +
    "\\bin (?:q[1-4]|fy\\d{2,4}|fiscal \\d{2,4})\\b",
  "i"
);
// Bare weekday names are AMBIGUOUS ("earnings Monday" points forward), so they
// only count inside the verb's own clause, up to the first comma.
const PAST_WEEKDAY_RE = /(?<!\b(?:for|into|until|till|thru|through|by)\s)\b(?:monday|tuesday|wednesday|thursday|friday)\b/i;

// Idioms keyed on the verb that just matched. Checked against the text right
// after the verb.
const IDIOM_AFTER_RE = {
  closed: /^\s*(?:the\s+(?:gap|day|week|month|laptop|door|book|books|loop|deal|window|tab|tabs|position)\b|(?:up|down|flat|green|red|higher|lower|at|above|below|over|under|near|strong|weak|well|in|on)\b)/i,
  closing: /^\s*(?:the\s+(?:gap|day|week|month)\b|(?:up|down|flat|green|red|higher|lower|at|above|below|over|under|near|strong|weak|well|in|on)\b)/i,
  added: /^\s*(?:to\s+)?(?:my|the|your|a)\s+(?:watch\s*list|watchlist|list|radar|portfolio|group|chat|thread|comment)\b|^\s*a\s+(?:comment|note|thread|post)\b/i,
  adding: /^\s*(?:to\s+)?(?:my|the|your|a)\s+(?:watch\s*list|watchlist|list|radar)\b/i,
  "out of": /^\s*(?:the\s+)?(?:money|office|town|ideas|control|luck|steam|nowhere|sight|touch|reach|breath|patience|time|hand|hands|mind|business|stock|pocket|principle|principles)\b/i,
  cut: /^\s*(?:through|down|off|it|ties|corners|rates|rate|capex|costs|the|a|my\s+(?:screen|screens|teeth|hair))\b/i,
};

// Tokens that may sit between the verb and its ticker without ending the
// object slot. QUANTITY words keep the slot open for a lowercase ticker
// ("bought more mu", "sold 1/2 meta"); after a PREPOSITION only a cashtag or
// caps ticker is accepted ("Bought the dip in SMCI" yes, "sold on the idea"
// no — the lowercase path is the recall/precision knife-edge of this parser).
const QUANTITY = new Set([
  "a", "an", "the", "my", "our", "some", "more", "small", "smalls", "big", "little", "tiny", "few", "half",
  "all", "out", "everything", "rest", "remaining", "full", "entire", "partial", "part", "portion", "piece",
  "chunk", "bunch", "handful", "ton", "tons", "load", "loads", "lot", "lots", "bit", "third", "quarter",
  "back", "again", "another", "one", "two", "three", "starter", "position", "positions", "size", "sized",
  "dip", "dips", "pullback", "breakout", "here", "today", "now", "this", "that", "these", "those", "nice",
  "good", "great", "quick", "fresh", "new", "initial", "first", "second", "1st", "2nd", "also", "just",
  "only", "already", "still", "way", "too", "many", "much", "am", "pm", "morning", "afternoon", "early",
  "late", "earlier", "later", "premarket", "pre", "post", "ah", "ath", "atm", "tomorrow",
]);
const PREPOSITION = new Set([
  "in", "into", "to", "of", "on", "at", "up", "sub", "under", "over", "above", "below", "near", "around",
  "next", "last", "week", "weeks", "month", "months", "there", "after", "before", "with", "for", "from",
]);
const FILLER = new Set([...QUANTITY, ...PREPOSITION]);

// Words that look ticker-shaped but never are, in this chat. Uppercased.
// Includes options/market jargon, month abbreviations (option expiries), chat
// acronyms, 2-letter abbreviations the object slot would otherwise admit (EV,
// ER, TA…), and the everyday nouns that follow a trade verb in ordinary prose
// ("picked up steam", "grabbed lunch", "bought a house"). Bare caps and
// lowercase object-slot tokens are both checked against this; $-cashtags are
// NOT (a member typing $PUTS means it). This list is the precision half of
// the lowercase/2-letter object-slot deviation — every entry that came from a
// review probe is pinned as an expected-[] fixture row.
const JARGON = new Set([
  // 2-letter abbreviations that are not tickers in chat prose
  "EV", "ER", "TA", "FA", "GG", "OP", "ID", "TF", "AF", "PR", "HR", "IR", "TV", "PC", "IB", "HF", "VC",
  "MM", "CB", "DC", "NY", "LA", "SF", "QA", "QB", "RE", "GO", "YO", "OK", "MD", "MS", "MR", "DR", "JR",
  "SR", "ST", "AV", "RV", "SP", "ND", "RD", "TH", "PS", "BS", "AKA", "ETA", "EOW", "EOM", "EOY", "AH",
  // everyday nouns after a trade verb
  "STEAM", "LUNCH", "DINNER", "PIZZA", "FOOD", "COFFEE", "BEER", "WINE", "SOUL", "HOUSE", "HOME", "CAR",
  "CARS", "TRUCK", "BOAT", "BOOK", "BOOKS", "FUEL", "FIRE", "GOLD", "SILVER", "OIL", "GAS", "TRADE",
  "TRADES", "DEAL", "DEALS", "NAME", "NAMES", "EXPOSURE", "HEDGE", "HEDGES", "TICKET", "TICKETS",
  "SEAT", "SEATS", "TIME", "MOMENTUM", "PACE", "SPEED", "GROUND", "WATER", "AIR", "LAND", "FARM", "DOG",
  "CAT", "KID", "KIDS", "WIFE", "GIFT", "GIFTS", "STUFF", "JUNK", "CRAP", "SHIT", "WEED", "DRINK",
  "DRINKS", "ROUND", "ROUNDS", "SPOT", "SPOTS", "SLOT", "SLOTS", "PHONE", "GEAR", "TOOL", "TOOLS",
  "PUMP", "RUG", "BLOOD", "SLEEP", "NAP", "LESSON", "LESSONS", "CLASS", "COURSE", "PASS", "PASSES",
  "CHIP", "CHIPS", "PLAY", "PLAYS", "SETUP", "SETUPS", "STRADDLE", "STRADDLES", "STRANGLE",
  "STRANGLES", "WHEEL", "WHEELS", "COVER", "COVERS", "VIEW", "VIEWS", "LEVEL", "LEVELS", "ZONE",
  "ZONES", "RANGE", "BASE", "FLOOR", "TOP", "BOTTOM", "WALL", "WALLS", "LINE", "LINES", "TREND",
  "TRENDS", "CHART", "CHARTS", "EDGE", "ALPHA", "YIELD", "YIELDS", "BOND", "BONDS", "NOTES", "BILL",
  "BILLS", "CREDIT", "DEBT", "LOAN", "LOANS", "RATE", "RATES", "HIKE", "HIKES", "CUTS", "PRINT",
  "PRINTS", "DATA", "NEWS", "REPORT", "REPORTS", "MEETING", "STEP", "STEPS", "PART", "PARTS",
  "PIECE", "PIECES", "LOAD", "LOADS", "WEIGHT", "SHOT", "SHOTS", "SWING", "SWINGS", "SCALP", "SCALPS",
  "LOTS", "SIZE", "TIER", "TIERS", "LEG", "LEGS", "SIDE", "SIDES", "DIP", "DIPS", "PUMPS", "RIPS",
  "MILK", "BREAD", "SUSHI", "TACO", "TACOS", "BURGER", "STEAK", "EGGS", "WATCH", "SLACK", "BIKE", "BIKES",
  "SALT", "CAB", "UBER", "SOCKS", "SHOES", "SHIRT", "PAINT", "PAPER", "PEN", "DESK", "CHAIR", "TABLE",
  "LAMP", "RUG", "SOFA", "COUCH", "BED", "TENT", "GRILL", "TIRES", "TIRE", "GAME", "GAMES", "TOY", "TOYS",
  "PLANT", "PLANTS", "FLOWER", "TREE", "TREES", "SEED", "SEEDS", "SNACK", "SNACKS", "CANDY", "CAKE",
  "SODA", "WATER", "JUICE", "TEA", "MEAL", "MEALS", "MOVIE", "SHOW", "BOOKS", "ART", "GUN", "GUNS",
  "AMMO", "KNIFE", "TOOLS", "PARTS", "PLANE", "FLIGHT", "HOTEL", "ROOM", "ROOMS", "CABIN", "SPACE",
  "STORAGE", "DOMAIN", "SITE", "APP", "APPS", "SUB", "SUBS", "PLAN", "PLANS", "CARD", "CARDS", "MASK",
  "CALL", "CALLS", "PUT", "PUTS", "LEAP", "LEAPS", "ITM", "OTM", "ATM", "DTE", "IV", "VOL", "OI", "LOTTO",
  "LOTTOS", "SPREAD", "SPREADS", "STRIKE", "STRIKES", "LOD", "HOD", "EOD", "ATH", "ATL", "AVWAP", "VWAP",
  "EMA", "SMA", "MA", "MAS", "RSI", "MACD", "ETF", "ETFS", "FOMC", "CPI", "PPI", "GDP", "NFP", "IPO", "IPOS",
  "IMO", "IMHO", "LOL", "LMAO", "WTF", "OMG", "GM", "GN", "PM", "AM", "EST", "ET", "PT", "PST", "USD", "YOLO",
  "FOMO", "BTFD", "BTD", "LFG", "LT", "ST", "YTD", "DD", "SL", "TP", "AI", "AGI", "EPS", "PE", "PEG", "YOY",
  "QOQ", "CEO", "CFO", "CTO", "COO", "FED", "SEC", "FTC", "DOJ", "NDX", "SPX", "NQ", "ES", "RTY", "YM", "VIX",
  "OKAY", "FYI", "PSA", "EDIT", "NOTE", "TLDR", "TBD", "TBH", "IDK", "NGL", "MAG", "MAG7",
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUNE", "JUL", "JULY", "AUG", "SEP", "SEPT", "OCT", "NOV", "DEC",
  "MON", "TUE", "TUES", "WED", "THU", "THUR", "THURS", "FRI", "SAT", "SUN",
  "LONG", "SHORT", "SHARES", "SHARE", "STOCK", "STOCKS", "OPTION", "OPTIONS", "CONTRACT", "CONTRACTS",
  "FUTURES", "CRYPTO", "COIN", "COINS", "CASH", "MARGIN", "PREMIUM", "DELTA", "GAMMA", "THETA", "VEGA",
  "HEAD", "GAP", "GAPS", "DIP", "DIPS", "RIP", "RUN", "RUNS", "MOON", "BAG", "BAGS", "LOSS", "LOSSES",
  "WIN", "WINS", "PROFIT", "PROFITS", "GAIN", "GAINS", "RISK", "STOP", "STOPS", "LOW", "LOWS", "HIGH", "HIGHS",
  "OPEN", "CLOSE", "BELL", "TAPE", "FLOW", "BULL", "BEAR", "BULLS", "BEARS", "SIZE", "FULL", "HALF", "ALL",
  "MORE", "SOME", "LESS", "BOTH", "NONE", "IRAN", "USA", "US", "UK", "EU", "CHINA",
]);

// Adverbs commonly capitalised at sentence start before a verb. A capitalised
// word before the verb is otherwise read as a third-party subject
// ("Ellison selling", "Cramer bought").
const LEADING_ADVERBS = new Set([
  "just", "also", "then", "so", "and", "but", "yes", "no", "ok", "okay", "today", "finally", "already", "still",
  "now", "well", "oh", "ugh", "yep", "nope", "lol", "damn", "gm", "morning", "update", "fyi", "psa", "note", "edit",
  "actually", "officially", "immediately", "quickly", "honestly", "literally", "again", "yeah", "yea", "ya",
  "alright", "anyway", "anyways", "meanwhile", "afternoon", "evening", "tonight", "yesterday", "tomorrow",
  "premarket", "early", "late", "here", "there", "wow", "lmao", "haha", "hey", "hi", "hello", "sup", "yo",
  "man", "bro", "dude", "fuck", "shit", "i", "im", "i'm", "ive", "i've", "id", "i'd", "we", "we're", "were",
]);

const CASHTAG_RE = /^\$([A-Za-z]{1,6}(?:\.[A-Za-z])?)$/;
const OCC_RE = /^([A-Z]{1,5})\d{6}[CP]\d{3,}$/; // QQQ260918C715 → QQQ
const ALLCAPS_RE = /^[A-Z]{2,5}$/;
const CAPITALIZED_RE = /^[A-Z][a-z]+$/;
const LOWER_RE = /^[a-z]{2,5}$/;
const MIXED_TYPO_RE = /^[A-Z]{2,4}[a-z]$/; // "AAPl" — a shifted-key typo, not a proper noun
const JOINER_RE = /^(?:and|&|\+|,|\/|n)$/i;

function cleanToken(tok) {
  // Strip wrapping punctuation but keep a leading "$" (cashtag) and inner
  // "." / "/" (BRK.B, KRKNF/ONDS). Possessive 's is dropped ("qqq's").
  let t = tok.replace(/^[^A-Za-z0-9$]+/, "").replace(/[^A-Za-z0-9$.]+$/, "");
  t = t.replace(/['’]s$/i, "");
  if (t.endsWith(".")) t = t.slice(0, -1);
  return t;
}

// Classify one cleaned token as a ticker candidate. `bareOk` false = only
// cashtags count (shouting guard). `lowerOk` false = lowercase not accepted
// (used for "out of" / "cut", whose idiom surface is too wide). Returns the
// symbol, or null. Lowercase hits are recorded in `lowSeen` (when passed) so
// the trade can carry a "low" confidence: the lowercase path is a bounded
// stoplist, not a dictionary, and "bought socks" WILL get through it — the
// alert layer (slice 3) can treat such rows differently.
function tickerFromToken(raw, { bareOk, lowerOk, allowTwoCaps, lowSeen }) {
  if (!raw) return null;
  const m = raw.match(CASHTAG_RE);
  if (m) return m[1].toUpperCase();
  if (!bareOk) return null;
  if (OCC_RE.test(raw)) return raw.match(OCC_RE)[1];
  const upper = raw.toUpperCase();
  if (JARGON.has(upper) || TOPIC_STOPWORDS.has(raw.toLowerCase()) || FILLER.has(raw.toLowerCase())) return null;
  if (ALLCAPS_RE.test(raw)) {
    if (raw.length === 2 && !allowTwoCaps) return null;
    return upper;
  }
  if (MIXED_TYPO_RE.test(raw)) return upper;
  if (lowerOk && LOWER_RE.test(raw)) {
    if (lowSeen) lowSeen.add(upper);
    return upper;
  }
  return null;
}

function isShouting(body) {
  const letters = body.replace(/[^A-Za-z]/g, "");
  if (!letters.length) return false;
  const caps = letters.replace(/[^A-Z]/g, "").length;
  const capsTokens = (body.match(/\b[A-Z]{2,}\b/g) || []).length;
  return capsTokens >= 5 && caps / letters.length > 0.6;
}

function splitSlashes(tokens) {
  const out = [];
  for (const t of tokens) {
    if (/^[A-Za-z$]+\/[A-Za-z$]+(?:\/[A-Za-z$]+)*$/.test(t)) out.push(...t.split("/"));
    else out.push(t);
  }
  return out;
}

// Tickers in the object slot after a verb: skip up to 4 filler tokens, take
// the first ticker-shaped token, then keep collecting while joined by
// and/&/,/+ (or directly adjacent caps/cashtags). Returns { tickers, seen }
// where `seen` is the filler words consumed (used for the sold qualifier).
function objectSlot(segment, opts) {
  const tokens = splitSlashes(segment.split(/\s+/).map(cleanToken).filter(Boolean));
  const seen = [];
  const tickers = [];
  let i = 0;
  let skipped = 0;
  let sawPreposition = false;
  while (i < tokens.length && skipped < 4) {
    const t = tokens[i];
    const lower = t.toLowerCase();
    if (FILLER.has(lower) || /^(?=.*\d)[\d./%$:,]+[a-z]{0,2}$/i.test(t)) {
      if (PREPOSITION.has(lower)) sawPreposition = true;
      seen.push(lower);
      i++;
      skipped++;
      continue;
    }
    break;
  }
  if (i >= tokens.length) return { tickers, seen };
  const first = tokens[i];
  if (CAPITALIZED_RE.test(first) && !first.startsWith("$")) return { tickers, seen }; // proper noun, not a ticker
  const t0 = tickerFromToken(first, { bareOk: opts.bareOk, lowerOk: opts.lowerOk && !sawPreposition, allowTwoCaps: true, lowSeen: opts.lowSeen });
  if (!t0) return { tickers, seen };
  tickers.push(t0);
  i++;
  // Continuation: "INTC CBRS", "tna and tqqq", "$FIG & $RDW", "QLYS and DT".
  let expectJoined = false;
  while (i < tokens.length) {
    const t = tokens[i];
    if (JOINER_RE.test(t)) {
      expectJoined = true;
      i++;
      continue;
    }
    const cand = tickerFromToken(t, {
      bareOk: opts.bareOk,
      lowerOk: expectJoined && opts.lowerOk, // lowercase only when explicitly joined
      allowTwoCaps: true,
      lowSeen: opts.lowSeen,
    });
    if (!cand) break;
    if (!tickers.includes(cand)) tickers.push(cand);
    expectJoined = false;
    i++;
  }
  return { tickers, seen };
}

// Fallback when the object slot is empty: first cashtag / OCC symbol / bare
// 3-5 caps token later in the verb's OWN clause — bounded at the first comma
// or conjunction, so "Took profits, rotating into NVDA" cannot bind NVDA to
// the exit (END review, slice 1, C3). Catches "added NOV 130 puts small USO"
// and "bought Call to Open 1 QQQ260918C715".
const CLAUSE_STOP_RE = /,|\b(?:and|but|then|while|after|before|now|might|may|will|into|watching|eyeing)\b/i;
function forwardScan(segment, opts) {
  const clause = segment.split(CLAUSE_STOP_RE)[0] || "";
  const tokens = splitSlashes(clause.split(/\s+/).map(cleanToken).filter(Boolean));
  for (const t of tokens) {
    if (CAPITALIZED_RE.test(t)) continue;
    const cand = tickerFromToken(t, { bareOk: opts.bareOk, lowerOk: false, allowTwoCaps: false });
    if (cand) return [cand];
  }
  return [];
}

// Object-first shapes: "ARM added sub 240", "$MUU starter", "META sept 25 700
// starter". Only the sentence-initial token or the 3 tokens right before the
// verb, and only for the FIRST verb in the sentence.
function backwardScan(preText, opts) {
  const tokens = splitSlashes(preText.split(/\s+/).map(cleanToken).filter(Boolean));
  if (!tokens.length) return [];
  const window = tokens.slice(-3).reverse();
  for (const t of window) {
    if (CAPITALIZED_RE.test(t)) continue;
    const cand = tickerFromToken(t, { bareOk: opts.bareOk, lowerOk: false, allowTwoCaps: false });
    if (cand) return [cand];
  }
  const first = tokens[0];
  if (!CAPITALIZED_RE.test(first)) {
    const cand = tickerFromToken(first, { bareOk: opts.bareOk, lowerOk: false, allowTwoCaps: true });
    if (cand) return [cand];
  }
  return [];
}

// True when the text after a verb has a word that is neither filler, number
// nor stopword — i.e. the verb has an object of its own, so the object-first
// backward scan must not run ("added it to my watchlist", "ORCL picked up
// steam"). Jargon nouns COUNT as content here: "steam" is an object even
// though it is never a ticker.
function hasContentWord(segment) {
  const tokens = segment.split(/\s+/).map(cleanToken).filter(Boolean);
  return tokens.some((t) => {
    const lower = t.toLowerCase();
    if (FILLER.has(lower) || TOPIC_STOPWORDS.has(lower)) return false;
    if (/^[\d./%$:,]+[a-z]{0,2}$/i.test(t)) return false;
    return /[A-Za-z]/.test(t);
  });
}

function soldQualifier(seen) {
  if (seen.some((w) => ["half", "some", "part", "portion", "piece", "chunk", "third", "quarter", "few", "bit", "little", "partial", "1/2", "1/3", "1/4", "2/3", "3/4"].includes(w))) return "partial";
  if (seen.some((w) => ["all", "out", "everything", "rest", "remaining", "full", "entire"].includes(w))) return "closed";
  return null;
}

function classOf(groups) {
  if (groups.buy) return { action: "BUY", qualifier: null, verb: groups.buy };
  if (groups.closed) return { action: "SELL", qualifier: "closed", verb: groups.closed };
  if (groups.partial) return { action: "SELL", qualifier: "partial", verb: groups.partial };
  return { action: "SELL", qualifier: undefined, verb: groups.sold }; // decided by the object slot
}

/**
 * Parse one chat message body into trade calls.
 * @param {string} body — the comment's OWN body (never with quote text).
 * @returns {Array<{action:"BUY"|"SELL", qualifier:"closed"|"partial"|null, tickers:string[], verb:string, confidence:"high"|"low", raw:string}>}
 *   Empty array when nothing qualifies. Never a tickerless entry. `confidence`
 *   is "low" when a ticker was inferred from a lowercase word ("bought orcu")
 *   rather than a cashtag / caps token — the lowercase path is a stoplist, not
 *   a dictionary, so consumers that fire unattended alerts may want to gate on it.
 */
export function parseTradeMessage(body) {
  if (typeof body !== "string") return [];
  const raw = body;
  const text = body
    .replace(/https?:\/\/\S+/g, " ") // URLs
    .replace(/\$\{\d+\}/g, " ") // mention placeholders
    .replace(/[’‘]/g, "'"); // curly apostrophes → ASCII so "didn’t" hits the hedge list
  if (!text.trim()) return [];
  const bareOk = !isShouting(text);
  const out = [];

  for (const sentence of text.split(SENTENCE_SPLIT_RE)) {
    if (!sentence || !/[A-Za-z]/.test(sentence)) continue;
    if (/\?/.test(sentence)) continue; // questions are never fills
    VERB_RE.lastIndex = 0;
    const matches = [];
    let m;
    while ((m = VERB_RE.exec(sentence))) matches.push(m);
    if (!matches.length) continue;

    for (let k = 0; k < matches.length; k++) {
      const vm = matches[k];
      const cls = classOf(vm.groups);
      const verbLower = cls.verb.toLowerCase();
      const preStart = k === 0 ? 0 : matches[k - 1].index + matches[k - 1][0].length;
      const preText = sentence.slice(preStart, vm.index);
      const segEnd = k + 1 < matches.length ? matches[k + 1].index : sentence.length;
      const segment = sentence.slice(vm.index + vm[0].length, segEnd);

      // Guards on the 6 tokens right before the verb (not the whole
      // inter-verb text: "…that I will worry about next year, letting
      // commons run, bought LLY" is a real buy).
      const preTokens = preText.trim().split(/\s+/).map(cleanToken).filter(Boolean);
      const preWindow = preTokens.slice(-6).join(" ");
      if (HEDGE_RE.test(preWindow)) continue;
      // The SUBJECT governs every verb in the sentence ("my buddy sold out of
      // CBRS" has two verbs and one subject), so this window looks back from
      // the sentence start, not just from the previous verb.
      const subjectWindow = sentence.slice(0, vm.index).trim().split(/\s+/).map(cleanToken).filter(Boolean).slice(-6).join(" ");
      if (THIRD_PARTY_RE.test(subjectWindow)) continue;
      if ((verbLower === "out of" || verbLower === "got out of") && MOTION_BEFORE_OUT_OF_RE.test(preText)) continue;
      const prev = preTokens[preTokens.length - 1];
      if (prev && CAPITALIZED_RE.test(prev) && prev.length >= 3 && !LEADING_ADVERBS.has(prev.toLowerCase()) && !TOPIC_STOPWORDS.has(prev.toLowerCase())) continue; // "Ellison selling", "Cramer bought"
      // Idioms right after the verb.
      // Narrated past trade. Unambiguous markers ("3 weeks ago", "back in
      // March", "last quarter") are checked across the verb's whole segment —
      // "added MU, 3 weeks ago" is not today's buy. Bare weekday names are
      // ambiguous ("Bought NVDA here, earnings Monday" IS a buy today), so
      // they only count inside the clause up to the first comma. For a later
      // verb the pre-window belongs to the PREVIOUS verb ("sold AXON I bought
      // 3 weeks ago and added MU"), so only the first verb reads its pre-window.
      const ownClause = segment.split(/,/)[0] || "";
      if (k === 0 && (PAST_ABS_RE.test(preWindow) || PAST_WEEKDAY_RE.test(preWindow))) continue;
      if (PAST_ABS_RE.test(segment) || PAST_WEEKDAY_RE.test(ownClause)) continue;
      const idiom = IDIOM_AFTER_RE[verbLower];
      if (idiom && idiom.test(segment)) continue;
      if ((verbLower === "added" || verbLower === "adding") && /\bwatch\s*list\b|\bradar\b/i.test(segment)) continue;

      const lowerOk = !(verbLower === "out of" || verbLower === "got out of" || verbLower === "cut");
      const lowSeen = new Set();
      const opts = { bareOk, lowerOk, lowSeen };
      let { tickers, seen } = objectSlot(segment.replace(/^[\s:–—-]+/, ""), opts);
      if (!tickers.length) tickers = forwardScan(segment, opts);
      if (!tickers.length && k === 0 && !hasContentWord(segment)) tickers = backwardScan(preText, opts);
      if (!tickers.length) continue; // never a tickerless trade

      const qualifier = cls.qualifier === undefined ? soldQualifier(seen) : cls.qualifier;
      // "low" when any ticker came in through the lowercase path only — a
      // cashtag or caps token is a member's deliberate symbol, a lowercase
      // word is our inference.
      const confidence = tickers.some((t) => lowSeen.has(t)) ? "low" : "high";
      out.push({ action: cls.action, qualifier, tickers, verb: cls.verb, confidence, raw });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// "Today" in America/New_York. One formatter, module scope: this runs on the
// 12s poll path over every comment. en-CA yields YYYY-MM-DD directly, so no
// hand re-assembly (that is where off-by-one bugs live). Both sides of
// isTodayET go through the SAME formatter — comparing an ET key against a
// locally-derived one is the classic bug and only bites viewers outside ET.
// ---------------------------------------------------------------------------
const ET_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const HAS_OFFSET_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * @param {string|Date} value — ISO-8601 with Z/offset, or a Date.
 * @returns {string|null} "YYYY-MM-DD" in America/New_York, or null when the
 *   input is unparseable or an ISO string with NO offset (a bare local time
 *   would be read in the viewer's zone and be silently wrong by hours). A
 *   date-only "YYYY-MM-DD" is refused for the same reason — pass an instant.
 */
export function etDateKey(value) {
  let d;
  if (value instanceof Date) d = value;
  else if (typeof value === "string") {
    const v = value.trim();
    if (!HAS_OFFSET_RE.test(v)) return null; // also refuses date-only "YYYY-MM-DD" — pass a full instant
    d = new Date(v);
  } else return null;
  if (Number.isNaN(d.getTime())) return null;
  return ET_FMT.format(d);
}

/** True when `value` falls on the same America/New_York calendar day as `now`. */
export function isTodayET(value, now = new Date()) {
  const a = etDateKey(value);
  const b = etDateKey(now);
  return a != null && b != null && a === b;
}
