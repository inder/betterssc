# Changelog

All notable changes to BetterSSC. Format roughly follows [Keep a Changelog](https://keepachangelog.com/).

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
