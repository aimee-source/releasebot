# Releasebot Plan

## What it does
Listens for messages in `#releases`, uses Claude to generate a coach-friendly title + summary with label prefix, posts to `#releasebotreview` for approval. Reviewer edits and posts to a chosen channel, or rejects.

## Flow
1. Message posted in `#releases` (deploy bot success OR human post with image/Linear URL)
2. `/api/slack/events` → extracts ticket IDs → filters out already-released tickets (via engcal) → looks up Linear (including labels) → calls Claude → posts review card with **Edit & Post** / **Reject** buttons
3. Title is prefixed with label emoji: 🐛 Bug Fix / ✨ New Feature / 🔧 Improvement
4. **Edit & Post**: opens modal with channel picker (AC / IS / CAM / support-ops), rich text title + message (emoji support), file picker (photos + videos, up to 3)
5. Reviewer picks channel, edits, submits → posts to chosen channel, updates review card to ✅, updates engcal release date
6. **Reject**: updates review card to ❌

## Trigger conditions
- **Deploy bot success**: GitHub Actions run URL in message → extracts ticket IDs from commits between current and previous run
- **Human post**: image/file share in `#releases` → Claude vision extracts ticket IDs from screenshot, OR Linear URLs in text

## Duplicate prevention
- Slack retries filtered via `x-slack-retry-num` header
- Deploy re-runs detected by comparing run IDs (not SHAs) — same master SHA = no new tickets
- Tickets already in engcal with a `releaseDate` are skipped before posting review cards
- Debug messages posted to `#releasebotreview` when tickets are skipped

## Routes
- `POST /api/slack/events` — handles incoming Slack messages + URL verification
- `POST /api/slack/actions` — handles button clicks (opens modal) + modal submissions
- `GET/POST /api/post-cards` — manually trigger review cards for specific ticket IDs

## Target channels
- `#assistant-coaches` — `ASSISTANT_COACHES_CHANNEL_ID` (`C03T016QKUJ`)
- `#inside-sales` — `INSIDE_SALES_CHANNEL_ID` (`C046LEL8HJ6`)
- `#cam-division` — `CAM_CHANNEL_ID` (`C087FM68UA2`)
- `#support-ops` — `SUPPORT_OPS_CHANNEL_ID` (`C09KCRW3Y6S`)

## Thread reply routing
Replies to bot posts in AC, IS, CAM, support-ops channels are DM'd to Aimee (U04FC4WGZ8U / `NOTIFY_SLACK_ID`). Checks parent message is from a bot before DMing.

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
- `CAM_CHANNEL_ID` — `C087FM68UA2` (#cam-division)
- `SUPPORT_OPS_CHANNEL_ID` — `C09KCRW3Y6S`
- `ENGCAL_SECRET` — `engcal-secret-2026`
- `NOTIFY_SLACK_ID` — `U04FC4WGZ8U` (Aimee, for thread reply DMs)
- `ENGCAL_APP_ID` — InstantDB app ID for engcal
- `ENGCAL_ADMIN_TOKEN` — InstantDB admin token for engcal

## Status
- ✅ Live on #releases (deploy bot + human posts)
- ✅ Posts to #assistant-coaches, #inside-sales, #cam-division, #support-ops
- ✅ Edit modal with channel picker (4 channels), rich text, emoji, file uploads
- ✅ Label emoji prefix on titles (🐛 / ✨ / 🔧)
- ✅ Engcal release dates updated on approval
- ✅ Bot icon + description set in Slack app settings
- ✅ Duplicate prevention: retry header, re-run SHA check, engcal releaseDate filter
- ✅ Thread reply DMs to Aimee for replies in AC/IS/CAM/support-ops
- ✅ Manual card trigger via `post S2-XXXX` in #releasebotreview
- ✅ Ticket lookup: "was S2-XXXX released?" in #releasebotreview
