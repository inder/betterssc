# Changelog

All notable changes to BetterSSC. Format roughly follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

## [0.7.1] — 2026-06-22

### Changed — 🐦 Tweet-shaped link previews for X / Twitter
- **X/Twitter status links now render as a tweet card** instead of the generic preview: an **avatar + display name + @handle** header with the X brand mark, the full tweet text, and the embedded media rendered **large** (full card width) below — matching how the tweet looks on X as closely as the Open Graph data allows. New pure `parseXStatus` / `xAuthorName` / `buildXInfo` / `unavatarUrl` in `lib/unfurl.js` (15 new tests).
- **Author avatar.** X's `og:image` is the embedded media (not the face) for a tweet with media, so the avatar is resolved from the handle via `unavatar.io/twitter/<handle>` (https, `referrerpolicy=no-referrer`). If unavatar can't resolve it (load error), the slot falls back to the **X glyph** rather than a broken image. For a media-less tweet (`og:image` is a `/profile_images/` URL) that image *is* the avatar, and no large media is shown.
- Same XSS contract as the generic card — name/handle/text via `textContent`, images https-only; the X logo is an inline SVG built node-by-node (no `innerHTML`). 515 tests passing.

## [0.7.0] — 2026-06-22

### Added — 🔗 Link previews (opt-in, local-only)
- **Open Graph unfurl cards under messages that contain a link.** When a chat message has a link, BetterSSC shows a Discord-style preview card (site name · title · description · thumbnail) built from the page's `og:*` / `twitter:*` / `<title>` metadata. New pure `lib/unfurl.js` (parser + URL selection) with 31 unit tests including adversarial HTML.
- **Off by default; opt-in behind a host permission.** Enable in Chat preferences. Turning it on triggers `chrome.permissions.request` for `optional_host_permissions: ["http://*/*","https://*/*"]` from the Save-click user gesture — so the broad page-read access is never requested at install and never held unless the feature is on. Re-checked at boot via `chrome.permissions.contains`; revoking in `chrome://extensions` disables the feature. Turning it off relinquishes the permission.
- **Local + per-viewer.** Each client unfurls the links it sees in its own browser session; nothing is written back to Substack (it would be reconciled away) and nothing is shared with other readers.
- **Privacy/security posture.** The fetch is cookieless (`credentials: 'omit'`); the response body is streamed and capped at 256KB; all page-derived text renders via `textContent` (the `og:*` fields are attacker-controlled — never `innerHTML`); preview images are https-only and loaded with `referrerpolicy="no-referrer"`. Failed unfurls are negative-cached so a dead link isn't refetched on the constant poll re-renders.
- code-reviewer caught + fixed before ship: `attr()` lacked a word boundary so a `data-content` shadow attribute could spoof the card text (fixed with a negative lookbehind); `resolveImageUrl` allowed `http://` images (tightened to https-only, matching the stated invariant); `res.text()` buffered the whole body when `Content-Length` was absent (switched to a streamed read that stops at the cap). 500/500 tests passing.

### Changed
- **Trending ticker rank now blends recency × frequency.** `rank = recency^α · effectiveFreq^(1-α)`, with each author's contribution to a symbol's frequency capped so one person can't fake broad interest. `app.js` opts in at α=0.65 (recency still leads); the `lib/trending.js` default stays α=1.0, identical to the old pure-recency ranking.

## [0.6.0] — 2026-06-22

### Added — 📈 Rolling ticker bar (CNBC/Bloomberg style)
- **A live "TRENDING" strip under the header** that scrolls right→left, showing what the chat is talking about right now — trending **stock tickers**, **@mentioned people**, and **topic keywords** (each 1–2 words). Pulled from the loaded comments in a 2-hour window, recency-weighted (newer mentions rank higher, but a heavily-discussed earlier mover still surfaces).
- **Click a chip → instant chat search.** Clicking any chip drops its term into the search box and runs the search (tickers search the bare symbol, people search `@name`, topics search the word). Hover pauses the scroll so chips are clickable.
- **Live prices on ticker chips.** Stock/crypto chips show a recent price + % change (green ▲ / red ▼), fetched from the Yahoo Finance v8 chart endpoint. The fetch runs in the **background service worker** (not the page) so it bypasses CORS — the endpoint is keyless/crumb-free. Crypto symbols map to the `<SYM>-USD` pair. New `https://query1/query2.finance.yahoo.com/*` host permissions.
- **Prices refresh as a symbol re-appears on the right.** Honored via a per-symbol 20s TTL cache refreshed once per marquee loop (`animationiteration`) plus a 12s safety timer — so a recurring symbol gets a fresh price every few seconds, without coupling network I/O to pixel geometry or hammering the endpoint (inflight-set + TTL gated).
- **Quality-gated extraction.** Tickers gated by `KNOWN_TICKERS`/`$`-prefix (near-zero false positives); people from mention targets; topics require ≥2 **distinct** authors + a strong stoplist + length ≥4 (one person repeating a word isn't "trending"). New pure `lib/trending.js` with 18 unit tests (adversarial near-positives included). Tickers rank first, then people, then topics.
- Respects `prefers-reduced-motion` (no scroll; manual horizontal scroll instead).

## [0.5.2] — 2026-06-16

### Fixed
- **The ✦ Explain block now renders after the group's LAST message**, not inside the head message's row (it was landing between message 1 and message 2 of a multi-message group). `renderGroup` appends the block after the sub-group's final message so it visually wraps the whole logical thought.
- **First-click scroll teleport fixed.** Clicking ✦ used to force a full `renderAll()`, which painted the silent background-prefetch backlog above the viewport — and that backlog's async-loading chart images jumped the feed mid-scroll (only on the first click after a fresh load, before the backlog had rendered). Explain now updates the DOM **surgically** via a new `renderExplainInline` (insert/replace/remove just the one group's block + sync the trigger), calling no `renderAll`, so nothing renders above the click point and the feed stays put. A real `renderAll` (poll / prefetch completion) still self-heals the block via `renderGroup`, so the two paths never diverge.

## [0.5.1] — 2026-06-16

### Changed
- **✦ Explain is now grouped by logical message, not per-message.** A Substack user often types one thought as several back-to-back messages — those are one logical group and now show ONE ✦ (on the group's first message) instead of one per line. A message that *replies to a different target* mid-run starts a new logical group → its own ✦ (so a series where the author quote-replies to two different people gets two buttons). Clicking the ✦ explains the **whole group** — the head message plus its same-author continuations (sent as "(cont'd)" lines) plus the head's reply/quote ancestors — so the model reads the entire thought, not just the first line. New pure `segmentExplainGroups` in `lib/ai-context.js` (8 unit tests: plain runs, reply-splits, same-target merges). The footer reports how many messages of the thread were sent.

### Fixed
- **Explain retry carries the full group.** The inline "Try again" button now re-runs with the same group of messages as the original click (the group is stashed on the head comment and carried across poll/WS re-ingest), instead of silently falling back to explaining only the head.

## [0.5.0] — 2026-06-16

### Added — ✦ Explain (per-message inline AI)
- **Per-message ✦ Explain button.** Every message now carries a persistent, always-visible **✦** button at its top-right (X/Grok-style — not hidden behind hover). Click it and BetterSSC explains *that* message inline, in a distinct block attached right under it: a one-line plain-language gist + 2–4 tight bullets, a **Sources** list when web search ran, and an "Only visible to you" footer. Local-only — nothing is posted to Substack, same privacy story as Summary/Ask. Dismiss (`✕`) or retry per block.
- **Thread-aware context.** Explain walks **up** the clicked message's reply/quote ancestors (`parent_id` + `quote_id`, cycle- and depth-bounded to 12) and sends the whole thread oldest→newest, so a terse reply is explained in the context of what it answers. Pure ancestor-walk in `lib/ai-context.js` (`collectThreadForExplain`), unit-tested for ordering, cycles, dangling parents, depth cap, and the quote-vs-parent preference.
- **Vision — embedded images go to the model.** Charts/screenshots attached to the message (and its thread) are sent as real image input. Anthropic + OpenAI receive the image **URL** (their servers fetch it — any host, no CORS); Google receives inline **base64** (pre-fetched client-side via existing `substackcdn`/`s3`/`giphy` host permissions, fail-soft). Capped at 4 images, SVG excluded, 4 MB per image. New `images` param on the provider layer (`buildRequest` → image blocks attached to the last user turn), unit-tested across all three providers (URL + base64 shapes; text-only calls left byte-for-byte unchanged).
- **Links surfaced for web reading.** http(s) URLs in the message bodies are extracted (deduped, capped at 6, 500-char ceiling) and handed to the model with an instruction to read them via web search — no `<all_urls>` permission grab; the provider's native web search does the fetching.
- **Professional-trader persona.** The explainer speaks like a seasoned desk trader — sharp, decodes jargon instead of hiding behind it, separates the claim from its read, and never buries the risk. No "as an AI" hedging.
- **Web search on by default** for Explain (Anthropic / Google), reusing Ask mode's gating + citation rendering.

### Changed
- **Reaction hover toolbar repositioned** to the **left** of the new ✦ button (same top line), so the persistent ✦ is never covered and the popup never spills below into the next message's row. The emoji picker opens just under it.
- **New `--ai-spark` color** (bright, inviting violet) for AI affordances — distinct from the indigo `--accent`, applied to the ✦ trigger so it reads clearly as "AI."

### Fixed
- **`_explain*` markers survive poll/WS re-ingest.** `ingestComment` now carries forward the inline explanation (and any in-flight pending state) when a message is re-parsed by the polling loop, so a live update can't silently drop a rendered explanation — same carry-forward discipline as the optimistic-send reconcile path.

## [0.4.0] — 2026-06-16

### Added
- **Focus mode (🎯).** A new button next to the search box opens a dialog where you list **terms** (chips — `$SPCX`, `earnings`, …) and/or **tag people** (searchable multiselect with avatars). The feed then hides every message that isn't about what you chose — like pinning the chat to one topic + a few voices. The filtering is **ancestor-aware**: a reply to a `$SPCX` message comes through even if the reply itself never says "$SPCX", because the filter walks UP the reply/quote chain (`parent_id` + `quote_id`) and passes any message whose ancestor matches. Same for people — every reply to a tagged person's message surfaces. Multiple terms/people are OR'd — type several words space- or comma-separated and each becomes its own chip (so `$SPCX earnings TSLA` matches a message about *any* of the three, not all three as a phrase). Selected people pin to the top of the dialog's list and stay visible while you search it for more. A persistent banner shows the active focus chips with `edit` / `× exit focus`; `Esc` exits. Focus intersects cleanly with the existing 💬 thread filter and text search. The walk is memoized per render pass and re-evaluated on every repaint, so backfilled history (the `g` scroll-up loop) re-threads correctly. Pure filter engine in `lib/focus.js` with 21 unit tests covering the ancestor walk, cycles, dangling parents, term-splitting/OR, and the backfill-staleness contract.
- **Discord-style composer.** Icons sit on the right of the textarea (image / GIF / emoji / Send). The composer is constrained to the chat-feed column; the members rail now extends the full height of the page. No `+` button.
- **Send images and GIFs (PNG / JPEG / GIF / WebP).** New 📷 image button in the composer + drag-drop onto the composer area + clipboard paste — all three intake paths funnel into a staged-attachment preview chip above the textarea. Click Send and BetterSSC runs Substack's 3-step upload (register → PUT binary → comment POST) the same way the native client does. Wire decoded via DevTools HAR captures, not inferred. Default max 10 MB per attachment; allow-list restricts MIME so we never POST a `content_type` Substack might reject. Optimistic preview renders instantly via the local `blob:` Object URL, then swaps to the real CDN URL when the server-reconciled comment lands.
- **GIPHY GIF picker** behind a `GIF` button. BYOK — first time you click it, an inline onboarding walks you through getting a free GIPHY API key (`Test & Save` does a live validation ping), then opens the picker. Debounced 300 ms search, 3-column grid of animated thumbnails. Click a GIF → BetterSSC downloads the binary from GIPHY's CDN and re-uploads it via the existing Substack media pipeline as `image/gif`. Key revalidates on every picker open so a revoked key bounces to onboarding cleanly. AbortController on the picker's lifecycle cancels in-flight downloads if you close the picker. "Powered by GIPHY" attribution + "Change key" link in the footer.
- **Composer emoji popover** under the 😊 button. 6 categories of common Unicode glyphs (Smileys / Hands / Hearts / Symbols / Markets / Food). Click inserts at the textarea cursor + dispatches an `input` event so auto-grow + send-button-enable wiring catches it. Re-click toggles closed cleanly.
- **Silent background chat prefetch.** After the initial 25-message page lands, BetterSSC walks every older page in sequence so `g` (scroll-up history) is instant from there on. Default ON; toggle in kebab → `Chat preferences`. 300 ms between page fetches with exponential backoff on 429 (600/1200/2400 ms then give up silently). User-initiated `g` keeps priority — the bg loop waits for `state.loadingHistory` to clear before each fetch. `renderAll()` fires exactly once at completion so the feed never reflows mid-read. Footer counter (`N messages · M authors`) ticks up live during prefetch. Completion flashes a `✓ +N loaded` pill next to where the `↓ Latest` pill shows.

### Changed
- **README:** real Chrome puzzle-piece SVG in the install steps instead of the 🧩 cartoon emoji. Now matches what users actually see in their toolbar.

### Fixed
- **"sending…" stuck on attachment-only sends.** `extractFreshComment`'s candidate gate was `x.body && x.id` — an attachment-only message has body == `""` (falsy), so the synchronously-returned comment never matched as a reconciliation candidate and the optimistic row's `_pending: true` latched on. Gate is now `x.id != null` — body content was never a real requirement, just an id to match the optimistic clientId.
- **GIF button vertical alignment.** `.composer-gif` overrode `height: 22px` while siblings (image / emoji / Send) inherited 30 px — bottom-aligned row left the GIF 8 px below its neighbors. Dropped the override so all four right-cluster controls sit on the same baseline.
- **`*AI` dropdown stayed open after clicking an item** (Generate Summary / Ask). The CSS shows the popup on `:hover` OR `:focus-within` OR `.is-open` — `setOpen(false)` only removed the class while cursor + focus kept it visible. New `.is-suppressed` class wins via `display: none !important`, cleared on mouseleave so the next intentional hover re-opens cleanly.
- **Scroll position after bg-prefetch reveal.** Completion `renderAll` was rebuilding the DOM with hundreds of older rows; the browser preserved `scrollTop` but `scrollHeight` grew, so a user anchored at the bottom of the 25-message initial render ended up visually mid-chat with no Latest pill. Now we capture `wasAtBottom` + scroll metrics BEFORE `renderAll` and either snap back to the new bottom (if they were there) or preserve the visible content + show the Latest pill (if they'd scrolled away).

## [0.3.0] — 2026-06-11

### Added (this release — Ask BetterSSC AI)
- **Ask BetterSSC AI.** Free-form Q&A grounded in the chat. The `✨ AI` header button is now a hover dropdown with two actions: `Generate AI Summary` (the existing one-click insights flow) and `Ask BetterSSC AI` (new). The Ask action opens a textarea; type any question and the entire visible chat is stuffed into the system prompt (up to the provider's context window — Anthropic 200K fits whole, OpenAI 128K truncates oldest-first with a footer note). Default 4096 output tokens.
- **Native web search in Ask mode.** When the active provider is Anthropic (`web_search_20250305`) or Google Gemini (`google_search` grounding), the model can pull in outside context to complement the chat. Citations come back as a numbered "Sources" list of clickable links inside the response. OpenAI is marked unsupported until the Responses API migration lands (web search lives on a separate endpoint).
- **Three-section sourced rendering.** Ask responses render as labeled sections: `💬 From the chat` (accent bar), `🌐 From the web` (success-green bar), `✦ Synthesis` (warning bar). Each section is colored so you can tell at a glance which claims came from where. The user's question echoes in a `Q` badge at the top.
- **Tunable output token cap.** Tune AI model dialog gains a `Summary output cap` radio (1024 / 2048 / 4096, default 2048) and an `Ask output cap` row (default 4096). Fixes the user-reported truncation bug where briefings cut off mid-sentence (e.g. "Will CIEN hold above 20-"). Power users can dial up to 4096 for dense market briefings or down to 1024 to save on cost.
- **Per-Ask web search toggle.** Default ON; auto-disables and re-labels when the active provider is OpenAI. The toggle state persists even when disabled (provider-dependent UI state ≠ user intent), so switching to a supported provider restores your choice.
- **Clickable `[text](url)` links in AI bodies.** The tiny markdown subset that renders AI messages now turns `[Title](https://example.com)` into a real anchor (opens new tab, `rel="noopener noreferrer"`). Restricted to `http(s)` schemes — `javascript:` / `data:` fall through unlinked. Citation URLs from provider responses also get scheme-checked at parse time. Wikipedia-style URLs with balanced parens (`/wiki/Foo_(bar)`) no longer truncate.
- **Keyboard nav on the `*AI` dropdown.** `ArrowDown` / `Enter` / `Space` on the trigger opens the menu and focuses the first item. `ArrowUp` opens and focuses the last. Inside the menu, `ArrowDown` / `ArrowUp` cycle (wrapping at both ends). `Esc` closes and returns focus to the trigger. Honors the WAI-ARIA `role="menu"` contract.

### Changed (this release)
- **Default output cap raised 1024 → 2048.** Long market briefings (multi-stock + Open Questions tail) were routinely hitting the 1024 ceiling and truncating mid-token. 2048 covers typical briefings with headroom.
- **Provider error strings are bounded + scrubbed.** Provider error messages render at 200-char cap with `sk-…` patterns masked, so an accidental key fragment in a verbose server error can't survive into the visible DOM.

### Added (since 0.2.4)
- **Bare-ticker auto-linking.** Tickers without a `$` prefix (`AAPL`, `TSLA`, `BTC`, `SPY`, `QQQ`, etc.) now auto-link to the TradingView modal, same as `$TICKER` does. Backed by a curated ~300-symbol allowlist (S&P top, broad/sector/leveraged ETFs, top cryptos, indices). Case-sensitive ALL-CAPS only — `Meta` / `meta` stay as text; only `META` links. Single-letter and 2-letter tickers are excluded to keep the false-positive rate down.
- **Quick-react strip in the hover toolbar.** Hovering a message now shows the top 4 emojis used in the current chat *before* the existing `+` (full picker) and `↩` (reply) buttons. Click any to react directly, no picker dance. Sourced from the same `topReactionsInChat()` helper that powers the picker's "Frequently used" row, so the strip and the picker top row agree.
- **Click-to-react on existing reaction pills.** The reaction pills under each message are now click-targets — tap one to add your own reaction of that type without opening the picker. Discoverable via cursor pointer + accent-tinted hover + keyboard focus ring.

### Changed
- **Unified message focus into a single state.** Mouse hover, `j` / `k`, `Arrow Down` / `Arrow Up`, and click all drive the same focus class on the message group — accent-tinted background + 3px bar on the left edge. The old gray hover state on a per-message basis is gone; the entire author block lights up regardless of how you arrived at it. Help dialog row updated: `j / k or ↓ / ↑`.
- **Latest pill respects the active filter.** Clicking `↓ Latest` (or `↓ N new messages`) used to clear your search/thread filter and jump to the absolute bottom of the chat. It now keeps the filter and lands you on the last filtered message. When off-filter activity arrives during a filter session, a muted suffix `· N in chat` shows next to the pill; clicking it clears the filter and jumps to absolute bottom. Two click targets, two distinct actions. Shift+G still clears the filter (keyboard "absolute latest" intent preserved).
- **Bubble-card baseline visual.** Every `.msg-group` now reads as a subtle accent-tinted card by default (~4% accent in light, ~7% in dark). Search hits intensify the tint, search-active even more, so the visual hierarchy still tells you what's a match. The focus marker (`vi-active` 3px bar) is now orthogonal to the background tier — it composes over any state instead of overriding it, so a focused search hit reads as "search hit" plus "this is the cursor."
- **Settings button is now a gear SVG icon.** Replaced the unicode `⋮` glyph with a Lucide-style gear, sized 18×18 with `currentColor` stroke so it reads consistently across themes.
- **AI Insights context now includes reply linkage and reaction summaries.** Each line passed to the LLM is now `[time] Author (replying to X: "snippet"): body [reactions: 👍×2 ❤️×1]`. The `(replying to …)` clause resolves via the inline quote OR by walking `parent_id`/`quote_id` against an id→comment map, so the model stops misattributing replies to whatever the speaker themselves said earlier. Reaction summary tells the LLM when a claim got group agreement.
- **Substack's `upvote` reaction now maps to ❤️.** Matches what Substack's native client shows for the same name; previously rendered as a different glyph.

### Fixed
- **Mousemove for hover focus, not mouseover.** First pass of the focus-unification used `mouseover`, which fires when the page scrolls under a stationary cursor. Result: pressing `j` repeatedly toggled between two messages instead of advancing, because each scroll slid a different group under the cursor and the mouseover handler set THAT as active. Switched to `mousemove` which only fires on real cursor motion in viewport coords.

## [0.2.4] — 2026-06-08

### Added
- **Full emoji reaction picker.** The reaction "+" now opens a real popover: a search box, a "Frequently used" row derived from the reactions actually present in the current chat, and the complete ~392-emoji catalog grouped into scrollable categories. Replaces the old 6-emoji strip.
- **Copy button on AI Insights.** A standard copy icon sits top-right of the insight box and copies the raw markdown body to your clipboard (checkmark on success). Local-only — never touches the Substack wire.

### Changed
- **AI Insights context budget bumped from 6K chars → 60K chars** (~1.5K tokens → ~15K tokens). The previous 6K limit dropped 1342 of 1381 messages in dense chats; 60K fits realistic full-chat summaries while staying under 12% of every supported provider's context window. Keeps latency clickable (~5-8s) and per-call input cost negligible (gpt-4o-mini ~$0.002, claude-haiku ~$0.015, gemini-flash ~$0.001).
- **Reaction picker no longer fetches a live Substack library.** It's backed entirely by the static reaction catalog, so the picker opens instantly and always shows the full set.

### Fixed
- **Frequently-used emoji row spacing.** Short rows stretched each glyph across a wide grid column, leaving big gaps; emojis now pack tight on the left at a fixed size.
- **Picker teardown leak.** Opening or toggling a picker now fully removes the prior one's document click listener (no orphaned listeners), with the open-focus timer cancelled on the fast double-click path.

## [0.2.3] — 2026-06-07

### Added
- **✨ AI Insights (bring your own key).** New header button summarizes whatever is currently visible in the feed (respects active search + thread filter). First click prompts for a provider (OpenAI / Anthropic / Google) and an API key — your key stays in `chrome.storage.local`, chat content goes directly from your browser to the provider, BetterSSC has no server in the path. The insight appears as a special local-only message authored by "✨ BetterSSC AI" with a "Only visible to you · provider · N messages analyzed" footer. Dismissable; reload clears.
- **Mark-as-read on tab return.** When you switch back to the BetterSSC tab from another tab or app, BetterSSC fires an immediate mark-viewed to Substack instead of waiting up to 30s for the timer.

### Changed
- **Header decongested.** "✨ AI Insights" button label shortened to "✨ AI". The redundant "Latest ↓" button is gone from the header — its function moved to the bottom-feed pill (see Fixed below).
- **Publication name truncates with ellipsis** at 240px so long titles can't push the right-side toolbar around.
- **Shift+G** now clears active search + thread filter before scrolling to bottom (matches the bottom pill in Latest mode). Single source of truth via new `goToLatest({clearFilters})` helper.

### Fixed
- **Bottom "↓ Latest" / "↓ N new messages" pill is now actually visible** when you scroll up. Previous `position: absolute` anchored the pill to the bottom of the scrollable content — invisible exactly when needed. Switched to `position: sticky` so it pins to the bottom of the visible scroll viewport.

## [0.2.2] — 2026-06-07

### Added
- **`$TICKER` symbols become TradingView charts.** Click any `$NASA`, `$DXYZ`, `$BRK.B` style symbol in a message to open a free TradingView chart modal with daily candles, full drawing toolbar (horizontal line, trend line, fib, rectangle, etc.), and date-range tabs. `$5` / `$100` dollar amounts are correctly skipped.
- **Auto-pin and auto-watch self.** Your own row sits at position 0 of the pinned section in the member rail by default, with the bell on. Not a hard lock — click off if you don't want it; next session re-adds.
- **"Can't reach Substack" banner.** When two consecutive polls fail (≈24s of dead proxy tab), a yellow warning banner appears at the top of the stream telling you to open or refresh a substack.com tab. Auto-clears on the next successful poll.
- **Plural slash command aliases.** `/has:images`, `/has:links`, `/has:reactions`, `/has:url`, `/has:pic`, `/has:emoji` all map to the same filter. Singular and plural now both work.
- **v0.2 feature-tour article draft** in `posts/v0.2-feature-tour.md` for publishing to Substack.

### Changed
- **Search jumps to the most recent match,** not the oldest. Typing `@boz` now scrolls to boz's latest message instead of a two-month-old one. Thread filter (💬) unchanged — still anchors at parent.
- **Enter blurs the search box** back to the feed so j/k vi nav works without a mouse trip.
- **Install instructions rewritten for non-technical users.** Six step-by-step instructions with what to expect at each, plus a troubleshooting block.
- **Privacy section reworked.** Plain-language manifesto: no server, no database, no backend, nothing leaves your computer.
- **Documented known issues** in the README so users can see what's broken vs polish-pending.

### Fixed
- **Reactions no longer scroll-jump.** Reacting to a mid-history message used to rebuild the entire feed DOM and yank scroll position. Now updates only the reaction pill in place.
- **Dropped redundant `activeTab` permission** that was forcing Chrome's "Access requested" badge to show in the extensions popup even when host_permissions already covered substack.com.

## [0.2.1] — 2026-06-06

Polish pass on header, avatars, reactions. See git log for full commit detail.

## [0.2.0] — 2026-06-06

Write side unlocked: send messages, react, reply, @mention autocomplete, optimistic UI with retry on failed send.

## [0.1.33] — 2026-06-06

Final v0.1 polish cut. Read-only chat client with full reading + filtering + notifications.

## [0.1.0] — 2026-06-06

First public release. Read-only Discord-style client for Substack Chat.
