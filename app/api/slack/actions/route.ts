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
    if (payload.type === "view_submission" && payload.view?.callback_id === "edit_modal") {
      const titleRichText = payload.view?.state?.values?.title_block?.title_input?.rich_text_value;
      const summaryRichText = payload.view?.state?.values?.summary_block?.summary_input?.rich_text_value;
      const selectedOption = payload.view?.state?.values?.channel_block?.channel_input?.selected_option;

      if (!titleRichText || !summaryRichText || !selectedOption) {
        return NextResponse.json({ error: "Missing form fields" }, { status: 400 });
      }

      const [targetChannel, targetName] = (selectedOption.value as string).split("|");
      const titlePlain = richTextToPlain(titleRichText);
      const summaryPlain = richTextToPlain(summaryRichText);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const uploadedFiles: any[] = payload.view?.state?.values?.photos_block?.photos_input?.files ?? [];

      let metadata;
      try {
        metadata = JSON.parse(payload.view.private_metadata);
        if (!metadata.channelId || !metadata.messageTs) throw new Error("Invalid metadata");
      } catch {
        return NextResponse.json({ error: "Invalid form state" }, { status: 400 });
      }

      // Respond immediately to close the modal (Slack requires response within 3s)
      waitUntil((async () => {
        // Post the message — bold title as rich_text block, body preserving emojis/formatting
        await slack.chat.postMessage({
          channel: targetChannel,
          text: `${titlePlain} — ${summaryPlain}`,
          blocks: [
            {
              type: "rich_text",
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              elements: (titleRichText.elements ?? []).map((block: any) => ({
                ...block,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                elements: (block.elements ?? []).map((el: any) =>
                  el.type === "text" ? { ...el, style: { ...(el.style ?? {}), bold: true } } : el
                )
              }))
            },
            summaryRichText
          ]
        });

        // Upload any attached photos/videos as follow-up messages
        for (const file of uploadedFiles) {
          try {
            const fileRes = await fetch(file.url_private, {
              headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }
            });
            if (!fileRes.ok) throw new Error(`Download failed: ${fileRes.status}`);
            const buffer = Buffer.from(await fileRes.arrayBuffer());
            await slack.filesUploadV2({
              channel_id: targetChannel,
              file: buffer,
              filename: file.name ?? "image.png",
            });
          } catch (fileErr) {
            await slack.chat.postMessage({ channel: process.env.REVIEW_CHANNEL_ID!, text: `❌ Photo upload error: ${String(fileErr)}` });
          }
        }

        // Update the review card to show it was posted
        await slack.chat.update({
          channel: metadata.channelId,
          ts: metadata.messageTs,
          text: `✅ Posted to #${targetName}`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `✅ *Posted to #${targetName}*\n\n*${titlePlain}*\n\n${summaryPlain}`
              }
            }
          ]
        });

        // Update engcal release date for this ticket
        if (metadata.ticketId && process.env.ENGCAL_SECRET) {
          try {
            await fetch("https://engcal.vercel.app/api/add-release", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                secret: process.env.ENGCAL_SECRET,
                releases: [{ ticketId: metadata.ticketId, releaseDate: Date.now() }]
              })
            });
          } catch (engcalErr) {
            console.error("engcal update failed:", engcalErr);
          }
        }
      })());

      return NextResponse.json({});
    }

    const action = payload.actions?.[0];
    const channelId: string = payload.container?.channel_id;
    const messageTs: string = payload.container?.message_ts;

    if (action?.action_id === "edit_release") {
      const { title, summary, ticketId } = JSON.parse(action.value);

      const channelOptions = [
        { text: { type: "plain_text" as const, text: "#assistant-coaches" }, value: `${process.env.ASSISTANT_COACHES_CHANNEL_ID}|assistant-coaches` },
        { text: { type: "plain_text" as const, text: "#inside-sales" }, value: `${process.env.INSIDE_SALES_CHANNEL_ID}|inside-sales` },
        { text: { type: "plain_text" as const, text: "#cam-cross-functional" }, value: `${process.env.CAM_CHANNEL_ID}|cam-cross-functional` },
        { text: { type: "plain_text" as const, text: "#support-ops" }, value: `${process.env.SUPPORT_OPS_CHANNEL_ID}|support-ops` },
      ];

      try {
        await slack.views.open({
          trigger_id: payload.trigger_id,
          view: {
            type: "modal",
            callback_id: "edit_modal",
            title: { type: "plain_text", text: "Edit & Post Release" },
            submit: { type: "plain_text", text: "Post" },
            close: { type: "plain_text", text: "Cancel" },
            private_metadata: JSON.stringify({ channelId, messageTs, ticketId }),
            blocks: [
              {
                type: "input",
                block_id: "channel_block",
                element: {
                  type: "radio_buttons",
                  action_id: "channel_input",
                  options: channelOptions
                },
                label: { type: "plain_text", text: "Post to" }
              },
              {
                type: "input",
                block_id: "title_block",
                element: {
                  type: "rich_text_input",
                  action_id: "title_input",
                  initial_value: {
                    type: "rich_text",
                    elements: [{ type: "rich_text_section", elements: [{ type: "text", text: title }] }]
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
                    elements: [{ type: "rich_text_section", elements: [{ type: "text", text: summary }] }]
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

    } else if (action?.action_id === "quick_post") {
      const { title, summary, targetChannel, targetName } = JSON.parse(action.value);

      waitUntil((async () => {
        await slack.chat.postMessage({
          channel: targetChannel,
          text: `${title} — ${summary}`,
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: `*${title}*` } },
            { type: "section", text: { type: "mrkdwn", text: summary } }
          ]
        });

        await slack.chat.update({
          channel: channelId,
          ts: messageTs,
          text: `✅ Posted to #${targetName}`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `✅ *Posted to #${targetName}*\n\n*${title}*\n\n${summary}`
              }
            }
          ]
        });
      })());

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
