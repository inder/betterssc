# Show HN draft — BetterSSC

HN doesn't render markdown in titles or bodies. Plain text below. Links are inline URLs.

---

## Title options (pick one)

1. `Show HN: BetterSSC – a Discord-style client for Substack Chat`
2. `Show HN: I gave Substack Chat a Discord layout (Chrome MV3, vanilla JS)`
3. `Show HN: BetterSSC – BYOK AI summaries for Substack Chat, no server`

My pick: option 1. It's descriptive, leads with the visible change, and lets the AI angle come out in the body. Option 3 reads too much like the product page; HN moderators sometimes downrank titles that feel like marketing.

## Link target

`https://github.com/inder/betterssc`

Don't link to a Substack post or a landing page. HN trusts GitHub repos. The README walks the install and shows screenshots if you add them later.

## First comment (self-text in the Show HN box)

```
Substack Chat is where a lot of really good traders and writers think out loud in real time, but the native interface gets in the way. Search rarely finds what you want, you can't focus on three specific people in a chat of two hundred, threads of ten replies render as a flat wall of text, and notifications are basically nonexistent.

BetterSSC is a Chrome MV3 extension that paints a Discord-style layout on top of Substack's existing API. Same account, same chats. No backend, no telemetry, no third-party scripts. About 3000 lines of vanilla JS, no build step.

A few technical bits that might be interesting:

1. Cross-origin cookies don't attach from chrome-extension:// origins even with host_permissions + credentials:"include". I work around it by proxying every REST call through an open substack.com tab via chrome.scripting.executeScript({world:"MAIN"}). The fetch runs first-party with cookies. Without this trick the comments endpoint silently returns empty replies[].

2. Reactions and quoted-reply previews come back in a shape the WS event docs don't describe (REST returns {comment, user, quote, pub_roles, user_status} as siblings, not nested). Took five rounds of network probes to map the actual envelope.

3. WebSocket realtime is stubbed but not protocol-decoded. wss://zyncrealtime.substack.com accepts auth and then returns "Invalid message" for every subscribe shape I've tried. I fell back to 12-second REST polling, which is what Substack's own native client does anyway. Side-by-side capture vs a working session is on the roadmap.

4. AI Insights are bring-your-own-key (OpenAI, Anthropic, or Google). The key lives in chrome.storage.local on your device, chat content goes browser-direct to the provider's API, no BetterSSC server in the path because there is no BetterSSC server. Feature is opt-in. The one detail I'm proudest of: when you filter the chat to one person via @name or /from:name, the summary automatically reframes in third person from that person's viewpoint instead of doing the default "the chat is discussing X" thing, which is wrong when the chat at that point IS just one person. Filter drives the reframe, no toggle.

5. The header has a kebab menu to tune the AI model + budget + prompt. The Tune AI Model dialog shows a live per-call cost estimate that updates as you drag the budget slider. Useful for not being surprised by your bill.

Not done yet: send-side image upload (incoming images render fine), native-protocol reply quotes (currently local-only), and a left-rail multi-chat switcher.

License is MIT. PRs welcome. Bug reports especially welcome.

Code: https://github.com/inder/betterssc
```

## Why this shape

A few HN-specific notes for when you actually post:

1. HN allergies: marketing language, exclamation points, "revolutionary," "delightful," any phrase that sounds like a press release. The post above avoids them.

2. HN strengths to lean into: vanilla JS no build step, reverse-engineering story, opt-in privacy with concrete details, honest about what's broken. All four are there.

3. Don't lead with AI. The AI Insights feature is interesting but HN has AI fatigue. The Discord layout + the cross-origin cookie workaround are the real hooks; AI is technical bit number 4.

4. The "Show HN" prefix is required by HN guidelines for things you built. Without it, mods will re-prefix or downrank.

5. Best times to post: Tuesday-Thursday, 8-10am Eastern. Avoid Friday afternoon and weekends. First two hours determine whether you hit the front page.

6. Read https://news.ycombinator.com/showhn.html before posting. The big one most people miss: don't ask for upvotes anywhere, including in your own social channels in the first hour.

7. Reply to comments quickly. Acknowledge real bugs without defensiveness. The first hour of replies sets the thread's tone.

8. If someone asks why this isn't an iframe extension or why you reverse-engineered the API instead of asking Substack — answer honestly. The honest answer is Substack has no public API for chat. HN respects "because the documented option doesn't exist."

## Things to add before posting

- A screenshot in the README's top section. HN viewers click through to the repo within 3 seconds. The first thing they see needs to show the layout.
- A 15-second demo GIF would do more than the screenshot. Optional.
- Pin a tag (v0.2.3 exists already). HN folks check what's the latest release.
- Make sure the README install steps work fresh. Maybe ask a friend to install cold.

## Things NOT to do

- Don't link to your Substack post about it. HN's preference is repo-direct.
- Don't include the X thread.
- Don't crosspost to multiple HN accounts. They detect this.
- Don't repost if it flops. One shot per project unless you've done substantial work since the first attempt.
