export async function fetchThreadMessages(client, channelId, threadTs) {
  const result = await client.conversations.replies({
    channel: channelId,
    ts: threadTs,
    limit: 100,
  }).catch(() => null);
  return result?.messages ?? [];
}

const _clientIdentityCache = new WeakMap();

// Resolves this bot's own identity (bot_id, user_id) via auth.test, cached per
// client instance. Used to filter out only Butler's own messages from thread
// dumps — other bots (Sentry, PagerDuty, etc.) should still be included.
// Degrades to nulls if auth.test is unavailable (e.g. in tests without mocking).
export async function getOwnBotIdentity(client) {
  if (!client) return { botId: null, userId: null };
  if (_clientIdentityCache.has(client)) return _clientIdentityCache.get(client);
  try {
    if (!client?.auth?.test) return { botId: null, userId: null };
    const result = await client.auth.test();
    const identity = { botId: result?.bot_id ?? null, userId: result?.user_id ?? null };
    if (identity.botId || identity.userId) _clientIdentityCache.set(client, identity);
    return identity;
  } catch {
    return { botId: null, userId: null };
  }
}

function extractBlockText(block) {
  if (!block) return "";
  if ((block.type === "section" || block.type === "header") && block.text?.text) {
    return block.text.text;
  }
  if (block.type === "context") {
    return (block.elements ?? [])
      .map((element) => element.text ?? "")
      .filter(Boolean)
      .join(" ");
  }
  if (block.type === "rich_text") {
    return (block.elements ?? [])
      .flatMap((element) => (element.elements ?? []).map((leaf) => leaf.text ?? ""))
      .filter(Boolean)
      .join("");
  }
  return "";
}

// Slack bot apps (Sentry, PagerDuty, etc.) typically post content in attachments
// or blocks rather than in `message.text`. Falls back through these in priority
// order so dumped threads include the alert body, not just an empty string.
export function extractMessageText(message) {
  if (!message) return "";
  if (message.subtype === "file_share") return "";

  const baseText = (message.text ?? "").trim();
  if (baseText) return baseText;

  const attachmentText = (message.attachments ?? [])
    .map((attachment) => attachment.text || attachment.fallback || attachment.title || "")
    .filter(Boolean)
    .join("\n\n")
    .trim();
  if (attachmentText) return attachmentText;

  return (message.blocks ?? [])
    .map(extractBlockText)
    .filter(Boolean)
    .join("\n\n")
    .trim();
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
  // Exclude only Butler's own messages (its "Issue created" / "Thread update added"
  // confirmations). Other bots like Sentry carry the actual thread context and
  // must be preserved. If auth.test is unavailable, skip filtering entirely.
  const { botId: ownBotId } = await getOwnBotIdentity(client);
  const nonOwnMessages = ownBotId
    ? messages.filter((message) => message.bot_id !== ownBotId)
    : messages;

  const filteredMessages = sinceTs
    ? nonOwnMessages.filter((message) => parseFloat(message.ts) > parseFloat(sinceTs))
    : nonOwnMessages;

  if (filteredMessages.length === 0) return "";

  const userCache = new Map();

  const parts = await Promise.all(
    filteredMessages.map(async (message) => {
      // file_share messages carry the filename as message.text — suppress it since
      // we render the actual file as a link below.
      const rawText = extractMessageText(message);
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
