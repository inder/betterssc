# Changelog

All notable changes to BetterSSC. Format roughly follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

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
