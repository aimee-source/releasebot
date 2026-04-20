import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { WebClient } from "@slack/web-api";
import { verifySlackSignature } from "@/lib/slack";

export const maxDuration = 60;

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

// Extract plain text from a rich_text block for fallback text
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function richTextToPlain(richText: any): string {
  return (richText?.elements ?? []).flatMap((block: any) =>
    (block.elements ?? []).map((el: any) => {
      if (el.type === "text") return el.text;
      if (el.type === "emoji") return `:${el.name}:`;
      if (el.type === "link") return el.text ?? el.url;
      return "";
    })
  ).join("");
}

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
      const titleRichText = payload.view?.state?.values?.title_block?.title_input?.rich_text_value;
      const summaryRichText = payload.view?.state?.values?.summary_block?.summary_input?.rich_text_value;
      if (!titleRichText || !summaryRichText) {
        return NextResponse.json({ error: "Missing form fields" }, { status: 400 });
      }

      const title = richTextToPlain(titleRichText);
      const summaryPlain = richTextToPlain(summaryRichText);

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
      const { channelId, messageTs, targetChannel: postChannel, targetName: postName } = metadata;
      const destination = postChannel ?? process.env.ASSISTANT_COACHES_CHANNEL_ID!;

      // Respond immediately to close the modal (Slack requires response within 3s)
      waitUntil((async () => {
        // Post the message — bold title as section, rich text body preserving emojis/formatting
        await slack.chat.postMessage({
          channel: destination,
          text: `${title} — ${summaryPlain}`,
          blocks: [
            {
              // Bold the title by adding bold style to all text elements
              type: "rich_text",
              elements: (titleRichText.elements ?? []).map((block: any) => ({
                ...block,
                elements: (block.elements ?? []).map((el: any) =>
                  el.type === "text" ? { ...el, style: { ...(el.style ?? {}), bold: true } } : el
                )
              }))
            },
            summaryRichText
          ]
        });

        // Upload any attached photos as follow-up messages
        for (const file of uploadedFiles) {
          try {
            const fileRes = await fetch(file.url_private, {
              headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }
            });
            if (!fileRes.ok) throw new Error(`Download failed: ${fileRes.status}`);
            const buffer = Buffer.from(await fileRes.arrayBuffer());
            await slack.filesUploadV2({
              channel_id: destination,
              file: buffer,
              filename: file.name ?? "image.png",
            });
          } catch (fileErr) {
            await slack.chat.postMessage({ channel: process.env.REVIEW_CHANNEL_ID!, text: `❌ Photo upload error: ${String(fileErr)}\nfile keys: ${Object.keys(file).join(", ")}` });
          }
        }

        // Update the review card to show it was posted
        await slack.chat.update({
          channel: channelId,
          ts: messageTs,
          text: `✅ Posted to #${postName ?? "assistant-coaches"}`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `✅ *Posted to #${postName ?? "assistant-coaches"}*\n\n*${title}*\n\n${summaryPlain}`
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

    if (action?.action_id === "approve_release" || action?.action_id === "approve_release_is") {
      const { title, summary, targetChannel, targetName } = JSON.parse(action.value);

      try {
        await slack.views.open({
          trigger_id: payload.trigger_id,
          view: {
            type: "modal",
            callback_id: "approve_modal",
            title: { type: "plain_text", text: "Edit & Post Release" },
            submit: { type: "plain_text", text: `→ #${targetName ?? "assistant-coaches"}` },
            close: { type: "plain_text", text: "Cancel" },
            private_metadata: JSON.stringify({ channelId, messageTs, targetChannel, targetName }),
            blocks: [
              {
                type: "input",
                block_id: "title_block",
                element: {
                  type: "rich_text_input",
                  action_id: "title_input",
                  initial_value: {
                    type: "rich_text",
                    elements: [{
                      type: "rich_text_section",
                      elements: [{ type: "text", text: title }]
                    }]
                  }
                },
                label: { type: "plain_text", text: "Title" }
              },
              {
                type: "input",
                block_id: "summary_block",
                element: {
                  type: "rich_text_input",
                  action_id: "summary_input",
                  initial_value: {
                    type: "rich_text",
                    elements: [{
                      type: "rich_text_section",
                      elements: [{ type: "text", text: summary }]
                    }]
                  }
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
                  filetypes: ["jpg", "jpeg", "png", "gif", "webp", "mp4", "mov", "webm"],
                  max_files: 3
                },
                label: { type: "plain_text", text: "Photos & Videos (optional)" }
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
