export async function fetchThreadMessages(client, channelId, threadTs) {
  const result = await client.conversations.replies({
    channel: channelId,
    ts: threadTs,
    limit: 100,
  }).catch(() => null);
  return result?.messages ?? [];
}

// Resolves the message that started a thread (its root/parent), used to seed an
// issue's title and body from the original message rather than whatever message
// happened to be above the tag/reaction. conversations.replies returns messages
// in chronological order with the parent first, so the root is the first message
// that isn't one of Butler's own posts. For a non-threaded message, threadTs is
// the message's own ts and the single returned message is the root.
export async function resolveThreadRootMessage(client, channelId, threadTs) {
  const messages = await fetchThreadMessages(client, channelId, threadTs);
  const { botId } = await getOwnBotIdentity(client);
  const root = messages.find((message) => (botId ? message.bot_id !== botId : true)) ?? messages[0] ?? null;
  return { root, messages };
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
//
// For bot messages specifically we prefer `blocks` over `attachments` / `text`:
// modern alert apps put the full multi-line structured content in blocks and
// only a short one-line summary in `attachments[].fallback`. Using that
// summary as the issue body means the title ends up carrying the whole alert
// and the body is empty. User messages keep the legacy text-first priority so
// mentions/links decoded from `text` are preserved.
export function extractMessageText(message) {
  if (!message) return "";
  if (message.subtype === "file_share") return "";

  const isBot = Boolean(message.bot_id || message.bot_profile || message.subtype === "bot_message");

  const blocksText = (message.blocks ?? [])
    .map(extractBlockText)
    .filter(Boolean)
    .join("\n\n")
    .trim();

  if (isBot && blocksText) return blocksText;

  const baseText = (message.text ?? "").trim();
  if (baseText) return baseText;

  const attachmentText = (message.attachments ?? [])
    .map((attachment) => attachment.text || attachment.fallback || attachment.title || "")
    .filter(Boolean)
    .join("\n\n")
    .trim();
  if (attachmentText) return attachmentText;

  return blocksText;
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

function isBotMessage(message) {
  return Boolean(message?.bot_id || message?.bot_profile || message?.subtype === "bot_message");
}

async function fetchMessagePermalink(client, channel, ts) {
  if (!channel || !client?.chat?.getPermalink) return null;
  const result = await client.chat.getPermalink({ channel, message_ts: ts }).catch(() => null);
  return result?.permalink ?? null;
}

// Options:
//   sinceTs       — only include messages newer than this Slack ts (tag update flow)
//   includeParent — force the thread root (first non-Butler message) into the
//                   output even if sinceTs would otherwise filter it out. Used
//                   on the first tag-update after issue creation so the alert
//                   content that started the thread (e.g. a Sentry message)
//                   gets captured into the ticket.
//   channel       — Slack channel id; when supplied, bot messages with no
//                   extractable content render a placeholder pointing back to
//                   the Slack message via chat.getPermalink.
export async function compileThreadWithMeta(client, messages, { sinceTs, includeParent, channel } = {}) {
  // Exclude only Butler's own messages (its "Issue created" / "Thread update added"
  // confirmations). Other bots like Sentry carry the actual thread context and
  // must be preserved. If auth.test is unavailable, skip filtering entirely.
  const { botId: ownBotId } = await getOwnBotIdentity(client);
  const nonOwnMessages = ownBotId
    ? messages.filter((message) => message.bot_id !== ownBotId)
    : messages;

  let filteredMessages;
  if (sinceTs) {
    filteredMessages = nonOwnMessages.filter((message) => parseFloat(message.ts) > parseFloat(sinceTs));
    if (includeParent && nonOwnMessages[0] && !filteredMessages.some((m) => m.ts === nonOwnMessages[0].ts)) {
      filteredMessages = [nonOwnMessages[0], ...filteredMessages];
    }
  } else {
    filteredMessages = nonOwnMessages;
  }

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

      const author = await resolveMessageDisplayName(client, userCache, message);
      const timestamp = formatSlackTimestamp(message.ts);

      if (!text && imageLinks.length === 0) {
        // Bot apps (Sentry, PagerDuty, …) sometimes post content in block types
        // we don't yet parse. Emit a placeholder pointing back to Slack rather
        // than dropping the message entirely.
        if (!isBotMessage(message)) return null;
        const permalink = await fetchMessagePermalink(client, channel, message.ts);
        const linkText = permalink
          ? `[${author} message — view in Slack](${permalink})`
          : `${author} message`;
        return `**${author}** · ${timestamp}\n> _${linkText}_`;
      }

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

// Parses alert-bot messages (Sentry, PagerDuty, …) into a concise title like
// "[Dev][Sentry] SplitClient is null". Walks the message's blocks to find:
//   - the environment (from a context element matching "environment: <name>")
//   - the error summary (first section whose text is a single backticked code
//     snippet; else first section that isn't a bare Slack URL link)
// Returns null when the message isn't a bot alert, has no blocks, or we can't
// extract an error summary — callers should fall back to deriveTitle().
//
// The source tag reflects bot_profile.name so PagerDuty alerts render as
// "[PagerDuty]", not a hardcoded "[Sentry]". The environment prefix is dropped
// entirely if no environment context is present.
const MAX_ALERT_TITLE_LEN = 150;
const BARE_SLACK_LINK_RE = /^(:[a-z0-9_+-]+:\s*)?<https?:\/\/[^>|]+(?:\|[^>]+)?>\s*$/i;

export function deriveBotAlertTitle(message) {
  if (!message) return null;
  const botName = message?.bot_profile?.name;
  if (!botName) return null;

  const blocks = Array.isArray(message.blocks) ? message.blocks : [];
  if (blocks.length === 0) return null;

  let env = null;
  for (const block of blocks) {
    if (block?.type !== "context") continue;
    for (const element of block.elements ?? []) {
      const match = (element?.text ?? "").match(/environment:\s*`?([A-Za-z0-9_-]+)`?/i);
      if (match) { env = match[1]; break; }
    }
    if (env) break;
  }

  let errorLine = null;
  for (const block of blocks) {
    if (block?.type !== "section") continue;
    const raw = (block?.text?.text ?? "").trim();
    const codeMatch = raw.match(/^`([^`]+)`$/);
    if (codeMatch) { errorLine = codeMatch[1].trim(); break; }
  }

  if (!errorLine) {
    for (const block of blocks) {
      if (block?.type !== "section") continue;
      const raw = (block?.text?.text ?? "").trim();
      if (!raw) continue;
      if (BARE_SLACK_LINK_RE.test(raw)) continue;
      errorLine = raw
        .replace(/<https?:\/\/[^|>]+\|([^>]+)>/g, "$1")
        .replace(/<(https?:\/\/[^>]+)>/g, "$1")
        .replace(/\s+/g, " ")
        .trim();
      break;
    }
  }

  if (!errorLine) return null;

  const envLabel = env ? env[0].toUpperCase() + env.slice(1).toLowerCase() : null;
  const prefix = envLabel ? `[${envLabel}][${botName}] ` : `[${botName}] `;
  const room = Math.max(10, MAX_ALERT_TITLE_LEN - prefix.length);
  const trimmed = errorLine.length > room ? errorLine.slice(0, room - 3) + "..." : errorLine;
  return prefix + trimmed;
}
