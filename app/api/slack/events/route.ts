import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { WebClient } from "@slack/web-api";
import Anthropic from "@anthropic-ai/sdk";
import { verifySlackSignature } from "@/lib/slack";

export const maxDuration = 60;

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
  // Hardcoded fallback in case env var isn't set
  const releasesChannelId = process.env.RELEASES_CHANNEL_ID || "C028K3WGYV7";
  if (!event || event.type !== "message" || event.channel !== releasesChannelId) {
    return NextResponse.json({ ok: true });
  }

  // Build searchable text from both event.text and any attachments
  // (System2 Deploy Bot puts content in attachments, not event.text)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const attachmentText = (event.attachments ?? []).map((a: any) => `${a.text ?? ""} ${a.fallback ?? ""} ${a.pretext ?? ""}`).join(" ");
  const fullText = `${event.text ?? ""} ${attachmentText}`.toLowerCase();

  // DEBUG: post raw event info to review channel so we can see it without log truncation
  if (process.env.REVIEW_CHANNEL_ID) {
    waitUntil(slack.chat.postMessage({
      channel: process.env.REVIEW_CHANNEL_ID,
      text: `🔍 #releases event | bot_id: \`${event.bot_id ?? "none"}\` | subtype: \`${event.subtype ?? "none"}\` | fullText: ${fullText.slice(0, 200)}`
    }));
  }

  // Only trigger on successful production deployments from the deploy bot
  const isProductionSuccess = (event.bot_id || event.subtype === "bot_message") &&
    fullText.includes("success") &&
    fullText.includes("production");

  if (!isProductionSuccess) {
    return NextResponse.json({ ok: true });
  }

  // Respond to Slack immediately (must be within 3 seconds)
  // All heavy processing happens in the background
  waitUntil(processRelease(event));
  return NextResponse.json({ ok: true });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function processRelease(event: any) {
  try {
    // Fetch recent channel history to find the human release message + image
    let humanMessageText = "";
    let imageBase64: string | null = null;
    let imageMediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp" = "image/png";

    try {
      const releasesChannelId = process.env.RELEASES_CHANNEL_ID || "C028K3WGYV7";
      const history = await slack.conversations.history({
        channel: releasesChannelId,
        latest: event.ts,
        limit: 20,
        inclusive: false,
      });

      console.log("history messages count:", history.messages?.length);

      const humanMessage = history.messages?.find(m => !m.bot_id && m.type === "message");
      humanMessageText = humanMessage?.text ?? "";
      console.log("humanMessageText:", humanMessageText, "files:", humanMessage?.files?.length ?? 0);

      // Download the first image attachment if present
      const file = humanMessage?.files?.[0];
      if (file?.url_private && file.mimetype?.startsWith("image/")) {
        console.log("downloading image:", file.url_private, file.mimetype);
        const res = await fetch(file.url_private, {
          headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }
        });
        if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
        const buffer = await res.arrayBuffer();
        if (buffer.byteLength > MAX_IMAGE_BYTES) throw new Error("Image exceeds size limit");
        imageBase64 = Buffer.from(buffer).toString("base64");
        imageMediaType = (file.mimetype as typeof imageMediaType) ?? "image/png";
        console.log("image downloaded, bytes:", buffer.byteLength);
      }
    } catch (err) {
      console.error("history/image fetch error:", err);
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
              { type: "text", text: "Extract all Linear ticket IDs from this image (format like S2-1234 or AB-123). Return only a JSON array of strings, e.g. [\"S2-1234\", \"S2-5678\"]. If none found, return []." }
            ]
          }]
        });

        const extractText = extractResponse.content[0].type === "text" ? extractResponse.content[0].text : "[]";
        console.log("ticket extract response:", extractText);
        let ticketIds: string[] = [];
        try {
          const arrayMatch = extractText.match(/\[[\s\S]*\]/);
          const parsed = JSON.parse(arrayMatch ? arrayMatch[0] : extractText);
          ticketIds = Array.isArray(parsed)
            ? parsed.filter((id): id is string => typeof id === "string" && TICKET_ID_REGEX.test(id))
            : [];
        } catch {
          // no valid ticket IDs
        }

        console.log("ticketIds:", ticketIds);

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
          console.log("linearContext:", linearContext);
        }
      } catch (err) {
        console.error("Linear/ticket extraction error:", err);
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
      console.log("Claude summary response:", text);
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
      if (typeof parsed.title === "string" && typeof parsed.summary === "string") {
        title = parsed.title;
        summary = parsed.summary;
      }
    } catch (err) {
      console.error("Claude summary failed:", err);
    }

    // Post to review channel with edit/reject buttons
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

    console.log("Posted to review channel:", title);
  } catch (err) {
    console.error("processRelease error:", err);
  }
}
