import { NextRequest, NextResponse } from "next/server";
import { WebClient } from "@slack/web-api";
import Anthropic from "@anthropic-ai/sdk";
import { verifySlackSignature } from "@/lib/slack";

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-slack-signature") ?? "";
  const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";

  if (!verifySlackSignature(rawBody, signature, timestamp)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const body = JSON.parse(rawBody);

  // Handle Slack URL verification challenge
  if (body.type === "url_verification") {
    return NextResponse.json({ challenge: body.challenge });
  }

  const event = body.event;
  if (!event || event.type !== "message" || event.bot_id || event.subtype) {
    return NextResponse.json({ ok: true });
  }

  // Only process messages from #releases channel
  if (event.channel !== process.env.RELEASES_CHANNEL_ID) {
    return NextResponse.json({ ok: true });
  }

  const messageText: string = event.text ?? "";

  // Use Claude to generate a clean title and coach-friendly summary
  let title = "New Release";
  let summary = messageText;

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      messages: [{
        role: "user",
        content: `You are summarizing a software release note for assistant coaches at a fitness coaching company called Avida.

Release note:
${messageText}

Generate a clean title (5–8 words, no technical jargon or ticket numbers) and a 1–2 sentence plain English summary that an assistant coach would understand and find relevant.

Respond only with JSON: {"title": "...", "summary": "..."}`
      }]
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const parsed = JSON.parse(text);
    title = parsed.title;
    summary = parsed.summary;
  } catch {
    // Fall back to raw text if Claude fails
  }

  // Post to review channel with approve/reject buttons
  await slack.chat.postMessage({
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
            text: { type: "plain_text", text: "✅ Approve & Post" },
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

  return NextResponse.json({ ok: true });
}
