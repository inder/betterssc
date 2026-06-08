# AI Insights for Substack Chat: bring your own key, keep your privacy

*A one-click summary button I added to my Substack Chat client. Reads your visible feed, sends it to OpenAI / Anthropic / Google with your own API key, returns a structured summary. No server, no proxy, no telemetry. Tunable model, tunable prompt, live per-call cost.*

![A BetterSSC AI insight summary message in the feed — TLDR, Themes, Key takeaways, and Notable trades sections generated from a markets chat](../assets/ai-summary.png)

I spend a lot of time in Substack chats with hundreds of messages a day. The good ones are dense — three or four traders thinking out loud, names, tickers, theses, half-formed ideas. Catching up after dinner means scrolling through 800 messages to figure out what mattered. That's not reading. That's archaeology.

So I added a button.

## What it does

Click **✨ AI** in the header. The model reads whatever is currently visible in your chat (respecting your search filter and any thread filter you have open) and writes back a structured summary:

- **Themes** — what's being discussed
- **Key takeaways** — most important claims or conclusions
- **Notable trades / ideas** — specific tickers, entries, theses
- **Open questions** — what's unresolved

The summary lands as a special accent-tinted message in your feed authored by *"✨ BetterSSC AI"*. It's local-only. Nothing gets posted back to Substack. The other people in the chat never see it. The polling cursor ignores it so live updates keep working.

That's the headline. The interesting part is everything around it.

## The author-aware reframe

If you've narrowed the chat to one person by typing `@jordan` or `/from:jordan` in the search box, the summary automatically reframes itself in third person from Jordan's viewpoint. *"In Jordan's view, the AI/government investment thesis is the right side of the trade."* *"Jordan flagged SK Hynix as a watch."*

Without this, the model defaults to summarizing *"the chat is discussing X"* which is wrong when the chat at that point IS just one person. You wanted Jordan's worldview, not a meta-narration of Jordan talking.

The filter drives the reframe. There's no toggle. Filter to one person, you get their perspective. Clear the filter, you get the room.

## Concise or Elaborate, on demand

Every summary ships with two buttons at the bottom.

**↓ Concise** generates a tighter version. 3-4 bullets total. Headlines only. No preamble.

**↑ Elaborate** generates a longer version. Direct quotes from messages where they're load-bearing. 2-3 sentences per section. Caveats and contrary views called out.

Each click appends a *new* summary at the bottom of the feed. The original stays. You can compare side by side, dismiss the ones you don't want.

The Elaborate version is the one I reach for most often. The chat already gave me the headlines by being short messages. What I want is the model's read on which claims actually held up, which got pushed back on, what's open.

## The kebab menu, three tuners

Top-right of the header, next to my avatar, there's a ⋮ icon. Click it. Three options.

### 1. Tune AI model

Pick which provider and which model. The dropdown only shows combos where you have an API key configured. Drag a slider to set how much chat history (in characters) gets included in the prompt — anywhere from 6K (about 40 messages) to 200K (about 1300 messages). The dialog shows a live per-call cost estimate that updates as you drag the slider.

I default to gpt-4o-mini at 60K chars. Roughly three-tenths of a cent per click. Anthropic's claude-haiku-4-5 is about two cents. Gemini-2.5-flash is a tenth of a cent. The capable upgrades (gpt-4o, claude-sonnet-4-6, gemini-2.5-pro) are five to ten cents per click. Output cost is part of the estimate because output is capped at 1024 tokens and the estimate assumes about 800.

The point is you can see what every click costs before you make it.

### 2. Tune prompt

Two editable text areas.

**Lens hint.** Tells the model what kind of chat this is. Default is trading-flavored: *"This is a financial / markets / trading group chat. Pay attention to ticker mentions, trade ideas, entries/exits, theses, and risk caveats."* If you use BetterSSC for a book club, swap it for *"This is a book club discussing 19th-century Russian novels."* The model uses the hint to know where to focus.

**Response format template.** The section block. Don't want bullets? Want a single paragraph? Want a haiku? Edit the template. Reset-to-default button on each field.

The one thing not editable is the author-perspective rule. That's mechanical — driven by the search filter, not by the prompt — and breaking it would generate output that looks like a bug.

### 3. Reset all saved data

Wipes everything BetterSSC has on your device. Pinned members, watched users, API key, theme, model preferences, custom prompt. Confirm dialog lists exactly what gets cleared. Does not touch anything on Substack's side.

## Privacy

This is the part I want to spend a paragraph on, because it's the reason I built it this way.

You bring your own API key. OpenAI, Anthropic, or Google, your call. The key lives in `chrome.storage.local` on your device. The chat content you choose to analyze goes directly from your browser to your chosen provider's API. There is no BetterSSC server in the path because there is no BetterSSC server at all.

The feature is opt-in. Until you click ✨ AI and configure a key, none of the AI endpoints are contacted. The core extension — reading, sending, reactions, search, notifications — runs without ever touching a third party.

The provider sees what you send. That's true with or without BetterSSC; if you paste a chat into ChatGPT.com, OpenAI sees the chat. The difference here is BetterSSC doesn't add a hop. Your key, your provider, your terms of service, your bill.

If you don't want any chat content reaching a third party, don't use AI Insights. Everything else works exactly the same.

## What's next

A few things I'm sitting on:

- Better recency awareness. Right now the budget slider treats all 60K chars equally. A future version should weight recent messages more heavily and let you control the recency-vs-coverage tradeoff explicitly.
- Saved prompts. The Tune Prompt dialog overwrites a single configuration. If you want different prompts for different chats (book club vs trading), you currently rewrite by hand.
- Streaming responses. Right now you wait the full 5-10 seconds before seeing anything. Token-by-token streaming would change the feel.

Out of scope for AI Insights but adjacent: a multi-chat switcher (left rail across every chat you're in, Cmd-K quick switch) is the next big arc.

## Try it

BetterSSC is on GitHub at [github.com/inder/betterssc](https://github.com/inder/betterssc). About three minutes to install. No Web Store yet — you load it as an unpacked extension. The README walks every click. Vanilla JS, no build step, 3000 lines you can read end to end before anything runs.

If you use it, tell me what's broken. Bug reports help me prioritize. Feature requests too.

---

## X thread (drafted)

🧵 1/ I added an AI summary button to my Substack Chat client. One click, structured summary of whatever's visible. BYOK so nothing routes through me. Most interesting bit isn't the summary itself.

2/ If you filter the chat to one person (type `@jordan` in search), the summary automatically reframes in third person from that person's viewpoint. "In Jordan's view, …" "Jordan thinks …" instead of "the chat is discussing …"

3/ The filter drives the reframe. No toggle. You wanted Jordan's worldview, not a meta-narration of Jordan talking.

4/ Two buttons at the bottom of every summary: ↓ Concise (3-4 bullets) and ↑ Elaborate (quotes + caveats per section). Each click appends a new summary below the old one. Compare side by side.

5/ Kebab menu in the header has three tuners: pick provider + model, drag a slider for how many chars of chat to send (6K–200K), watch the per-call cost update live as you drag. gpt-4o-mini at 60K is about $0.003/click.

6/ Editable prompt. Default lens is trading-flavored ("pay attention to tickers, trade ideas"). If you use the extension for a book club, swap the lens. Reset-to-default button per field.

7/ Privacy: your key stays in chrome.storage.local on your device, chat content goes browser→provider directly, no BetterSSC server in the path (because there is no BetterSSC server). Feature is opt-in. Core extension touches zero third parties.

8/ Code is on GitHub. Vanilla JS, no build, ~3000 lines you can read end-to-end. Chrome MV3 extension, loads on Substack chat tabs.

9/ Link: github.com/inder/betterssc
