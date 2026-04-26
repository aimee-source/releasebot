# Releasebot Plan

## What it does
Listens for messages in `#releases`, uses Claude to generate a coach-friendly title + summary with label prefix, posts to `#releasebotreview` for approval. Reviewer edits and posts to a chosen channel, or rejects.

## Flow
1. Message posted in `#releases` (deploy bot success OR human post with image/Linear URL)
2. `/api/slack/events` → extracts ticket IDs → looks up Linear (including labels) → calls Claude → posts review card with **Edit & Post** / **Reject** buttons
3. Title is prefixed with label emoji: 🐛 Bug Fix / ✨ New Feature / 🔧 Improvement
4. **Edit & Post**: opens modal with channel picker (AC / IS / CAM), rich text title + message (emoji support), file picker (photos + videos, up to 3)
5. Reviewer picks channel, edits, submits → posts to chosen channel, updates review card to ✅, updates engcal release date
6. **Reject**: updates review card to ❌

## Trigger conditions
- **Human post only**: image/file share in `#releases` (deploy bot success messages no longer trigger — caused duplicate cards)

## Routes
- `POST /api/slack/events` — handles incoming Slack messages + URL verification
- `POST /api/slack/actions` — handles button clicks (opens modal) + modal submissions

## Target channels
- `#assistant-coaches` — `ASSISTANT_COACHES_CHANNEL_ID` (`C03T016QKUJ`)
- `#inside-sales` — `INSIDE_SALES_CHANNEL_ID` (`C046LEL8HJ6`)
- `#cam-cross-functional` — `CAM_CHANNEL_ID` (`C02MZKL6K1A`)
- `#support-ops` — `SUPPORT_OPS_CHANNEL_ID` (`C09KCRW3Y6S`)

## Engcal integration
On modal submission, calls `https://engcal.vercel.app/api/add-release` with the ticket ID and current timestamp to set `releaseDate`. Requires `ENGCAL_SECRET` env var.

## Bot profile
- Name: Release Bot
- Icon: Avida logo (black square, white AVIDA text)
- Description: "Hey! I'm the Avida Release Bot. I keep the team in the loop whenever something new ships. 🚀"

## Env vars
- `SLACK_BOT_TOKEN` — scopes: `channels:history`, `chat:write`, `files:read`, `files:write`, `im:write`, `groups:write`, `groups:history`, `channels:join`
- `SLACK_SIGNING_SECRET`
- `ANTHROPIC_API_KEY`
- `LINEAR_API_KEY`
- `RELEASES_CHANNEL_ID` — `C028K3WGYV7` (#releases)
- `REVIEW_CHANNEL_ID` — `C0AN5CB1UH1` (#releasebotreview)
- `ASSISTANT_COACHES_CHANNEL_ID` — `C03T016QKUJ`
- `INSIDE_SALES_CHANNEL_ID` — `C046LEL8HJ6`
- `CAM_CHANNEL_ID` — `C02MZKL6K1A`
- `ENGCAL_SECRET` — `engcal-secret-2026`

## Status
- ✅ Live on #releases
- ✅ Posts to #assistant-coaches, #inside-sales, #cam-cross-functional, #support-ops
- ✅ Edit modal with channel picker (4 channels), rich text, emoji, file uploads
- ✅ Label emoji prefix on titles (🐛 / ✨ / 🔧)
- ✅ Engcal release dates updated on approval
- ✅ Bot icon + description set in Slack app settings
- ✅ Only triggers on human photo posts (not deploy bot messages — avoids duplicates)

## Pending
- [ ] Add `SUPPORT_OPS_CHANNEL_ID` to Vercel env vars (user must do manually)
- [ ] Thread reply notifications — DM user when someone replies to a bot post
