import { NextRequest, NextResponse } from "next/server";
import { WebClient } from "@slack/web-api";
import { verifySlackSignature } from "@/lib/slack";

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-slack-signature") ?? "";
  const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";

  if (!verifySlackSignature(rawBody, signature, timestamp)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const params = new URLSearchParams(rawBody);
  const payload = JSON.parse(params.get("payload") ?? "{}");

  const action = payload.actions?.[0];
  const channelId: string = payload.container?.channel_id;
  const messageTs: string = payload.container?.message_ts;

  if (action?.action_id === "approve_release") {
    const { title, summary } = JSON.parse(action.value);

    // Post clean formatted message to #assistant-coaches
    await slack.chat.postMessage({
      channel: process.env.ASSISTANT_COACHES_CHANNEL_ID!,
      text: `${title} — ${summary}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*${title}*\n\n${summary}`
          }
        }
      ]
    });

    // Update the approval DM to show it was posted
    await slack.chat.update({
      channel: channelId,
      ts: messageTs,
      text: `✅ Posted to #assistant-coaches`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `✅ *Posted to #assistant-coaches*\n\n*${title}*\n\n${summary}`
          }
        }
      ]
    });

  } else if (action?.action_id === "reject_release") {
    // Update the approval DM to show it was rejected
    await slack.chat.update({
      channel: channelId,
      ts: messageTs,
      text: "❌ Release rejected",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "❌ *Release rejected — not posted*"
          }
        }
      ]
    });
  }

  return NextResponse.json({ ok: true });
}
