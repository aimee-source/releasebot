import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { WebClient } from "@slack/web-api";
import { verifySlackSignature } from "@/lib/slack";

export const maxDuration = 60;

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-slack-signature") ?? "";
  const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";

  if (!verifySlackSignature(rawBody, signature, timestamp)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload;
  try {
    const params = new URLSearchParams(rawBody);
    payload = JSON.parse(params.get("payload") ?? "{}");
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  console.log("actions payload type:", payload.type, "action_id:", payload.actions?.[0]?.action_id, "callback_id:", payload.view?.callback_id);

  try {
    // Handle modal submission
    if (payload.type === "view_submission" && payload.view?.callback_id === "approve_modal") {
      const title = payload.view?.state?.values?.title_block?.title_input?.value;
      const summary = payload.view?.state?.values?.summary_block?.summary_input?.value;
      if (typeof title !== "string" || typeof summary !== "string") {
        return NextResponse.json({ error: "Missing form fields" }, { status: 400 });
      }

      // Optional image URLs (filter out empty/blank)
      const imageUrl1 = payload.view?.state?.values?.image1_block?.image1_input?.value?.trim() || null;
      const imageUrl2 = payload.view?.state?.values?.image2_block?.image2_input?.value?.trim() || null;
      const imageUrls = [imageUrl1, imageUrl2].filter((u): u is string => !!u);

      let metadata;
      try {
        metadata = JSON.parse(payload.view.private_metadata);
        if (!metadata.channelId || !metadata.messageTs) throw new Error("Invalid metadata");
      } catch {
        return NextResponse.json({ error: "Invalid form state" }, { status: 400 });
      }
      const { channelId, messageTs } = metadata;

      // Build blocks for the post
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const postBlocks: any[] = [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*${title}*\n\n${summary}`
          }
        }
      ];

      for (const url of imageUrls) {
        postBlocks.push({
          type: "image",
          image_url: url,
          alt_text: title
        });
      }

      // Respond immediately to close the modal (Slack requires response within 3s)
      // Do the actual posting in the background
      waitUntil((async () => {
        await slack.chat.postMessage({
          channel: process.env.ASSISTANT_COACHES_CHANNEL_ID!,
          text: `${title} — ${summary}`,
          blocks: postBlocks
        });
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
      })());

      return NextResponse.json({});
    }

    const action = payload.actions?.[0];
    const channelId: string = payload.container?.channel_id;
    const messageTs: string = payload.container?.message_ts;

    if (action?.action_id === "approve_release") {
      const { title, summary } = JSON.parse(action.value);

      await slack.views.open({
        trigger_id: payload.trigger_id,
        view: {
          type: "modal",
          callback_id: "approve_modal",
          title: { type: "plain_text", text: "Edit & Post Release" },
          submit: { type: "plain_text", text: "Post to #assistant-coaches" },
          close: { type: "plain_text", text: "Cancel" },
          private_metadata: JSON.stringify({ channelId, messageTs }),
          blocks: [
            {
              type: "input",
              block_id: "title_block",
              element: {
                type: "plain_text_input",
                action_id: "title_input",
                initial_value: title
              },
              label: { type: "plain_text", text: "Title" }
            },
            {
              type: "input",
              block_id: "summary_block",
              element: {
                type: "plain_text_input",
                action_id: "summary_input",
                multiline: true,
                initial_value: summary
              },
              label: { type: "plain_text", text: "Message" }
            },
            {
              type: "input",
              block_id: "image1_block",
              optional: true,
              element: {
                type: "plain_text_input",
                action_id: "image1_input",
                placeholder: { type: "plain_text", text: "Paste image URL (optional)" }
              },
              label: { type: "plain_text", text: "Photo 1 (optional)" }
            },
            {
              type: "input",
              block_id: "image2_block",
              optional: true,
              element: {
                type: "plain_text_input",
                action_id: "image2_input",
                placeholder: { type: "plain_text", text: "Paste image URL (optional)" }
              },
              label: { type: "plain_text", text: "Photo 2 (optional)" }
            }
          ]
        }
      });

    } else if (action?.action_id === "reject_release") {
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
  } catch (err) {
    console.error("Slack action error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
