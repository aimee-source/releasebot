@AGENTS.md

# Releasebot — Claude Context

## What This Project Is
A Next.js Slack bot that listens to `#releases`, generates coach-friendly release summaries using Claude, and routes them to the right team channel after reviewer approval.

Deployed at: Vercel (`aimee-6876s-projects` scope, project `releasebot`)

See `plan.md` for full flow and status.

---

## Tech Stack
- **Framework:** Next.js 15 (App Router)
- **Slack:** `@slack/web-api` WebClient
- **AI:** Anthropic SDK (claude-haiku for summaries + image ticket extraction)
- **Deployment:** Vercel (auto-deploy from `main`)

---

## Project Structure
```
app/api/
  slack/
    events/route.ts   → receives Slack events (messages in #releases)
    actions/route.ts  → handles button clicks + modal submissions
lib/
  slack.ts            → verifySlackSignature helper
```

---

## Key Flow

### events/route.ts
1. Verifies Slack signature
2. Filters to `#releases` channel only (`RELEASES_CHANNEL_ID`)
3. Detects human post: image/file share in `#releases` (deploy bot messages intentionally ignored — caused duplicate review cards)
4. Extracts ticket IDs: image → Claude vision scan, OR Linear URLs in text, OR GitHub commits API
5. Looks up tickets in Linear GraphQL API (including labels)
6. Calls Claude Haiku to generate title + summary
7. Prefixes title with label emoji: 🐛 Bug Fix / ✨ New Feature / 🔧 Improvement (empty prefix if unlabeled)
8. Posts review card to `#releasebotreview` with **Edit & Post** + **Reject** buttons

### actions/route.ts
- `edit_release` button → opens modal with:
  - Radio button channel selector (AC / IS / CAM / support-ops)
  - Rich text title input (emoji support)
  - Rich text message input (emoji support)
  - File input for photos/videos (max 3)
- Modal submission (`edit_modal`):
  - Posts to selected channel as rich_text blocks (bold title)
  - Re-uploads any attached files via `filesUploadV2`
  - Updates review card to ✅
  - Calls engcal `/api/add-release` with ticket ID + current timestamp
- `reject_release` → updates review card to ❌

---

## Slack Block Kit Notes
- Modal submit button max 24 characters
- `rich_text_input` gives emoji autocomplete (not `plain_text_input`)
- `file_input` for native file picker in modals
- `radio_buttons` option values: `"CHANNEL_ID|channel-name"` format
- Post rich_text blocks directly to preserve emoji/formatting in target channel

---

## Linear GraphQL
- Filter by number: `issues(filter: { number: { eq: N } })` — `identifier` is NOT filterable
- Extract number from identifier: `parseInt(identifier.split("-")[1])`

---

## Env Variables

| Variable | Value / Description |
|---|---|
| `SLACK_BOT_TOKEN` | Bot token (xoxb-...) |
| `SLACK_SIGNING_SECRET` | For request verification |
| `ANTHROPIC_API_KEY` | Claude API |
| `LINEAR_API_KEY` | Linear GraphQL API |
| `RELEASES_CHANNEL_ID` | `C028K3WGYV7` (#releases) |
| `REVIEW_CHANNEL_ID` | `C0AN5CB1UH1` (#releasebotreview) |
| `ASSISTANT_COACHES_CHANNEL_ID` | `C03T016QKUJ` |
| `INSIDE_SALES_CHANNEL_ID` | `C046LEL8HJ6` |
| `CAM_CHANNEL_ID` | `C02MZKL6K1A` |
| `SUPPORT_OPS_CHANNEL_ID` | `C09KCRW3Y6S` |
| `ENGCAL_SECRET` | `engcal-secret-2026` |

---

## GitHub & Deployment
- Repo: `https://github.com/aimee-source/releasebot.git`
- Vercel auto-deploys on push to `main`
- Vercel scope: `aimee-6876s-projects`, project: `releasebot`

## Package Manager & Commands
Use `npm`. Node via nvm at `/home/user/.nvm/`.

```bash
. /home/user/.nvm/nvm.sh && npm <command>
```
