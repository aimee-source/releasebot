import { NextRequest, NextResponse } from "next/server";
import { WebClient } from "@slack/web-api";
import Anthropic from "@anthropic-ai/sdk";

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const secret = url.searchParams.get("secret") ?? "";
  const ids = url.searchParams.get("ids") ?? "";
  if (secret !== "post-cards-2026") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const ticketIds = ids.split(",").map(s => s.trim()).filter(Boolean);
  return handlePostCards(ticketIds);
}

export async function POST(request: NextRequest) {
  const { secret, ticketIds } = await request.json();
  if (secret !== process.env.CRON_SECRET && secret !== "post-cards-2026") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!Array.isArray(ticketIds) || ticketIds.length === 0) {
    return NextResponse.json({ error: "ticketIds required" }, { status: 400 });
  }
  return handlePostCards(ticketIds);
}

async function handlePostCards(ticketIds: string[]) {
  if (ticketIds.length === 0) return NextResponse.json({ error: "ticketIds required" }, { status: 400 });

  const numbers = ticketIds.map((id: string) => parseInt(id.split("-")[1])).filter(Boolean);

  const linearRes = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": process.env.LINEAR_API_KEY! },
    body: JSON.stringify({
      query: `{ issues(filter: { number: { in: ${JSON.stringify(numbers)} } }) { nodes { identifier title description labels { nodes { name } } } } }`
    })
  });
  const linearData = await linearRes.json();
  const issues = linearData?.data?.issues?.nodes ?? [];

  for (const issue of issues) {
    const linearContext = `${issue.identifier}: ${issue.title}${issue.description ? ` — ${issue.description.slice(0, 200)}` : ""}`;

    let title = issue.title;
    let summary = linearContext;
    let labelPrefix = "";

    try {
      const response = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        messages: [{
          role: "user",
          content: `You are summarizing a software release note for assistant coaches at a fitness coaching company called Avida.
Linear ticket details:\n${linearContext}

Classify based on title and description (ignore Linear labels):
- "bug_fix" if it fixes a crash, error, or broken behaviour
- "new_feature" if it adds something that didn't exist before
- "improvement" if it enhances something that already existed

Generate a clean title (5–8 words, no technical jargon) and a 1–2 sentence plain English summary an assistant coach would understand.

Respond only with JSON: {"type": "bug_fix|new_feature|improvement", "title": "...", "summary": "..."}`
        }]
      });
      const text = response.content[0].type === "text" ? response.content[0].text : "";
      const parsed = JSON.parse((text.match(/\{[\s\S]*\}/) ?? ["{}"])[0]);
      if (parsed.title && parsed.summary) {
        const typeMap: Record<string, string> = { bug_fix: "🐛 Bug Fix: ", new_feature: "✨ New Feature: ", improvement: "🔧 Improvement: " };
        labelPrefix = typeMap[parsed.type] ?? "";
        title = `${labelPrefix}${parsed.title}`;
        summary = parsed.summary;
      }
    } catch { /* use raw title/summary */ }

    await slack.chat.postMessage({
      channel: process.env.REVIEW_CHANNEL_ID!,
      text: `New release pending approval: ${title}`,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `*📣 New release pending approval*\n\n*${title}*\n\n${summary}` } },
        {
          type: "actions",
          elements: [
            { type: "button", text: { type: "plain_text", text: "✏️ Edit & Post" }, style: "primary", action_id: "edit_release", value: JSON.stringify({ title, summary, ticketId: issue.identifier }) },
            { type: "button", text: { type: "plain_text", text: "❌ Reject" }, style: "danger", action_id: "reject_release", value: "reject" }
          ]
        }
      ]
    });
  }

  return NextResponse.json({ posted: issues.map((i: { identifier: string }) => i.identifier) });
}
