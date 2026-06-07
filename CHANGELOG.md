# Changelog

All notable changes to BetterSSC. Format roughly follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Changed
- **AI Insights context budget bumped from 6K chars → 60K chars** (~1.5K tokens → ~15K tokens). The previous 6K limit dropped 1342 of 1381 messages in dense chats; 60K fits realistic full-chat summaries while staying under 12% of every supported provider's context window. Keeps latency clickable (~5-8s) and per-call input cost negligible (gpt-4o-mini ~$0.002, claude-haiku ~$0.015, gemini-flash ~$0.001).

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
