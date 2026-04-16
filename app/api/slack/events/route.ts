import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { WebClient } from "@slack/web-api";
import Anthropic from "@anthropic-ai/sdk";
import { verifySlackSignature } from "@/lib/slack";

export const maxDuration = 60;

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TICKET_ID_REGEX = /\b([A-Z][A-Z0-9]+-\d+)\b/g;

// Fallback repo map if URL isn't in the Slack message
const GITHUB_REPOS: Record<string, string> = {
  mobile: "Fitmoola/system2-mobile-react-native",
  functions: "Fitmoola/system2-server",
  server: "Fitmoola/system2-server",
  web: "Fitmoola/system2-web",
};

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-slack-signature") ?? "";
  const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";

  if (!verifySlackSignature(rawBody, signature, timestamp)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Handle Slack URL verification challenge
  if (body.type === "url_verification") {
    return NextResponse.json({ challenge: body.challenge });
  }

  const event = body.event;

  // Only process messages from #releases channel
  const releasesChannelId = process.env.RELEASES_CHANNEL_ID || "C028K3WGYV7";
  if (!event || event.type !== "message" || event.channel !== releasesChannelId) {
    return NextResponse.json({ ok: true });
  }

  // Build searchable text from both event.text and any attachments
  // (System2 Deploy Bot puts content in attachments, not event.text)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const attachmentText = (event.attachments ?? []).map((a: any) => `${a.text ?? ""} ${a.fallback ?? ""} ${a.pretext ?? ""}`).join(" ");
  const fullText = `${event.text ?? ""} ${attachmentText}`.toLowerCase();

  // DEBUG: post raw event info to review channel
  if (process.env.REVIEW_CHANNEL_ID) {
    waitUntil(slack.chat.postMessage({
      channel: process.env.REVIEW_CHANNEL_ID,
      text: `🔍 #releases event | bot_id: \`${event.bot_id ?? "none"}\` | subtype: \`${event.subtype ?? "none"}\` | fullText: ${fullText.slice(0, 200)}`
    }));
  }

  // Skip message_changed/deleted subtypes — allow file_share (human posts image)
  if (event.subtype && event.subtype !== "bot_message" && event.subtype !== "file_share") {
    return NextResponse.json({ ok: true });
  }

  // Trigger on:
  // 1. Deploy bot: bot message with "success" + "production"
  // 2. Human message: mentions "production" (may include image of commits)
  const isDeployBot = (event.bot_id || event.subtype === "bot_message") &&
    fullText.includes("success") &&
    fullText.includes("production");

  const isHumanRelease = !event.bot_id &&
    fullText.includes("production") &&
    (fullText.includes("linear.app") || event.files?.length > 0 || event.subtype === "file_share");

  if (!isDeployBot && !isHumanRelease) {
    return NextResponse.json({ ok: true });
  }

  // Respond to Slack immediately (must be within 3 seconds)
  waitUntil(processRelease(event, fullText, isHumanRelease));
  return NextResponse.json({ ok: true });
}

async function getTicketsFromGitHub(fullText: string, attachText: string): Promise<string[]> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN not set");

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  // Extract repo and run ID directly from the GitHub Actions URL in the Slack message
  // e.g. https://github.com/fitmoola/system2-web/actions/runs/242064
  const urlMatch = fullText.match(/github\.com\/([\w-]+\/[\w-]+)\/actions\/runs\/(\d+)/i);

  let repo: string;
  let currentRunId: string;

  if (urlMatch) {
    repo = urlMatch[1]; // e.g. "fitmoola/system2-web"
    currentRunId = urlMatch[2];
  } else {
    // Fallback: map from attachment text keywords
    const project = attachText.includes("mobile") ? "mobile"
      : attachText.includes("function") ? "functions"
      : attachText.includes("server") ? "server"
      : "web";
    repo = GITHUB_REPOS[project];
    currentRunId = "";
  }

  // Get current run's SHA and workflow ID
  let currentSha: string;
  let workflowId: number;

  if (currentRunId) {
    const runRes = await fetch(`https://api.github.com/repos/${repo}/actions/runs/${currentRunId}`, { headers });
    if (!runRes.ok) throw new Error(`GitHub run fetch error: ${runRes.status} for run ${currentRunId}`);
    const run = await runRes.json();
    currentSha = run.head_sha;
    workflowId = run.workflow_id;
  } else {
    throw new Error("Could not determine GitHub Actions run from Slack message");
  }

  // Find the previous successful run of the same workflow
  const runsRes = await fetch(
    `https://api.github.com/repos/${repo}/actions/runs?workflow_id=${workflowId}&status=success&per_page=10`,
    { headers }
  );
  if (!runsRes.ok) throw new Error(`GitHub runs list error: ${runsRes.status}`);
  const runsData = await runsRes.json();

  // Find a run older than the current one
  const prevRun = (runsData.workflow_runs ?? []).find(
    (r: { id: number; head_sha: string }) => r.id !== parseInt(currentRunId) && r.head_sha !== currentSha
  );
  if (!prevRun) throw new Error(`No previous successful run found for workflow ${workflowId}`);

  const prevSha: string = prevRun.head_sha;

  // The production branch uses merge commits ("Merge branch 'master' into production").
  // The actual feature commits with ticket IDs live on master, not production.
  // Get the master SHA from each merge commit's second parent, then compare those.
  async function getMasterSha(sha: string): Promise<string> {
    const res = await fetch(`https://api.github.com/repos/${repo}/commits/${sha}`, { headers });
    if (!res.ok) return sha;
    const data = await res.json();
    // Merge commit: parents[0] = prev production HEAD, parents[1] = master HEAD
    return data.parents?.length >= 2 ? data.parents[1].sha : sha;
  }

  const [currentMasterSha, prevMasterSha] = await Promise.all([
    getMasterSha(currentSha),
    getMasterSha(prevSha),
  ]);

  // Compare master commits between the two deploys
  const compareRes = await fetch(
    `https://api.github.com/repos/${repo}/compare/${prevMasterSha}...${currentMasterSha}`,
    { headers }
  );
  if (!compareRes.ok) throw new Error(`GitHub compare error: ${compareRes.status}`);
  const compareData = await compareRes.json();

  // Extract ticket IDs from commit messages
  const ticketIds = new Set<string>();
  const commitMessages: string[] = [];
  for (const commit of compareData.commits ?? []) {
    const message: string = commit.commit?.message ?? "";
    commitMessages.push(message.split("\n")[0].slice(0, 80)); // first line only for debug
    for (const match of message.matchAll(TICKET_ID_REGEX)) {
      ticketIds.add(match[1]);
    }
  }

  // Debug: log commit messages so we can see the format
  if (process.env.REVIEW_CHANNEL_ID) {
    const s = new WebClient(process.env.SLACK_BOT_TOKEN);
    await s.chat.postMessage({
      channel: process.env.REVIEW_CHANNEL_ID,
      text: `🔍 Commits (${commitMessages.length}): ${commitMessages.slice(0, 5).map(m => `\`${m}\``).join(" | ")}`
    });
  }

  return [...ticketIds];
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const TICKET_ID_EXACT = /^[A-Z][A-Z0-9]+-\d+$/;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function extractTicketsFromImage(event: any): Promise<string[]> {
  // Find image file attached to this message or recent messages
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let file = event.files?.find((f: any) => f.mimetype?.startsWith("image/"));
  if (!file) {
    // Check channel history for nearby human message with image
    const releasesChannelId = process.env.RELEASES_CHANNEL_ID || "C028K3WGYV7";
    const history = await slack.conversations.history({
      channel: releasesChannelId,
      latest: event.ts,
      limit: 5,
      inclusive: true,
    });
    const msgWithImage = history.messages?.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (m: any) => m.files?.some((f: any) => f.mimetype?.startsWith("image/"))
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    file = msgWithImage?.files?.find((f: any) => f.mimetype?.startsWith("image/"));
  }
  if (!file?.url_private) return [];

  const res = await fetch(file.url_private, {
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }
  });
  if (!res.ok) return [];
  const buffer = await res.arrayBuffer();
  if (buffer.byteLength > MAX_IMAGE_BYTES) return [];

  const imageBase64 = Buffer.from(buffer).toString("base64");
  const imageMediaType = (file.mimetype as "image/png" | "image/jpeg" | "image/gif" | "image/webp") ?? "image/png";

  const extractResponse = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 200,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: imageMediaType, data: imageBase64 } },
        { type: "text", text: "Extract all Linear ticket IDs from this image (format like S2-1234 or AB-123). Return only a JSON array of strings, e.g. [\"S2-1234\", \"S2-5678\"]. If none found, return []." }
      ]
    }]
  });

  const text = extractResponse.content[0].type === "text" ? extractResponse.content[0].text : "[]";
  try {
    const match = text.match(/\[[\s\S]*\]/);
    const parsed = JSON.parse(match ? match[0] : text);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string" && TICKET_ID_EXACT.test(id))
      : [];
  } catch {
    return [];
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function processRelease(event: any, fullText: string, isHumanRelease = false) {
  const debugPost = async (msg: string) => {
    if (process.env.REVIEW_CHANNEL_ID) {
      const s = new WebClient(process.env.SLACK_BOT_TOKEN);
      await s.chat.postMessage({ channel: process.env.REVIEW_CHANNEL_ID, text: msg });
    }
  };

  try {
    // Detect project from deploy bot text
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const attachText = (event.attachments ?? []).map((a: any) => `${a.text ?? ""} ${a.fallback ?? ""}`).join(" ").toLowerCase();
    const project = attachText.includes("mobile") ? "mobile"
      : attachText.includes("function") ? "functions"
      : attachText.includes("server") ? "server"
      : "web";

    // Extract ticket IDs — image (human) or GitHub commits (deploy bot)
    let ticketIds: string[] = [];
    try {
      if (isHumanRelease) {
        // Try image extraction first (Santiago posts screenshots of commit list)
        ticketIds = await extractTicketsFromImage(event);
        if (ticketIds.length > 0) {
          await debugPost(`🔍 Human release | ticketIds from image: ${JSON.stringify(ticketIds)}`);
        } else {
          // Fall back to Linear URLs in message text
          const linearMatches = [...fullText.matchAll(/linear\.app\/[^/]+\/issue\/([a-z][a-z0-9]+-\d+)/gi)];
          ticketIds = [...new Set(linearMatches.map(m => m[1].toUpperCase()))];
          await debugPost(`🔍 Human release | ticketIds from Linear URLs: ${JSON.stringify(ticketIds)}`);
        }
      } else {
        ticketIds = await getTicketsFromGitHub(fullText, attachText);
        await debugPost(`🔍 GitHub commits | project: ${project} | ticketIds: ${JSON.stringify(ticketIds)}`);
      }
    } catch (err) {
      await debugPost(`❌ Extraction error: ${String(err).slice(0, 200)}`);
      return;
    }

    if (ticketIds.length === 0) {
      await debugPost(`⚠️ No ticket IDs found in commit messages for project: ${project}`);
      return;
    }

    // Look up tickets in Linear
    const linearRes = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": process.env.LINEAR_API_KEY!
      },
      body: JSON.stringify({
        query: `{
          issues(filter: { number: { in: ${JSON.stringify(ticketIds.map((id: string) => parseInt(id.split("-")[1])))} } }) {
            nodes {
              identifier
              title
              description
              startedAt
              history(first: 50) {
                nodes {
                  createdAt
                  toState { name }
                }
              }
            }
          }
        }`
      })
    });
    if (!linearRes.ok) throw new Error(`Linear API error: ${linearRes.status}`);
    const linearData = await linearRes.json();
    const issues: {
      identifier: string;
      title: string;
      description?: string;
      startedAt?: string;
      history?: { nodes: { createdAt: string; toState?: { name: string } }[] };
    }[] = linearData?.data?.issues?.nodes ?? [];

    await debugPost(`🔍 Linear lookup | found ${issues.length} issue(s): ${issues.map(i => i.identifier).join(", ") || "none"}`);

    if (issues.length === 0) return;

    // Push to engcal
    if (process.env.ENGCAL_URL && process.env.ENGCAL_SECRET) {
      await fetch(`${process.env.ENGCAL_URL}/api/add-release`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secret: process.env.ENGCAL_SECRET,
          releaseDate: Date.now(),
          releases: issues.map(i => {
            const inReviewEntry = i.history?.nodes.find(
              h => h.toState?.name?.toLowerCase().includes("in review")
            );
            return {
              ticketId: i.identifier,
              title: i.title,
              project,
              ...(i.startedAt ? { startDate: new Date(i.startedAt).getTime() } : {}),
              ...(inReviewEntry ? { demoDate: new Date(inReviewEntry.createdAt).getTime() } : {}),
            };
          }),
        }),
      }).catch(err => console.error("engcal push failed:", err));
    }

    // Post one review card per ticket
    for (const issue of issues) {
      const linearContext = `${issue.identifier}: ${issue.title}${issue.description ? ` — ${issue.description.slice(0, 200)}` : ""}`;
      await postReviewCard({ issue, linearContext });
    }

  } catch (err) {
    await debugPost(`❌ processRelease error: ${String(err).slice(0, 200)}`);
    console.error("processRelease error:", err);
  }
}

async function postReviewCard({
  issue,
  linearContext,
}: {
  issue: { identifier: string; title: string; description?: string } | null;
  linearContext: string;
}) {
  let title = issue ? issue.title : "New Release";
  let summary = linearContext;

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      messages: [{
        role: "user",
        content: `You are summarizing a software release note for assistant coaches at a fitness coaching company called Avida.
${linearContext ? `\nLinear ticket details:\n${linearContext}` : ""}

Generate a clean title (5–8 words, no technical jargon or ticket numbers) and a 1–2 sentence plain English summary that an assistant coach would understand and find relevant.

Respond only with JSON: {"title": "...", "summary": "..."}`
      }]
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
    if (typeof parsed.title === "string" && typeof parsed.summary === "string") {
      title = parsed.title;
      summary = parsed.summary;
    }
  } catch (err) {
    console.error("Claude summary failed:", err);
  }

  const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);

  await slackClient.chat.postMessage({
    channel: process.env.REVIEW_CHANNEL_ID!,
    text: `New release pending approval: ${title}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*📣 New release pending approval*\n\n*${title}*\n\n${summary}`
        }
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "✏️ Edit & Post" },
            style: "primary",
            action_id: "approve_release",
            value: JSON.stringify({ title, summary })
          },
          {
            type: "button",
            text: { type: "plain_text", text: "❌ Reject" },
            style: "danger",
            action_id: "reject_release",
            value: "reject"
          }
        ]
      }
    ]
  });

  console.log("Posted to review channel:", title);
}
