import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { compileThreadWithMeta, deriveTitle, deriveBotAlertTitle, extractMessageText } from "../src/thread.js";

describe("deriveTitle", () => {
  test("returns the first line of a multi-line text", () => {
    assert.equal(deriveTitle("First line\nSecond line"), "First line");
  });

  test("returns text unchanged when 80 chars or fewer", () => {
    const exactly80 = "a".repeat(80);
    assert.equal(deriveTitle(exactly80), exactly80);
  });

  test("truncates to 80 chars with ellipsis when text is longer than 80 chars", () => {
    const long = "b".repeat(100);
    const result = deriveTitle(long);
    assert.equal(result.length, 80);
    assert.ok(result.endsWith("..."));
  });

  test("returns fallback title for empty string", () => {
    assert.equal(deriveTitle(""), "Issue from Slack");
  });

  test("returns fallback title for null", () => {
    assert.equal(deriveTitle(null), "Issue from Slack");
  });

  test("trims whitespace from the first line", () => {
    assert.equal(deriveTitle("  padded title  \nother"), "padded title");
  });

  test("returns fallback when first line is only whitespace", () => {
    assert.equal(deriveTitle("   \nsecond line"), "Issue from Slack");
  });
});

// ── compileThreadWithMeta ─────────────────────────────────────────────────────

describe("compileThreadWithMeta", () => {
  function makeClient(userMap, { ownBotId = null } = {}) {
    const callCount = {};
    const client = {
      users: {
        info: async ({ user }) => {
          callCount[user] = (callCount[user] ?? 0) + 1;
          const name = userMap[user];
          if (!name) throw new Error("user not found");
          return { user: { profile: { display_name: name } } };
        },
      },
      auth: {
        test: async () => ({ bot_id: ownBotId, user_id: "UBUTLER" }),
      },
      _callCount: callCount,
    };
    return client;
  }

  test("returns empty string for empty messages array", async () => {
    const result = await compileThreadWithMeta(makeClient({}), []);
    assert.equal(result, "");
  });

  test("returns empty string when all messages are filtered by sinceTs", async () => {
    const messages = [{ ts: "1000.0", user: "U1", text: "old" }];
    const result = await compileThreadWithMeta(makeClient({ U1: "Alice" }), messages, { sinceTs: "2000.0" });
    assert.equal(result, "");
  });

  test("starts with Full thread header", async () => {
    const messages = [{ ts: "1000.0", user: "U1", text: "Hello" }];
    const result = await compileThreadWithMeta(makeClient({ U1: "Alice" }), messages);
    assert.ok(result.startsWith("**Full thread:**"));
  });

  test("includes the author's display name", async () => {
    const messages = [{ ts: "1000.0", user: "U1", text: "Hello" }];
    const result = await compileThreadWithMeta(makeClient({ U1: "Alice" }), messages);
    assert.ok(result.includes("Alice"));
  });

  test("includes message text as a blockquote", async () => {
    const messages = [{ ts: "1000.0", user: "U1", text: "Bug found here" }];
    const result = await compileThreadWithMeta(makeClient({ U1: "Alice" }), messages);
    assert.ok(result.includes("> Bug found here"));
  });

  test("wraps multi-line messages entirely in blockquote", async () => {
    const messages = [{ ts: "1000.0", user: "U1", text: "Line 1\nLine 2" }];
    const result = await compileThreadWithMeta(makeClient({ U1: "Alice" }), messages);
    assert.ok(result.includes("> Line 1\n> Line 2"));
  });

  test("skips messages with empty text", async () => {
    const messages = [
      { ts: "1000.0", user: "U1", text: "Hello" },
      { ts: "1001.0", user: "U1", text: "" },
      { ts: "1002.0", user: "U1", text: "World" },
    ];
    const result = await compileThreadWithMeta(makeClient({ U1: "Alice" }), messages);
    const quoteLines = result.split("\n").filter((l) => l.startsWith("> "));
    assert.equal(quoteLines.length, 2);
  });

  test("caches user lookups — only one API call per user", async () => {
    const client = makeClient({ U1: "Alice" });
    const messages = [
      { ts: "1000.0", user: "U1", text: "First" },
      { ts: "1001.0", user: "U1", text: "Second" },
    ];
    await compileThreadWithMeta(client, messages);
    assert.equal(client._callCount["U1"], 1);
  });

  test("only includes messages with ts greater than sinceTs", async () => {
    const messages = [
      { ts: "1000.0", user: "U1", text: "Old message" },
      { ts: "2000.0", user: "U1", text: "New message" },
    ];
    const result = await compileThreadWithMeta(makeClient({ U1: "Alice" }), messages, { sinceTs: "1500.0" });
    assert.ok(!result.includes("Old message"));
    assert.ok(result.includes("New message"));
  });

  test("uses userId as fallback when user lookup fails", async () => {
    const messages = [{ ts: "1000.0", user: "U_UNKNOWN", text: "Hello" }];
    const result = await compileThreadWithMeta(makeClient({}), messages);
    assert.ok(result.includes("U_UNKNOWN"));
  });

  test("uses Unknown when userId is missing", async () => {
    const messages = [{ ts: "1000.0", text: "Hello" }];
    const result = await compileThreadWithMeta(makeClient({}), messages);
    assert.ok(result.includes("Unknown"));
  });

  test("filters out Butler's own bot messages but keeps other bots", async () => {
    const messages = [
      { ts: "1000.0", bot_id: "BSENTRY", bot_profile: { name: "Sentry" }, text: "TypeError: boom" },
      { ts: "1001.0", user: "U1", text: "investigating" },
      { ts: "1002.0", bot_id: "BBUTLER", bot_profile: { name: "GitHub Butler" }, text: "Issue created: repo#1" },
    ];
    const client = makeClient({ U1: "Alice" }, { ownBotId: "BBUTLER" });
    const result = await compileThreadWithMeta(client, messages);
    assert.ok(result.includes("TypeError: boom"));
    assert.ok(result.includes("investigating"));
    assert.ok(!result.includes("Issue created"));
  });

  test("extracts bot message content from attachments when text is empty", async () => {
    const messages = [
      {
        ts: "1000.0",
        bot_id: "BSENTRY",
        bot_profile: { name: "Sentry" },
        text: "",
        attachments: [{ text: "Null check operator used on a null value" }],
      },
    ];
    const client = makeClient({}, { ownBotId: "BBUTLER" });
    const result = await compileThreadWithMeta(client, messages);
    assert.ok(result.includes("Null check operator used on a null value"));
    assert.ok(result.includes("Sentry"));
  });

  test("extracts bot message content from blocks when text and attachments are empty", async () => {
    const messages = [
      {
        ts: "1000.0",
        bot_id: "BSENTRY",
        bot_profile: { name: "Sentry" },
        text: "",
        blocks: [{ type: "section", text: { type: "mrkdwn", text: "Alert fired" } }],
      },
    ];
    const client = makeClient({}, { ownBotId: "BBUTLER" });
    const result = await compileThreadWithMeta(client, messages);
    assert.ok(result.includes("Alert fired"));
  });

  test("includeParent forces the thread root into output even when sinceTs filters it", async () => {
    const messages = [
      { ts: "1000.0", bot_id: "BSENTRY", bot_profile: { name: "Sentry" }, text: "Original alert" },
      { ts: "2000.0", user: "U1", text: "new reply" },
    ];
    const client = makeClient({ U1: "Alice" }, { ownBotId: "BBUTLER" });
    const result = await compileThreadWithMeta(client, messages, {
      sinceTs: "1500.0",
      includeParent: true,
    });
    assert.ok(result.includes("Original alert"));
    assert.ok(result.includes("new reply"));
  });

  test("includeParent does not duplicate the parent when it is already after sinceTs", async () => {
    const messages = [
      { ts: "2000.0", bot_id: "BSENTRY", bot_profile: { name: "Sentry" }, text: "Original alert" },
      { ts: "3000.0", user: "U1", text: "new reply" },
    ];
    const client = makeClient({ U1: "Alice" }, { ownBotId: "BBUTLER" });
    const result = await compileThreadWithMeta(client, messages, {
      sinceTs: "1500.0",
      includeParent: true,
    });
    const occurrences = result.split("Original alert").length - 1;
    assert.equal(occurrences, 1);
  });

  test("renders a placeholder with permalink when a bot message has no extractable text", async () => {
    const messages = [
      { ts: "1000.0", bot_id: "BSENTRY", bot_profile: { name: "Sentry" }, text: "" },
    ];
    const client = makeClient({}, { ownBotId: "BBUTLER" });
    client.chat = {
      getPermalink: async () => ({ permalink: "https://slack.test/p1000" }),
    };
    const result = await compileThreadWithMeta(client, messages, { channel: "C1" });
    assert.ok(result.includes("Sentry"));
    assert.ok(result.includes("https://slack.test/p1000"));
    assert.ok(result.includes("view in Slack"));
  });

  test("bot placeholder falls back to plain text when no channel is supplied", async () => {
    const messages = [
      { ts: "1000.0", bot_id: "BSENTRY", bot_profile: { name: "Sentry" }, text: "" },
    ];
    const client = makeClient({}, { ownBotId: "BBUTLER" });
    const result = await compileThreadWithMeta(client, messages);
    assert.ok(result.includes("Sentry"));
    assert.ok(result.includes("Sentry message"));
  });
});

describe("extractMessageText", () => {
  test("returns text when present", () => {
    assert.equal(extractMessageText({ text: "Hello" }), "Hello");
  });

  test("returns empty string for file_share messages", () => {
    assert.equal(extractMessageText({ subtype: "file_share", text: "image.png" }), "");
  });

  test("falls back to attachment text when message text is empty", () => {
    const msg = { text: "", attachments: [{ text: "from attachment" }] };
    assert.equal(extractMessageText(msg), "from attachment");
  });

  test("prefers attachment.text, then fallback, then title", () => {
    assert.equal(
      extractMessageText({ text: "", attachments: [{ fallback: "fb", title: "tt" }] }),
      "fb"
    );
    assert.equal(extractMessageText({ text: "", attachments: [{ title: "tt" }] }), "tt");
  });

  test("falls back to section block text when text and attachments are empty", () => {
    const msg = {
      text: "",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "hello" } }],
    };
    assert.equal(extractMessageText(msg), "hello");
  });

  test("prefers blocks over attachments for bot messages", () => {
    const msg = {
      bot_id: "BSENTRY",
      bot_profile: { name: "Sentry" },
      text: "",
      attachments: [{ fallback: "[app] OneLineSummary" }],
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: "SignedOutException" } },
        { type: "section", text: { type: "mrkdwn", text: "No user is currently signed in" } },
      ],
    };
    const result = extractMessageText(msg);
    assert.ok(result.includes("SignedOutException"));
    assert.ok(result.includes("No user is currently signed in"));
    assert.ok(!result.includes("OneLineSummary"));
  });

  test("keeps text-first priority for user messages when blocks also present", () => {
    const msg = {
      user: "U1",
      text: "hello from user",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "rendered blocks" } }],
    };
    assert.equal(extractMessageText(msg), "hello from user");
  });

  test("returns empty string when nothing is available", () => {
    assert.equal(extractMessageText({}), "");
    assert.equal(extractMessageText(null), "");
  });
});

describe("deriveBotAlertTitle", () => {
  function sentryMessage({ env = "dev", errorLine = "`SplitClient is null`", name = "Sentry", extraBlocks = [] } = {}) {
    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: ":red_circle: <https://sentry.io/issues/1|String>" } },
      { type: "section", text: { type: "mrkdwn", text: "<asynchronous suspension> in ?" } },
      { type: "section", text: { type: "mrkdwn", text: errorLine } },
      ...extraBlocks,
      { type: "context", elements: [{ type: "mrkdwn", text: `environment: \`${env}\`` }] },
    ];
    return { bot_id: "BSENTRY", bot_profile: { name }, blocks };
  }

  test("returns null for user messages", () => {
    assert.equal(deriveBotAlertTitle({ user: "U1", text: "hello" }), null);
  });

  test("returns null for bot messages with no blocks", () => {
    assert.equal(deriveBotAlertTitle({ bot_profile: { name: "Sentry" }, text: "x" }), null);
  });

  test("formats [Env][Bot] <code block> for Sentry-style blocks", () => {
    assert.equal(deriveBotAlertTitle(sentryMessage()), "[Dev][Sentry] SplitClient is null");
  });

  test("reflects bot_profile.name so PagerDuty renders as [PagerDuty]", () => {
    assert.equal(
      deriveBotAlertTitle(sentryMessage({ name: "PagerDuty", errorLine: "`Database unreachable`" })),
      "[Dev][PagerDuty] Database unreachable"
    );
  });

  test("drops the env prefix when no environment context is present", () => {
    const msg = {
      bot_profile: { name: "Sentry" },
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: ":red_circle: <https://sentry.io/issues/1|String>" } },
        { type: "section", text: { type: "mrkdwn", text: "`SplitClient is null`" } },
      ],
    };
    assert.equal(deriveBotAlertTitle(msg), "[Sentry] SplitClient is null");
  });

  test("title-cases the environment name", () => {
    assert.equal(
      deriveBotAlertTitle(sentryMessage({ env: "production" })),
      "[Production][Sentry] SplitClient is null"
    );
  });

  test("falls back to first non-link section text when no code block found", () => {
    const msg = {
      bot_profile: { name: "Sentry" },
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: ":red_circle: <https://sentry.io/issues/1|String>" } },
        { type: "section", text: { type: "mrkdwn", text: "Something went wrong in production" } },
        { type: "context", elements: [{ type: "mrkdwn", text: "environment: `dev`" }] },
      ],
    };
    assert.equal(deriveBotAlertTitle(msg), "[Dev][Sentry] Something went wrong in production");
  });

  test("decodes Slack link syntax when using a section fallback", () => {
    const msg = {
      bot_profile: { name: "Sentry" },
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: ":red_circle: <https://sentry.io/issues/1|String>" } },
        { type: "section", text: { type: "mrkdwn", text: "Failure in <https://example.com|service>" } },
      ],
    };
    assert.equal(deriveBotAlertTitle(msg), "[Sentry] Failure in service");
  });

  test("returns null when no error line can be extracted", () => {
    const msg = {
      bot_profile: { name: "Sentry" },
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: ":red_circle: <https://sentry.io/issues/1|String>" } },
      ],
    };
    assert.equal(deriveBotAlertTitle(msg), null);
  });

  test("truncates very long error lines to stay under 150 chars total", () => {
    const longError = "a".repeat(400);
    const msg = {
      bot_profile: { name: "Sentry" },
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `\`${longError}\`` } },
      ],
    };
    const result = deriveBotAlertTitle(msg);
    assert.ok(result.startsWith("[Sentry] "));
    assert.ok(result.length <= 150);
    assert.ok(result.endsWith("..."));
  });
});
