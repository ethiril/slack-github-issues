export async function fetchThreadMessages(client, channelId, threadTs) {
  const result = await client.conversations.replies({
    channel: channelId,
    ts: threadTs,
    limit: 100,
  }).catch(() => null);
  return result?.messages ?? [];
}

export function compileThread(messages) {
  if (messages.length === 0) return "";
  const lines = messages
    .map((msg) => (msg.text ?? "").replace(/\n/g, "\n> "))
    .filter(Boolean)
    .map((text) => `> ${text}`);
  return "**Full thread:**\n\n" + lines.join("\n>\n");
}

function formatSlackTimestamp(slackTs) {
  const date = new Date(parseFloat(slackTs) * 1000);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const hours = date.getHours();
  const ampm = hours >= 12 ? "PM" : "AM";
  const hours12 = hours % 12 || 12;
  return `${months[date.getMonth()]} ${date.getDate()} at ${hours12}:${String(date.getMinutes()).padStart(2, "0")} ${ampm}`;
}

async function resolveMessageDisplayName(client, userCache, message) {
  const embeddedDisplayName =
    message?.user_profile?.display_name ||
    message?.user_profile?.display_name_normalized ||
    message?.user_profile?.real_name ||
    message?.profile?.display_name ||
    message?.profile?.display_name_normalized ||
    message?.profile?.real_name ||
    message?.bot_profile?.name ||
    message?.username ||
    null;

  if (embeddedDisplayName) return embeddedDisplayName;

  const userId = message?.user;
  if (!userId) return "Unknown";
  if (userCache.has(userId)) return userCache.get(userId);

  const displayNamePromise = client.users.info({ user: userId })
    .then((result) => {
      const displayName =
        result?.user?.profile?.display_name ||
        result?.user?.profile?.display_name_normalized ||
        result?.user?.profile?.real_name ||
        result?.user?.real_name ||
        result?.user?.name ||
        userId;
      console.log("[thread] resolved Slack user", { userId, resolved: displayName });
      return displayName;
    })
    .catch((err) => {
      console.warn("[thread] users.info failed", {
        userId,
        message: err?.data?.error || err?.message || String(err),
      });
      return userId;
    });

  userCache.set(userId, displayNamePromise);
  return displayNamePromise;
}

async function decodeSlackText(text, userCache, client) {
  const names = new Map();
  for (const [, userId, inlineName] of text.matchAll(/<@(U[A-Z0-9]+)(?:\|([^>]*))?>/g)) {
    if (inlineName) {
      names.set(userId, inlineName);
    } else if (!names.has(userId)) {
      names.set(userId, await resolveMessageDisplayName(client, userCache, { user: userId }));
    }
  }

  return text
    .replace(/<@(U[A-Z0-9]+)(?:\|([^>]*))?>/g, (_, userId, inlineName) =>
      `@${inlineName ?? names.get(userId) ?? userId}`
    )
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<!here>/g, "@here")
    .replace(/<!channel>/g, "@channel")
    .replace(/<!everyone>/g, "@everyone")
    .replace(/<https?:\/\/[^|>]+\|([^>]+)>/g, "$1")
    .replace(/<(https?:\/\/[^>]+)>/g, "$1");
}

// Options:
//   sinceTs — only include messages newer than this Slack ts (tag update flow)
export async function compileThreadWithMeta(client, messages, { sinceTs } = {}) {
  const filteredMessages = sinceTs
    ? messages.filter((message) => parseFloat(message.ts) > parseFloat(sinceTs))
    : messages;

  if (filteredMessages.length === 0) return "";

  const userCache = new Map();

  const parts = await Promise.all(
    filteredMessages.map(async (message) => {
      // file_share messages carry the filename as message.text — suppress it since
      // we render the actual file as a link below.
      const rawText = message.subtype === "file_share" ? "" : (message.text ?? "").trim();
      const text = rawText ? await decodeSlackText(rawText, userCache, client) : "";

      // Slack stores file attachments in message.files (plural, newer) or message.file
      // (singular, older / file_share subtype). Normalise to a single array.
      const allFiles = [
        ...(Array.isArray(message.files) ? message.files : []),
        ...(message.file ? [message.file] : []),
      ];

      const imageLinks = allFiles
        .filter((file) => file.mimetype?.startsWith("image/"))
        .map((file) => `[${file.name ?? "image"}](${file.permalink ?? ""})`);

      if (!text && imageLinks.length === 0) return null;

      const author = await resolveMessageDisplayName(client, userCache, message);
      const timestamp = formatSlackTimestamp(message.ts);

      const quotedLines = [];
      if (text) quotedLines.push(`> ${text.replace(/\n/g, "\n> ")}`);
      imageLinks.forEach((imageLink) => quotedLines.push(`> ${imageLink}`));

      return `**${author}** · ${timestamp}\n${quotedLines.join("\n")}`;
    })
  );

  const body = parts.filter(Boolean).join("\n\n");
  return body ? `**Full thread:**\n\n${body}` : "";
}

export function deriveTitle(messageText) {
  const firstLine = (messageText ?? "").split("\n")[0].trim();
  if (!firstLine) return "Issue from Slack";
  return firstLine.length <= 80 ? firstLine : firstLine.slice(0, 77) + "...";
}
