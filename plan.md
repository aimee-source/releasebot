# Releasebot Plan

## What it does
Listens for messages in `#releases`, uses Claude to generate a coach-friendly title + summary, posts to `#releasebotreview` for approval. Reviewer can edit and post to a chosen channel, or reject.

## Flow
1. Message posted in `#releases` (deploy bot success OR human post with image/Linear URL)
2. `/api/slack/events` receives it → extracts ticket IDs (from GitHub commits or Claude image scan) → looks up Linear → calls Claude → posts to `#releasebotreview` with **Edit & Post** / **Reject** buttons
3. **Edit & Post**: opens modal with channel picker (AC / IS / CAM), rich text title + message (emoji support), file picker (photos + videos, up to 3)
4. Reviewer picks channel, edits title/message, optionally attaches media → submits → posts to chosen channel, updates review card to ✅, updates engcal release date
5. **Reject**: updates review card to ❌

## Trigger conditions
- **Deploy bot**: bot message with "success" + "production" in `#releases`
- **Human post**: any image/file share OR Linear URL in `#releases` (no "production" required)

## Routes
- `POST /api/slack/events` — handles incoming Slack messages + URL verification
- `POST /api/slack/actions` — handles button clicks (opens modal) + modal submissions

## Target channels
- `#assistant-coaches` — `ASSISTANT_COACHES_CHANNEL_ID` (`C03T016QKUJ`)
- `#inside-sales` — `INSIDE_SALES_CHANNEL_ID` (`C046LEL8HJ6`)
- `#cam-cross-functional` — `CAM_CHANNEL_ID` (`C02MZKL6K1A`)

## Engcal integration
On modal submission, calls `https://engcal.vercel.app/api/add-release` with the ticket ID and current timestamp to set `releaseDate`. Requires `ENGCAL_SECRET` env var.

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
- ✅ Posts to #assistant-coaches, #inside-sales, #cam-cross-functional
- ✅ Edit modal with channel picker, rich text, emoji, file uploads
- ✅ Engcal release dates updated on approval

## Pending
- [ ] Thread reply notifications — DM user when someone replies to a bot post
- [ ] CAM channel end-to-end test
