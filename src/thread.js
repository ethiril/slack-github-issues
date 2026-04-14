// Pure thread utilities (no Slack/GitHub I/O except fetchThreadMessages).

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

// Formats a Slack ts (Unix float string) as "Apr 14 at 3:45 PM" (server local time)
function formatTs(ts) {
  const d = new Date(parseFloat(ts) * 1000);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const h = d.getHours();
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${months[d.getMonth()]} ${d.getDate()} at ${h12}:${String(d.getMinutes()).padStart(2, "0")} ${ampm}`;
}

// Async version of compileThread that enriches each message with the author's
// display name and a formatted timestamp. Pass sinceTs (a Slack ts string) to
// include only messages newer than that timestamp — used for incremental thread
// updates (tag update flow).
export async function compileThreadWithMeta(client, messages, { sinceTs } = {}) {
  const filtered = sinceTs
    ? messages.filter((msg) => parseFloat(msg.ts) > parseFloat(sinceTs))
    : messages;

  if (filtered.length === 0) return "";

  // Cache the Promise itself so concurrent lookups for the same user share
  // a single in-flight API call rather than firing one each.
  const userCache = new Map();
  function resolveDisplayName(userId) {
    if (!userId) return Promise.resolve("Unknown");
    if (userCache.has(userId)) return userCache.get(userId);
    const promise = client.users.info({ user: userId })
      .then((result) =>
        result?.user?.profile?.display_name ||
        result?.user?.real_name ||
        result?.user?.name ||
        userId
      )
      .catch(() => userId);
    userCache.set(userId, promise);
    return promise;
  }

  const parts = await Promise.all(
    filtered.map(async (msg) => {
      const text = (msg.text ?? "").trim();
      if (!text) return null;
      const author = await resolveDisplayName(msg.user);
      const timestamp = formatTs(msg.ts);
      const quotedText = text.replace(/\n/g, "\n> ");
      return `**@${author}** · ${timestamp}\n> ${quotedText}`;
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
