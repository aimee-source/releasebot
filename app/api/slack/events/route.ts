import { NextRequest, NextResponse } from "next/server";
import { WebClient } from "@slack/web-api";
import Anthropic from "@anthropic-ai/sdk";
import { verifySlackSignature } from "@/lib/slack";

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TICKET_ID_REGEX = /^[A-Z][A-Z0-9]+-\d+$/;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB

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
  if (!event || event.type !== "message" || event.channel !== process.env.RELEASES_CHANNEL_ID) {
    return NextResponse.json({ ok: true });
  }

  console.log("releases event:", JSON.stringify({ bot_id: event.bot_id, text: event.text, subtype: event.subtype }));

  // Only trigger on successful production deployments from the deploy bot
  const isProductionSuccess = event.bot_id &&
    event.text?.includes("Success") &&
    event.text?.includes("production");

  if (!isProductionSuccess) {
    return NextResponse.json({ ok: true });
  }

  // Fetch recent channel history to find the human release message + image
  let humanMessageText = "";
  let imageBase64: string | null = null;
  let imageMediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp" = "image/png";

  try {
    const history = await slack.conversations.history({
      channel: process.env.RELEASES_CHANNEL_ID!,
      latest: event.ts,
      limit: 20
    });
    const humanMessage = history.messages?.find(m => !m.bot_id && m.type === "message");
    humanMessageText = humanMessage?.text ?? "";

    // Download the first image attachment if present
    const file = humanMessage?.files?.[0];
    if (file?.url_private && file.mimetype?.startsWith("image/")) {
      const res = await fetch(file.url_private, {
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }
      });
      if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
      const contentLength = parseInt(res.headers.get("content-length") || "0");
      if (contentLength > MAX_IMAGE_BYTES) throw new Error("Image too large");
      const buffer = await res.arrayBuffer();
      if (buffer.byteLength > MAX_IMAGE_BYTES) throw new Error("Image exceeds size limit");
      imageBase64 = Buffer.from(buffer).toString("base64");
      imageMediaType = (file.mimetype as typeof imageMediaType) ?? "image/png";
    }
  } catch {
    // proceed without it
  }

  // Extract Linear ticket IDs from the image using Claude
  let linearContext = "";
  if (imageBase64) {
    try {
      const extractResponse = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: imageMediaType, data: imageBase64 } },
            { type: "text", text: "Extract all Linear ticket IDs from this image (format like S2-1234). Return only a JSON array of strings, e.g. [\"S2-1234\", \"S2-5678\"]. If none found, return []." }
          ]
        }]
      });

      const extractText = extractResponse.content[0].type === "text" ? extractResponse.content[0].text : "[]";
      let ticketIds: string[] = [];
      try {
        const parsed = JSON.parse(extractText);
        ticketIds = Array.isArray(parsed)
          ? parsed.filter((id): id is string => typeof id === "string" && TICKET_ID_REGEX.test(id))
          : [];
      } catch {
        // no valid ticket IDs
      }

      if (ticketIds.length > 0) {
        const linearRes = await fetch("https://api.linear.app/graphql", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": process.env.LINEAR_API_KEY!
          },
          body: JSON.stringify({
            query: `{ issues(filter: { identifier: { in: ${JSON.stringify(ticketIds)} } }) { nodes { identifier title description } } }`
          })
        });
        if (!linearRes.ok) throw new Error(`Linear API error: ${linearRes.status}`);
        const linearData = await linearRes.json();
        const issues = linearData?.data?.issues?.nodes ?? [];
        if (issues.length > 0) {
          linearContext = issues.map((i: { identifier: string; title: string; description?: string }) =>
            `${i.identifier}: ${i.title}${i.description ? ` — ${i.description.slice(0, 200)}` : ""}`
          ).join("\n");
        }
      }
    } catch {
      // proceed without Linear context
    }
  }

  // Use Claude to generate a clean title and coach-friendly summary
  let title = "New Release";
  let summary = humanMessageText || (event.text ?? "");

  try {
    const userContent: Anthropic.MessageParam["content"] = [];

    if (imageBase64) {
      userContent.push({
        type: "image",
        source: { type: "base64", media_type: imageMediaType, data: imageBase64 }
      });
    }

    userContent.push({
      type: "text",
      text: `You are summarizing a software release note for assistant coaches at a fitness coaching company called Avida.
${humanMessageText ? `\nRelease note text: ${humanMessageText}` : ""}
${imageBase64 ? "\nThe image above shows the release details (commit list, features, fixes)." : ""}
${linearContext ? `\nLinear ticket details:\n${linearContext}` : ""}

Generate a clean title (5–8 words, no technical jargon or ticket numbers) and a 1–2 sentence plain English summary that an assistant coach would understand and find relevant.

Respond only with JSON: {"title": "...", "summary": "..."}`
    });

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      messages: [{ role: "user", content: userContent }]
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    // Extract JSON even if Claude wraps it in markdown code blocks
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
    if (typeof parsed.title === "string" && typeof parsed.summary === "string") {
      title = parsed.title;
      summary = parsed.summary;
    }
  } catch (err) {
    console.error("Claude parsing failed:", err);
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

  return NextResponse.json({ ok: true });
}
