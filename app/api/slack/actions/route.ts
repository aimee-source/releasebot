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

      // Files uploaded via file_input
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const uploadedFiles: any[] = payload.view?.state?.values?.photos_block?.photos_input?.files ?? [];

      let metadata;
      try {
        metadata = JSON.parse(payload.view.private_metadata);
        if (!metadata.channelId || !metadata.messageTs) throw new Error("Invalid metadata");
      } catch {
        return NextResponse.json({ error: "Invalid form state" }, { status: 400 });
      }
      const { channelId, messageTs } = metadata;

      // Respond immediately to close the modal (Slack requires response within 3s)
      waitUntil((async () => {
        // Post the text message
        await slack.chat.postMessage({
          channel: process.env.ASSISTANT_COACHES_CHANNEL_ID!,
          text: `${title} — ${summary}`,
          blocks: [
            {
              type: "section",
              text: { type: "mrkdwn", text: `*${title}*\n\n${summary}` }
            }
          ]
        });

        // Upload any attached photos as follow-up messages
        for (const file of uploadedFiles) {
          try {
            const fileRes = await fetch(file.url_private, {
              headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }
            });
            const buffer = Buffer.from(await fileRes.arrayBuffer());
            await slack.filesUploadV2({
              channel_id: process.env.ASSISTANT_COACHES_CHANNEL_ID!,
              file: buffer,
              filename: file.name ?? "image.png",
            });
          } catch (fileErr) {
            console.error("File upload error:", fileErr);
          }
        }

        // Update the review card to show it was posted
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

      try {
        await slack.views.open({
          trigger_id: payload.trigger_id,
          view: {
            type: "modal",
            callback_id: "approve_modal",
            title: { type: "plain_text", text: "Edit & Post Release" },
            submit: { type: "plain_text", text: "Post to Coaches" },
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
                block_id: "photos_block",
                optional: true,
                element: {
                  type: "file_input",
                  action_id: "photos_input",
                  filetypes: ["jpg", "jpeg", "png", "gif", "webp"],
                  max_files: 3
                },
                label: { type: "plain_text", text: "Photos (optional)" }
              }
            ]
          }
        });
      } catch (viewsErr: unknown) {
        const detail = viewsErr && typeof viewsErr === "object" && "data" in viewsErr
          ? JSON.stringify((viewsErr as { data: unknown }).data)
          : String(viewsErr);
        await slack.chat.postMessage({ channel: process.env.REVIEW_CHANNEL_ID!, text: `❌ views.open error: ${detail}` });
        throw viewsErr;
      }

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
