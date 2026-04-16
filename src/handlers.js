import { getUserDefaults, setUserDefaults } from "./defaults.js";
import {
  buildModal,
  buildAddToIssueModal,
  buildProjectFieldMap,
  resolveDefaultProjectId,
} from "./modal.js";
import { fetchThreadMessages, compileThreadWithMeta, deriveTitle, getOwnBotIdentity, extractMessageText } from "./thread.js";
import {
  buildIssueCard,
  buildCardMeta,
  resolveCardFields,
  cardFieldBlockId,
  cardFieldActionId,
  CARD_TITLE_BLOCK_ID,
  CARD_TITLE_ACTION_ID,
  CARD_LABELS_BLOCK_ID,
  CARD_LABELS_ACTION_ID,
  CARD_MILESTONE_BLOCK_ID,
  CARD_MILESTONE_ACTION_ID,
  CARD_MILESTONE_NONE_VALUE,
} from "./card.js";
import { registerThreadIssue, getThreadIssue, updateThreadIssueSyncTs, claimCardPost, releaseCardPost } from "./thread-store.js";

// Deduplication: prevents duplicate modal opens or issue creations from Lambda
// retries or rapid double-clicks. Keyed on action_ts (actions/shortcuts) or
// view.id (view submissions). Entries expire after 30 seconds.
const _seen = new Map();
const DEDUP_MS = 30_000;

function isDuplicate(key) {
  const now = Date.now();
  for (const [k, t] of _seen) {
    if (now - t > DEDUP_MS) _seen.delete(k);
  }
  if (_seen.has(key)) return true;
  _seen.set(key, now);
  return false;
}

// GitHub repo names: alphanumeric, hyphen, underscore, dot; cannot start with
// dot or hyphen; max 100 chars. Validated before making any API call with a
// user-supplied repo name (e.g., from emoji suffix routing).
const VALID_REPO_RE = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,98}[a-zA-Z0-9._]$|^[a-zA-Z0-9_]$/;
function isValidRepoName(name) {
  return typeof name === "string" && VALID_REPO_RE.test(name);
}

function safeErrorMessage(err) {
  return err?.message ?? "An unexpected error occurred.";
}

async function appendThreadUpdateToIssue(client, github, { channelId, threadTs, userId, existingIssue }) {
  const { repo: issueRepo, issueNumber, lastSyncedTs } = existingIssue;
  const allMessages = await fetchThreadMessages(client, channelId, threadTs);
  const newContent = await compileThreadWithMeta(client, allMessages, { sinceTs: lastSyncedTs });

  if (!newContent) {
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      thread_ts: threadTs,
      text: `No new messages to add to ${issueRepo}#${issueNumber} since last sync.`,
    });
    return;
  }

  const latestTs = allMessages[allMessages.length - 1]?.ts ?? lastSyncedTs;

  try {
    const comment = await github.addIssueComment(
      issueRepo,
      issueNumber,
      `${newContent}\n\n---\n_Updated from Slack_`
    );
    await updateThreadIssueSyncTs(threadTs, latestTs);
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      unfurl_links: false,
      text: `Thread update added to <${comment.html_url}|${issueRepo}#${issueNumber}>`,
    });
  } catch (err) {
    console.error("[handlers] tag update failed:", err);
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      thread_ts: threadTs,
      text: `Failed to update issue: ${safeErrorMessage(err)}`,
    });
  }
}

function collectModalProjectFieldValues(stateValues = {}) {
  const out = {};

  for (const [blockId, blockState] of Object.entries(stateValues)) {
    if (!/^pf_\d+$/.test(blockId)) continue;

    const input = blockState?.[`${blockId}_input`];
    if (!input) continue;

    if (input.selected_option?.value != null) {
      out[blockId] = input.selected_option.value;
    } else if (input.value != null && input.value !== "") {
      out[blockId] = input.value;
    }
  }

  return out;
}

// Translates the card's current single-select state into the `pf_<index>` keys
// used by the full modal (which iterates project fields by index). Used when a
// user clicks "Customize" and we need to carry their inline card selections
// into the opened modal.
function collectCardProjectFieldValues(projectFields = [], stateValues = {}, cardMeta = {}) {
  const selectedOptionIdByFieldId = new Map();

  for (const cardField of cardMeta.cardFields ?? []) {
    if (!cardField?.fieldId) continue;
    const selectedOptionId =
      stateValues[cardFieldBlockId(cardField.key)]?.[cardFieldActionId(cardField.key)]?.selected_option?.value
      ?? cardField.defaultOptionId
      ?? null;
    if (selectedOptionId) selectedOptionIdByFieldId.set(cardField.fieldId, selectedOptionId);
  }

  const modalFieldValuesByBlockId = {};
  projectFields.forEach((projectField, projectFieldIndex) => {
    const selectedOptionId = selectedOptionIdByFieldId.get(projectField?.id);
    if (selectedOptionId) modalFieldValuesByBlockId[`pf_${projectFieldIndex}`] = selectedOptionId;
  });

  return modalFieldValuesByBlockId;
}

// Fetches repo metadata and posts an inline issue-creation card as an ephemeral
// message. Used by emoji reactions and the Quick Create button from @mentions.
// Parse REPO_DEFAULT_LABELS env var: JSON map of repo → label names array.
// Returns the label names for the given repo, or [] if not configured.
function getRepoDefaultLabels(repo) {
  const raw = process.env.REPO_DEFAULT_LABELS;
  if (!raw) return [];
  try {
    const map = JSON.parse(raw);
    return Array.isArray(map[repo]) ? map[repo] : [];
  } catch {
    console.warn("[handlers] REPO_DEFAULT_LABELS is not valid JSON — ignoring");
    return [];
  }
}

async function postIssueCard({ client, github, channelId, threadTs, userId, messageText, permalink, repo }) {
  const userDefaults = getUserDefaults(userId);

  const [labels, milestones, allProjects] = await Promise.all([
    github.getLabels(repo),
    github.getMilestones(repo),
    github.getProjects(),
  ]);

  const projectId = resolveDefaultProjectId(allProjects, userDefaults.projectId, process.env.DEFAULT_GITHUB_PROJECT);
  const projectFields = projectId
    ? await github.getProjectFields(projectId).catch(() => [])
    : [];

  // Native org issue types are only fetched when no project field named "Type"
  // exists — a project-level Type field takes precedence when present.
  const hasProjectTypeField = projectFields.some((field) => /^type$/i.test(field?.name ?? ""));
  const nativeIssueTypes = hasProjectTypeField
    ? []
    : await github.getIssueTypes().catch(() => []);

  const cardFields = resolveCardFields(projectFields, nativeIssueTypes);
  console.log(
    `[postIssueCard] cardFields: ${cardFields.map((field) => `${field.key}(${field.options.length}${field.isNativeType ? ",native" : ""})`).join(", ") || "none"}`
  );

  const title = deriveTitle(messageText);
  // Use lines after the first as the body; avoids duplicating the title in the body
  const bodyLinesAfterTitle = messageText.split("\n").slice(1).join("\n").trim();

  // Repo-level label defaults take priority over per-user saved defaults.
  // Label names from the env are matched against the fetched label list to get their values.
  const repoLabelNames = getRepoDefaultLabels(repo);
  const defaultLabelValues = repoLabelNames.length > 0
    ? labels.filter((label) => repoLabelNames.includes(label.text)).map((label) => label.value)
    : (userDefaults.labelValues ?? []);

  const cardMeta = buildCardMeta({
    repo,
    title,
    messageText: bodyLinesAfterTitle,
    channelId,
    threadTs,
    userId,
    permalink,
    projectId,
    cardFields,
    defaultLabelValues,
    defaultMilestoneValue: userDefaults.milestoneValue ?? null,
  });

  const blocks = buildIssueCard({
    repo,
    title,
    labels,
    milestones,
    cardFields,
    defaultLabelValues,
    defaultMilestoneValue: userDefaults.milestoneValue ?? null,
    cardMeta,
  });

  await client.chat.postMessage({
    channel: channelId,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    text: `New issue: ${title}`,
    blocks,
  });
}

// ── Issue display helper ──────────────────────────────────────────────────────

async function showIssue(client, channelId, userId, repo, issueNumber, github) {
  const issue = await github.getIssue(repo, issueNumber).catch(() => null);
  if (!issue) {
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: `Could not find ${repo}#${issueNumber}.`,
    });
    return;
  }
  const labels = issue.labels.map((l) => l.name).join(", ") || "none";
  const assignees = issue.assignees.map((a) => a.login).join(", ") || "unassigned";
  await client.chat.postEphemeral({
    channel: channelId,
    user: userId,
    text: `${repo}#${issueNumber}: ${issue.title}`,
    blocks: [{
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*<${issue.html_url}|${repo}#${issueNumber}: ${issue.title}>*\nState: ${issue.state} | Labels: ${labels} | Assignees: ${assignees}`,
      },
    }],
  });
}

// ── Handler registration ──────────────────────────────────────────────────────

export function registerHandlers(app, github) {
  // 1. Message shortcut → open the modal
  app.shortcut("create_github_issue", async ({ shortcut, ack, client }) => {
    await ack();
    if (isDuplicate(shortcut.action_ts)) return;

    const messageText = shortcut.message?.text ?? "";
    const channelId = shortcut.channel?.id;
    const threadTs = shortcut.message?.thread_ts ?? shortcut.message?.ts;
    const messageTs = shortcut.message?.ts;
    const userId = shortcut.user?.id;

    const permalinkResult = await client.chat.getPermalink({
      channel: channelId,
      message_ts: messageTs,
    }).catch(() => null);

    const slackMessageContext = {
      channelId,
      threadTs,
      messageTs,
      userId,
      permalink: permalinkResult?.permalink ?? "",
      projectFieldMap: {},
    };

    const repoOptions = await github.getRepos();

    await client.views.open({
      trigger_id: shortcut.trigger_id,
      view: buildModal({
        messageText,
        metadata: slackMessageContext,
        repoOptions,
      }),
    });
  });

  // 2. /issue slash command
  //    /issue           → open form
  //    /issue 123       → look up issue #123 in last-used repo
  //    /issue repo#123  → look up issue in a specific repo
  //    /issue search q  → search open issues
  //    /issue <text>    → open form with title pre-filled
  app.command("/butler", async ({ command, ack, client }) => {
    await ack();

    const text = (command.text ?? "").trim();
    const userId = command.user_id;
    const channelId = command.channel_id;
    // Present when the command is invoked from inside a thread
    const threadTs = command.thread_ts ?? null;

    const plainNumMatch = /^(\d+)$/.exec(text);
    if (plainNumMatch) {
      const defaults = getUserDefaults(userId);
      if (!defaults.repo) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          ...(threadTs ? { thread_ts: threadTs } : {}),
          text: "No default repo saved. Create an issue first, or use `/butler repo-name#123`.",
        });
        return;
      }
      await showIssue(client, channelId, userId, defaults.repo, parseInt(plainNumMatch[1], 10), github);
      return;
    }

    const repoNumMatch = /^([^#\s]+)#(\d+)$/.exec(text);
    if (repoNumMatch) {
      await showIssue(client, channelId, userId, repoNumMatch[1], parseInt(repoNumMatch[2], 10), github);
      return;
    }

    if (text.toLowerCase().startsWith("search ")) {
      const query = text.slice(7).trim();
      if (!query) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          ...(threadTs ? { thread_ts: threadTs } : {}),
          text: "Usage: `/issue search <query>`",
        });
        return;
      }
      const items = await github.searchIssues(query).catch(() => []);
      if (items.length === 0) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          ...(threadTs ? { thread_ts: threadTs } : {}),
          text: `No issues found for "${query}".`,
        });
        return;
      }
      const lines = items
        .map((item) => {
          const repoName = item.repository_url.split("/").pop();
          return `• <${item.html_url}|${repoName}#${item.number}: ${item.title}> — ${item.state}`;
        })
        .join("\n");
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        text: `Search results for "${query}"`,
        blocks: [{
          type: "section",
          text: { type: "mrkdwn", text: `*Search results for "${query}":*\n\n${lines}` },
        }],
      });
      return;
    }

    // Default: open form (text becomes pre-filled title).
    // threadTs is passed through so issues created from a thread are linked back to it.
    const repoOptions = await github.getRepos();

    await client.views.open({
      trigger_id: command.trigger_id,
      view: buildModal({
        currentTitle: text,
        metadata: {
          channelId,
          threadTs,
          messageTs: null,
          userId,
          permalink: "",
          projectFieldMap: {},
        },
        repoOptions,
      }),
    });
  });

  // 3. @mention in a thread → ephemeral message with Create Issue + Quick Create buttons
  // Workaround: Slack does not provide a trigger_id on message events,
  // so a modal cannot be opened directly. The button click provides one.
  //
  // Usage:
  //   @GitHub Butler              → show buttons (normal flow)
  //   @GitHub Butler some title   → pre-fill title in buttons
  //   @GitHub Butler ^            → auto quick-create from the previous message
  //   @GitHub Butler summarise ^  → same; any text ending in ^ triggers this
  app.event("app_mention", async ({ event, client }) => {
    const rawText = event.text.replace(/<@[^>]+>/g, "").trim();
    const threadTs = event.thread_ts ?? event.ts;

    // Caret shortcut: text ends with "^"
    // If the thread already has a linked issue → append new messages as a comment (tag update).
    // Otherwise → show the issue card pre-filled from the previous non-bot message.
    //
    // Optional repo override: "@butler <repo-name> ^" uses that repo instead of the default.
    // e.g. "@GitHub Butler repo-name ^"
    if (rawText.endsWith("^")) {
      const userId = event.user;

      // In-process dedup: drop Lambda retries arriving on the same instance
      if (isDuplicate(`mention:${event.ts}:${userId}`)) return;

      // Tag update: check for an existing thread → issue mapping
      const existingIssue = await getThreadIssue(threadTs);
      if (existingIssue) {
        await appendThreadUpdateToIssue(client, github, {
          channelId: event.channel,
          threadTs,
          userId,
          existingIssue,
        });
        return;
      }

      // No existing issue → show card from the previous non-bot message
      const defaults = getUserDefaults(userId);

      // Parse optional repo override: the single word immediately before "^"
      // e.g. "repo-name ^" → repoOverride = "repo-name"
      const words = rawText.split(/\s+/).filter(Boolean);
      const possibleRepo = words.length >= 2 ? words[words.length - 2] : null;
      const repoOverride = (possibleRepo && isValidRepoName(possibleRepo)) ? possibleRepo : null;
      const repo = repoOverride ?? defaults.repo ?? null;

      if (!repo) {
        await client.chat.postEphemeral({
          channel: event.channel,
          user: userId,
          thread_ts: threadTs,
          text: "No default repo saved. Use *Create Issue* (form) once to set your preferences, or specify a repo: `@GitHub Butler <repo-name> ^`.",
        });
        return;
      }

      if (repoOverride) {
        console.log(`[mention/caret] using repo override: ${repoOverride}`);
      }

      let prevMessage = null;

      if (event.thread_ts) {
        // In a thread: find the most recent message before this @mention,
        // excluding only Butler's own posts. Other bots (e.g. Sentry) stay
        // eligible so their alert content can seed the issue body.
        const threadMsgs = await fetchThreadMessages(client, event.channel, event.thread_ts);
        const { botId: ownBotId } = await getOwnBotIdentity(client);
        prevMessage = [...threadMsgs]
          .filter((m) => parseFloat(m.ts) < parseFloat(event.ts) && m.bot_id !== ownBotId)
          .sort((a, b) => parseFloat(b.ts) - parseFloat(a.ts))[0] ?? null;
      } else {
        // Top-level: fetch the message immediately above in the channel
        const historyResult = await client.conversations.history({
          channel: event.channel,
          latest: event.ts,
          inclusive: false,
          limit: 1,
        }).catch(() => null);
        prevMessage = historyResult?.messages?.[0] ?? null;
      }

      if (!prevMessage) {
        await client.chat.postEphemeral({
          channel: event.channel,
          user: userId,
          thread_ts: threadTs,
          text: "No previous message found to create an issue from.",
        });
        return;
      }

      // Cross-instance dedup: claim the card post in DynamoDB / in-memory.
      // Prevents duplicate cards when a Lambda retry lands on a different
      // instance (in-process isDuplicate above only catches same-instance retries).
      const claimed = await claimCardPost(threadTs).catch(() => true); // on error, proceed
      if (!claimed) {
        console.log("[mention/caret] card already claimed for thread, skipping", { threadTs });
        return;
      }

      const permalinkResult = await client.chat.getPermalink({
        channel: event.channel,
        message_ts: prevMessage.ts,
      }).catch(() => null);

      await postIssueCard({
        client,
        github,
        channelId: event.channel,
        threadTs,
        userId,
        messageText: extractMessageText(prevMessage),
        permalink: permalinkResult?.permalink ?? "",
        repo,
      }).catch(async (err) => {
        console.error("Failed to post issue card from caret mention:", err);
        // Release the claim on failure so the user can try again
        await releaseCardPost(threadTs).catch(() => {});
        await client.chat.postEphemeral({
          channel: event.channel,
          user: userId,
          thread_ts: threadTs,
          text: `Failed to create issue card: ${safeErrorMessage(err)}`,
        });
      });
      return;
    }

    // Normal flow: show Create Issue + Quick Create buttons
    const issueTitle = rawText;

    const slackMessageContext = {
      channelId: event.channel,
      threadTs,
      messageTs: event.ts,
      userId: event.user,
      permalink: "",
      projectFieldMap: {},
    };

    await client.chat.postEphemeral({
      channel: event.channel,
      user: event.user,
      thread_ts: threadTs,
      text: issueTitle ? `Create issue: ${issueTitle}` : "Create a GitHub issue from this thread?",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: issueTitle
              ? `Create issue: *${issueTitle}*`
              : "Create a GitHub issue from this thread?",
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Create Issue" },
              action_id: "open_modal_from_mention",
              value: JSON.stringify({ ...slackMessageContext, issueTitle }),
            },
            {
              type: "button",
              text: { type: "plain_text", text: "Quick Create" },
              action_id: "quick_create_from_mention",
              value: JSON.stringify({ ...slackMessageContext, issueTitle }),
            },
          ],
        },
      ],
    });
  });

  // 4. "Create Issue" button from @mention → open the modal
  app.action("open_modal_from_mention", async ({ ack, action, body, client }) => {
    await ack();
    if (isDuplicate(action.action_ts)) return;

    const { issueTitle, ...slackMessageContext } = JSON.parse(action.value);
    const repoOptions = await github.getRepos();

    await client.views.open({
      trigger_id: body.trigger_id,
      view: buildModal({
        currentTitle: issueTitle ?? "",
        metadata: slackMessageContext,
        repoOptions,
      }),
    });
  });

  // 5. "Quick Create" button from @mention → show the issue card
  app.action("quick_create_from_mention", async ({ ack, action, body, client, respond }) => {
    await ack();

    const { issueTitle, ...slackMessageContext } = JSON.parse(action.value);
    const userId = body.user?.id;
    const defaults = getUserDefaults(userId);

    if (!defaults.repo) {
      await respond({
        replace_original: true,
        text: "No default repo saved. Use *Create Issue* (form) once to set your preferences.",
      });
      return;
    }

    await respond({ delete_original: true });

    await postIssueCard({
      client,
      github,
      channelId: slackMessageContext.channelId,
      threadTs: slackMessageContext.threadTs,
      userId,
      messageText: issueTitle ?? "",
      permalink: slackMessageContext.permalink,
      repo: defaults.repo,
    }).catch(async (err) => {
      console.error("Failed to post issue card from mention:", err);
      await client.chat.postEphemeral({
        channel: slackMessageContext.channelId,
        user: userId,
        ...(slackMessageContext.threadTs ? { thread_ts: slackMessageContext.threadTs } : {}),
        text: `Failed to create issue card: ${safeErrorMessage(err)}`,
      });
    });
  });

  // 6. Emoji reaction → show issue card or append to existing thread issue
  //
  // Emoji naming convention:
  //   :github_butler:          → use the reactor's default repo
  //   :{repo}_github_butler:   → use the named repo (e.g. :frontend_github_butler:)
  //
  // Tag update: if the thread already has an associated GitHub issue from a
  // prior creation, new messages since the last sync are appended as a comment
  // instead of creating a duplicate issue.
  app.event("reaction_added", async ({ event, client }) => {
    const BUTLER_SUFFIX = "_github_butler";
    const reaction = event.reaction;
    console.log("[reaction] received", { reaction, itemType: event.item?.type });

    let repo = null;
    if (reaction === "github_butler") {
      const defaults = getUserDefaults(event.user);
      repo = defaults.repo ?? null;
    } else if (reaction.endsWith(BUTLER_SUFFIX)) {
      const candidate = reaction.slice(0, -BUTLER_SUFFIX.length);
      if (!isValidRepoName(candidate)) {
        console.log("[reaction] invalid repo name in emoji, ignoring", { candidate });
        return;
      }
      repo = candidate;
    } else {
      return; // not a butler emoji, ignore silently
    }

    if (event.item.type !== "message") {
      console.log("[reaction] item is not a message, ignoring", { itemType: event.item.type });
      return;
    }

    const channelId = event.item.channel;
    const messageTs = event.item.ts;

    const historyResult = await client.conversations.history({
      channel: channelId,
      latest: messageTs,
      inclusive: true,
      limit: 1,
    }).catch((err) => {
      console.error("[reaction] conversations.history failed", err?.data?.error ?? err?.message);
      return null;
    });

    const message = historyResult?.messages?.[0];
    if (!message) {
      console.warn("[reaction] could not fetch reacted message", { channelId, messageTs });
      return;
    }

    const threadTs = message.thread_ts ?? message.ts;
    const userId = event.user;

    // In-process dedup: drop Lambda retries that arrive within the same instance
    if (isDuplicate(`reaction:${event.event_ts ?? messageTs}:${userId}`)) {
      console.log("[reaction] duplicate event, skipping");
      return;
    }

    // Check for an existing thread → issue mapping (tag update flow)
    const existingIssue = await getThreadIssue(threadTs);
    if (existingIssue) {
      await appendThreadUpdateToIssue(client, github, { channelId, threadTs, userId, existingIssue });
      return;
    }

    // No existing issue — show the card for new issue creation
    if (!repo) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        thread_ts: threadTs,
        text: "No default repo saved. Use *Create Issue* (form) once to set your preferences, or use a repo-specific emoji like `:frontend_github_butler:`.",
      });
      return;
    }

    // Cross-instance dedup: claim the card post in DynamoDB / in-memory.
    // If another Lambda instance already claimed it, bail out silently.
    const claimed = await claimCardPost(threadTs).catch(() => true); // on error, proceed
    if (!claimed) {
      console.log("[reaction] card already claimed for thread, skipping", { threadTs });
      return;
    }

    const permalinkResult = await client.chat.getPermalink({
      channel: channelId,
      message_ts: messageTs,
    }).catch(() => null);

    await postIssueCard({
      client,
      github,
      channelId,
      threadTs,
      userId,
      messageText: extractMessageText(message),
      permalink: permalinkResult?.permalink ?? "",
      repo,
    }).catch(async (err) => {
      console.error("Failed to post issue card:", err);
      // Release the claim on failure so the user can react again
      await releaseCardPost(threadTs).catch(() => {});
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        thread_ts: threadTs,
        text: `Failed to create issue card: ${safeErrorMessage(err)}`,
      });
    });
  });

  // 8. Repo selected → load labels/milestones/projects/templates and apply user defaults
  app.action("repo_select", async ({ ack, action, body, client }) => {
    await ack();

    const selectedRepo = action.selected_option?.value;
    if (!selectedRepo || selectedRepo === "__error__") return;

    // The add_to_issue_modal repo selector doesn't use dispatch_action so this
    // handler only fires for the create_issue_modal.
    const modalView = body.view;
    const slackMessageContext = JSON.parse(modalView.private_metadata);
    const currentTitle = modalView.state.values.title_block?.title_input?.value ?? "";
    const currentBody = modalView.state.values.body_block?.body_input?.value ?? "";
    const currentProjectFieldValues = collectModalProjectFieldValues(modalView.state.values);
    const defaults = getUserDefaults(body.user?.id);

    const [repoOptions, labels, milestones, projects, templates] = await Promise.all([
      github.getRepos(),
      github.getLabels(selectedRepo),
      github.getMilestones(selectedRepo),
      github.getProjects(),
      github.getIssueTemplates(selectedRepo),
    ]);

    const initialProjectId = resolveDefaultProjectId(
      projects,
      defaults.projectId,
      process.env.DEFAULT_GITHUB_PROJECT
    );
    const projectFields = initialProjectId
      ? await github.getProjectFields(initialProjectId).catch(() => [])
      : [];
    const projectFieldMap = buildProjectFieldMap(projectFields);

    const initialMilestoneValue = milestones.some((m) => m.value === defaults.milestoneValue)
      ? defaults.milestoneValue
      : null;
    const initialLabelValues = defaults.labelValues.filter((labelValue) =>
      labels.some((label) => label.value === labelValue)
    );

    await client.views.update({
      view_id: modalView.id,
      hash: modalView.hash,
      view: buildModal({
        selectedRepo,
        metadata: { ...slackMessageContext, projectFieldMap },
        currentTitle,
        currentBody,
        labels,
        milestones,
        projects,
        templates,
        projectFields,
        initialProjectId,
        initialMilestoneValue,
        initialLabelValues,
        initialProjectFieldValues: currentProjectFieldValues,
        repoOptions,
      }),
    });
  });

  // 9. Template selected → pre-fill title, body, and labels from the template
  app.action("template_select", async ({ ack, action, body, client }) => {
    await ack();

    const selectedTemplateName = action.selected_option?.value;
    const modalView = body.view;
    const slackMessageContext = JSON.parse(modalView.private_metadata);
    const selectedRepo = modalView.state.values.repo_block?.repo_select?.selected_option?.value;
    if (!selectedRepo) return;

    const defaults = getUserDefaults(body.user?.id);
    const currentProjectId = modalView.state.values.project_block?.project_select?.selected_option?.value ?? null;
    const currentProjectFieldValues = collectModalProjectFieldValues(modalView.state.values);

    const [repoOptions, labels, milestones, projects, templates, projectFields] = await Promise.all([
      github.getRepos(),
      github.getLabels(selectedRepo),
      github.getMilestones(selectedRepo),
      github.getProjects(),
      github.getIssueTemplates(selectedRepo),
      currentProjectId ? github.getProjectFields(currentProjectId).catch(() => []) : Promise.resolve([]),
    ]);

    const selectedTemplate = templates.find((t) => t.name === selectedTemplateName);
    const resolvedProjectId =
      resolveDefaultProjectId(projects, defaults.projectId, process.env.DEFAULT_GITHUB_PROJECT)
      ?? currentProjectId;
    const initialMilestoneValue = milestones.some((m) => m.value === defaults.milestoneValue)
      ? defaults.milestoneValue
      : null;

    const templateLabelValues = selectedTemplate?.labels.filter((lv) =>
      labels.some((l) => l.value === lv)
    ) ?? [];
    const initialLabelValues = templateLabelValues.length > 0
      ? templateLabelValues
      : defaults.labelValues.filter((lv) => labels.some((l) => l.value === lv));

    await client.views.update({
      view_id: modalView.id,
      hash: modalView.hash,
      view: buildModal({
        selectedRepo,
        metadata: { ...slackMessageContext, projectFieldMap: buildProjectFieldMap(projectFields) },
        currentTitle: selectedTemplate?.title ?? modalView.state.values.title_block?.title_input?.value ?? "",
        currentBody: selectedTemplate?.body ?? modalView.state.values.body_block?.body_input?.value ?? "",
        labels,
        milestones,
        projects,
        templates,
        projectFields,
        initialTemplateId: selectedTemplateName,
        initialProjectId: resolvedProjectId,
        initialMilestoneValue,
        initialLabelValues,
        initialProjectFieldValues: currentProjectFieldValues,
        repoOptions,
      }),
    });
  });

  // 10. Project selected → load and display the project's custom fields
  app.action("project_select", async ({ ack, action, body, client }) => {
    await ack();

    const selectedProjectId = action.selected_option?.value;
    const modalView = body.view;
    const slackMessageContext = JSON.parse(modalView.private_metadata);
    const selectedRepo = modalView.state.values.repo_block?.repo_select?.selected_option?.value;
    if (!selectedRepo) return;

    const selectedTemplateName = modalView.state.values.template_block?.template_select?.selected_option?.value ?? null;
    const currentTitle = modalView.state.values.title_block?.title_input?.value ?? "";
    const currentBody = modalView.state.values.body_block?.body_input?.value ?? "";
    const currentLabelValues = modalView.state.values.labels_block?.labels_select?.selected_options?.map((o) => o.value) ?? [];
    const currentMilestoneValue = modalView.state.values.milestone_block?.milestone_select?.selected_option?.value ?? null;
    const currentProjectFieldValues = collectModalProjectFieldValues(modalView.state.values);

    const [repoOptions, labels, milestones, projects, templates, projectFields] = await Promise.all([
      github.getRepos(),
      github.getLabels(selectedRepo),
      github.getMilestones(selectedRepo),
      github.getProjects(),
      github.getIssueTemplates(selectedRepo),
      selectedProjectId ? github.getProjectFields(selectedProjectId).catch(() => []) : Promise.resolve([]),
    ]);

    await client.views.update({
      view_id: modalView.id,
      hash: modalView.hash,
      view: buildModal({
        selectedRepo,
        metadata: { ...slackMessageContext, projectFieldMap: buildProjectFieldMap(projectFields) },
        currentTitle,
        currentBody,
        labels,
        milestones,
        projects,
        templates,
        projectFields,
        initialTemplateId: selectedTemplateName,
        initialProjectId: selectedProjectId,
        initialMilestoneValue: currentMilestoneValue,
        initialLabelValues: currentLabelValues,
        initialProjectFieldValues: currentProjectFieldValues,
        repoOptions,
      }),
    });
  });

  // 11. "Add to GitHub Issue" message shortcut → open the add-to-issue modal
  app.shortcut("add_to_github_issue", async ({ shortcut, ack, client }) => {
    await ack();

    const messageText = shortcut.message?.text ?? "";
    const channelId = shortcut.channel?.id;
    const threadTs = shortcut.message?.thread_ts ?? shortcut.message?.ts;
    const messageTs = shortcut.message?.ts;

    const permalinkResult = await client.chat.getPermalink({
      channel: channelId,
      message_ts: messageTs,
    }).catch(() => null);

    const slackMessageContext = {
      channelId,
      threadTs,
      messageTs,
      userId: shortcut.user?.id,
      permalink: permalinkResult?.permalink ?? "",
    };

    const repoOptions = await github.getRepos();

    await client.views.open({
      trigger_id: shortcut.trigger_id,
      view: buildAddToIssueModal({
        messageText,
        metadata: slackMessageContext,
        repoOptions,
      }),
    });
  });

  // 12. Create issue modal submitted → create the GitHub issue and save user defaults
  app.view("create_issue_modal", async ({ ack, view, client }) => {
    const formValues = view.state.values;
    const slackMessageContext = JSON.parse(view.private_metadata);

    const selectedRepo = formValues.repo_block?.repo_select?.selected_option?.value ?? "";
    const issueTitle = formValues.title_block?.title_input?.value ?? "";
    const selectedLabels = formValues.labels_block?.labels_select?.selected_options?.map((opt) => opt.value) ?? [];
    const milestoneValue = formValues.milestone_block?.milestone_select?.selected_option?.value ?? null;
    const selectedProjectId = formValues.project_block?.project_select?.selected_option?.value ?? null;
    const parentIssueInput = formValues.parent_issue_block?.parent_issue_input?.value?.trim() ?? null;
    const includeThread = formValues.thread_block?.include_thread?.selected_options?.some(
      (opt) => opt.value === "include_thread"
    ) ?? false;

    setUserDefaults(slackMessageContext.userId, {
      repo: selectedRepo,
      projectId: selectedProjectId,
      milestoneValue,
      labelValues: selectedLabels,
    });

    await ack();
    if (isDuplicate(`view:${view.id}`)) return;

    const slackThreadLink = slackMessageContext.permalink
      ? `\n\n---\n_Created from Slack: ${slackMessageContext.permalink}_`
      : "";

    let issueBody = formValues.body_block?.body_input?.value ?? "";
    let threadMsgs = null;

    if (includeThread && slackMessageContext.threadTs) {
      threadMsgs = await fetchThreadMessages(
        client,
        slackMessageContext.channelId,
        slackMessageContext.threadTs
      );
      const threadContent = await compileThreadWithMeta(client, threadMsgs);
      if (threadContent) {
        issueBody = issueBody ? `${issueBody}\n\n${threadContent}` : threadContent;
      }
    }

    issueBody += slackThreadLink;

    try {
      const createdIssue = await github.createIssue({
        repo: selectedRepo,
        title: issueTitle,
        body: issueBody,
        labels: selectedLabels,
        milestone: milestoneValue ? Number(milestoneValue) : undefined,
      });

      if (selectedProjectId) {
        const projectItemId = await github.addIssueToProject(selectedProjectId, createdIssue.node_id)
          .catch((err) => { console.error("Failed to add issue to project:", err.message); return null; });

        if (projectItemId && slackMessageContext.projectFieldMap) {
          await github.setProjectItemFields(
            selectedProjectId,
            projectItemId,
            slackMessageContext.projectFieldMap,
            formValues
          );
        }
      }

      if (parentIssueInput) {
        await github.linkParentIssue(selectedRepo, parentIssueInput, createdIssue.node_id);
      }

      // Register thread → issue mapping for future tag updates
      if (slackMessageContext.threadTs) {
        if (!threadMsgs) {
          threadMsgs = await fetchThreadMessages(
            client,
            slackMessageContext.channelId,
            slackMessageContext.threadTs
          ).catch(() => []);
        }
        const latestTs = threadMsgs.length > 0
          ? threadMsgs[threadMsgs.length - 1].ts
          : slackMessageContext.threadTs;
        await registerThreadIssue(slackMessageContext.threadTs, selectedRepo, createdIssue.number, latestTs);
      }

      await client.chat.postMessage({
        channel: slackMessageContext.channelId,
        ...(slackMessageContext.threadTs ? { thread_ts: slackMessageContext.threadTs } : {}),
        unfurl_links: false,
        text: `Issue created: <${createdIssue.html_url}|${selectedRepo}#${createdIssue.number} -- ${issueTitle}>`,
      });
    } catch (err) {
      console.error("Failed to create issue:", err);
      await client.chat.postMessage({
        channel: slackMessageContext.userId,
        text: `Failed to create GitHub issue in *${selectedRepo}*: ${safeErrorMessage(err)}`,
      });
    }
  });

  // 13. Add-to-issue modal submitted → add a comment to the specified GitHub issue
  app.view("add_to_issue_modal", async ({ ack, view, client }) => {
    const formValues = view.state.values;
    const slackMessageContext = JSON.parse(view.private_metadata);

    const selectedRepo = formValues.repo_block?.repo_select?.selected_option?.value ?? "";
    const issueNumberRaw = (formValues.issue_number_block?.issue_number_input?.value ?? "").trim();
    const issueNumber = parseInt(issueNumberRaw.replace(/^#/, ""), 10);

    if (!selectedRepo || isNaN(issueNumber)) {
      await ack({
        response_action: "errors",
        errors: {
          ...(!selectedRepo ? { repo_block: "Please select a repository." } : {}),
          ...(isNaN(issueNumber) ? { issue_number_block: "Please enter a valid issue number." } : {}),
        },
      });
      return;
    }

    await ack();

    const includeThread = formValues.thread_block?.include_thread?.selected_options?.some(
      (opt) => opt.value === "include_thread"
    ) ?? false;

    const slackLink = slackMessageContext.permalink
      ? `\n\n---\n_Added from Slack: ${slackMessageContext.permalink}_`
      : "";

    let commentBody = formValues.body_block?.body_input?.value ?? "";

    if (includeThread && slackMessageContext.threadTs) {
      const threadMsgs = await fetchThreadMessages(
        client,
        slackMessageContext.channelId,
        slackMessageContext.threadTs
      );
      const threadContent = await compileThreadWithMeta(client, threadMsgs);
      if (threadContent) {
        commentBody = commentBody ? `${commentBody}\n\n${threadContent}` : threadContent;
      }
    }

    commentBody += slackLink;

    try {
      const comment = await github.addIssueComment(selectedRepo, issueNumber, commentBody);
      await client.chat.postMessage({
        channel: slackMessageContext.channelId,
        ...(slackMessageContext.threadTs ? { thread_ts: slackMessageContext.threadTs } : {}),
        unfurl_links: false,
        text: `Comment added to <${comment.html_url}|${selectedRepo}#${issueNumber}>`,
      });
    } catch (err) {
      console.error("Failed to add comment:", err);
      await client.chat.postMessage({
        channel: slackMessageContext.userId,
        text: `Failed to add comment to *${selectedRepo}#${issueNumber}*: ${safeErrorMessage(err)}`,
      });
    }
  });

  // 14. Card "Create Issue" button → create issue from card state + cardMeta defaults
  app.action("issue_card_create", async ({ ack, action, body, client, respond }) => {
    await ack();
    if (isDuplicate(action.action_ts)) return;

    const cardMeta = JSON.parse(action.value);
    const stateValues = body.state?.values ?? {};

    // Read title from the inline input — falls back to the auto-derived title stored in cardMeta
    const issueTitle =
      stateValues[CARD_TITLE_BLOCK_ID]?.[CARD_TITLE_ACTION_ID]?.value?.trim() || cardMeta.title;

    // Collapse each card field into its final { key, fieldId, isNativeType, selectedOptionId }
    // by layering the user's inline selection over the cardMeta default.
    const selectedCardFields = (cardMeta.cardFields ?? []).map((cardField) => ({
      ...cardField,
      selectedOptionId:
        stateValues[cardFieldBlockId(cardField.key)]?.[cardFieldActionId(cardField.key)]?.selected_option?.value
        ?? cardField.defaultOptionId
        ?? null,
    }));

    const selectedLabelValues =
      stateValues[CARD_LABELS_BLOCK_ID]?.[CARD_LABELS_ACTION_ID]?.selected_options?.map((option) => option.value)
      ?? cardMeta.defaultLabelValues
      ?? [];

    const selectedMilestoneValue =
      stateValues[CARD_MILESTONE_BLOCK_ID]?.[CARD_MILESTONE_ACTION_ID]?.selected_option?.value
      ?? cardMeta.defaultMilestoneValue
      ?? null;

    // Issue body is just the single target message. Thread context is opt-in
    // via a subsequent tag update (butler emoji reaction or @mention with ^).
    // Auto-pulling the thread here would include messages posted after the
    // user's request and the bot's own card messages, producing spam.
    let issueBody = cardMeta.messageText || "";
    if (cardMeta.permalink) {
      issueBody += `\n\n---\n_Created from Slack: ${cardMeta.permalink}_`;
    }

    try {
      const createdIssue = await github.createIssue({
        repo: cardMeta.repo,
        title: issueTitle,
        body: issueBody,
        labels: selectedLabelValues.length > 0 ? selectedLabelValues : undefined,
        milestone:
          selectedMilestoneValue && selectedMilestoneValue !== "" && selectedMilestoneValue !== CARD_MILESTONE_NONE_VALUE
            ? Number(selectedMilestoneValue)
            : undefined,
      });

      // Native issue type is set via updateIssue (independent of any project).
      const nativeTypeField = selectedCardFields.find(
        (cardField) => cardField.isNativeType && cardField.selectedOptionId
      );
      if (nativeTypeField) {
        await github.setIssueType(createdIssue.node_id, nativeTypeField.selectedOptionId);
      }

      if (cardMeta.projectId) {
        const projectItemId = await github
          .addIssueToProject(cardMeta.projectId, createdIssue.node_id)
          .catch((err) => {
            console.error("Failed to add card issue to project:", err?.message ?? err);
            return null;
          });

        if (projectItemId) {
          const projectFieldUpdates = selectedCardFields
            .filter((cardField) => !cardField.isNativeType && cardField.fieldId && cardField.selectedOptionId)
            .map((cardField) =>
              github
                .setProjectField(cardMeta.projectId, projectItemId, cardField.fieldId, {
                  singleSelectOptionId: cardField.selectedOptionId,
                })
                .catch((err) => console.error(`Failed to set ${cardField.key}:`, err?.message ?? err))
            );

          await Promise.all(projectFieldUpdates);
        }
      }

      await respond({ delete_original: true });

      // Post the confirmation first so we can use its ts as lastSyncedTs — this prevents
      // the bot's own "Issue created" message from being included in the next tag update.
      const confirmMsg = await client.chat.postMessage({
        channel: cardMeta.channelId,
        ...(cardMeta.threadTs ? { thread_ts: cardMeta.threadTs } : {}),
        unfurl_links: false,
        text: `Issue created: <${createdIssue.html_url}|${cardMeta.repo}#${createdIssue.number} -- ${issueTitle}>`,
      });

      if (cardMeta.threadTs) {
        const latestTs = confirmMsg?.ts ?? cardMeta.threadTs;
        await registerThreadIssue(cardMeta.threadTs, cardMeta.repo, createdIssue.number, latestTs);
      }
    } catch (err) {
      console.error("Card issue creation failed:", err);
      await respond({
        replace_original: true,
        text: `Failed to create issue: ${safeErrorMessage(err)}`,
      });
    }
  });

  // 15. Card "Customize" button → open the full form modal pre-filled from card state
  app.action("issue_card_customize", async ({ ack, action, body, client, respond }) => {
    await ack();
    if (isDuplicate(action.action_ts)) return;

    const cardMeta = JSON.parse(action.value);
    const stateValues = body.state?.values ?? {};

    const currentLabelValues =
      stateValues[CARD_LABELS_BLOCK_ID]?.[CARD_LABELS_ACTION_ID]?.selected_options?.map((option) => option.value)
      ?? cardMeta.defaultLabelValues
      ?? [];

    const currentMilestoneValue =
      stateValues[CARD_MILESTONE_BLOCK_ID]?.[CARD_MILESTONE_ACTION_ID]?.selected_option?.value
      ?? cardMeta.defaultMilestoneValue
      ?? null;

    const [repoOptions, labels, milestones, projects, projectFields] = await Promise.all([
      github.getRepos(),
      github.getLabels(cardMeta.repo),
      github.getMilestones(cardMeta.repo),
      github.getProjects(),
      cardMeta.projectId ? github.getProjectFields(cardMeta.projectId).catch(() => []) : Promise.resolve([]),
    ]);

    const initialProjectFieldValues = collectCardProjectFieldValues(projectFields, stateValues, cardMeta);

    const slackMessageContext = {
      channelId: cardMeta.channelId,
      threadTs: cardMeta.threadTs,
      userId: cardMeta.userId,
      permalink: cardMeta.permalink,
      projectFieldMap: buildProjectFieldMap(projectFields),
    };

    const currentTitle =
      stateValues[CARD_TITLE_BLOCK_ID]?.[CARD_TITLE_ACTION_ID]?.value?.trim() || cardMeta.title;

    await client.views.open({
      trigger_id: body.trigger_id,
      view: buildModal({
        selectedRepo: cardMeta.repo,
        metadata: slackMessageContext,
        currentTitle,
        currentBody: cardMeta.messageText,
        labels,
        milestones,
        projects,
        projectFields,
        initialProjectId: cardMeta.projectId,
        initialLabelValues: currentLabelValues,
        initialMilestoneValue: currentMilestoneValue,
        initialProjectFieldValues,
        repoOptions,
      }),
    });

    await respond({ delete_original: true });
  });

  // 16. Card "Cancel" button → dismiss the card and release the card claim so
  // the user can react again later if they change their mind.
  app.action("issue_card_cancel", async ({ ack, action, respond }) => {
    await ack();
    await respond({ delete_original: true });
    try {
      const { threadTs } = JSON.parse(action.value);
      if (threadTs) await releaseCardPost(threadTs);
    } catch {
      // value may be legacy "cancel" string — nothing to release
    }
  });

  // 17. No-op handler for card dropdown interactions.
  // The card uses section accessories (static_select / multi_static_select),
  // so Slack fires an action event on every dropdown change.
  // We ack immediately and let state accumulate in body.state.values for
  // when the Create button is pressed.
  app.action(/^card_/, async ({ ack }) => {
    await ack();
  });
}