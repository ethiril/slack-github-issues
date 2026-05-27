// Flows that turn Slack thread activity into GitHub issues or comments: the
// @mention handler (buttons + caret shortcuts), the emoji-reaction handler, and
// the "Add to GitHub Issue" shortcut/modal that appends a comment to an
// existing issue.

import { getUserDefaults } from "../defaults.js";
import { buildAddToIssueModal } from "../modal.js";
import {
  fetchThreadMessages,
  compileThreadWithMeta,
  extractMessageText,
  resolveThreadRootMessage,
} from "../thread.js";
import { getThreadIssue, claimCardPost, releaseCardPost, claimEvent } from "../thread-store.js";
import {
  isValidRepoName,
  parseCaretCommand,
  safeErrorMessage,
  appendThreadUpdateToIssue,
  postIssueCard,
  postEphemeral,
  postRepoNotFound,
} from "./helpers.js";

export function registerThreadSync(app, github) {
  // @mention in a thread → ephemeral message with Create Issue + Quick Create buttons
  // Workaround: Slack does not provide a trigger_id on message events,
  // so a modal cannot be opened directly. The button click provides one.
  //
  // Usage:
  //   @GitHub Butler                 → show buttons (normal flow)
  //   @GitHub Butler some title      → pre-fill title in buttons
  //   @GitHub Butler ^               → card seeded from the thread's root message,
  //                                    or a thread update if the thread already has an issue
  //   @GitHub Butler <repo> ^        → same, using <repo> instead of the saved default
  //   @GitHub Butler <repo> <num> ^  → append the full thread to <repo>#<num> (any ticket),
  //                                    and remember it so later bare `^` tags append there too
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

      // Cross-instance dedup: drop Lambda retries of this same mention event,
      // even when the retry lands on a different instance. Claiming here guards
      // both the tag-update and the new-card paths so one tag can't both create
      // an issue and append a thread update.
      if (!(await claimEvent(`mention:${event.ts}`))) return;

      const defaults = getUserDefaults(userId);
      const { repoOverride, issueNumber } = parseCaretCommand(rawText);

      // Explicit ticket update: "@Butler <repo> <number> ^" appends the full
      // thread to that ticket (even one Butler didn't create) and records the
      // mapping so later bare `^` tags append to it too.
      if (issueNumber != null) {
        const repo = repoOverride ?? defaults.repo ?? null;
        if (!repo) {
          await postEphemeral(client, {
            channel: event.channel,
            user: userId,
            threadTs,
            text: "No default repo saved. Specify one: `@GitHub Butler <repo-name> <number> ^`.",
          });
          return;
        }
        if (!(await github.repoExists(repo))) {
          await postRepoNotFound(client, { channel: event.channel, user: userId, threadTs, repo });
          return;
        }
        await appendThreadUpdateToIssue(client, github, {
          channelId: event.channel,
          threadTs,
          userId,
          existingIssue: { repo, issueNumber, lastSyncedTs: undefined, parentIncluded: false },
        });
        return;
      }

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

      // No existing issue → show card seeded from the thread's original message
      const repo = repoOverride ?? defaults.repo ?? null;

      if (!repo) {
        await postEphemeral(client, {
          channel: event.channel,
          user: userId,
          threadTs,
          text: "No default repo saved. Use *Create Issue* (form) once to set your preferences, or specify a repo: `@GitHub Butler <repo-name> ^`.",
        });
        return;
      }

      if (repoOverride) {
        console.log(`[mention/caret] using repo override: ${repoOverride}`);
      }

      // Check repo existence before claiming the thread. getLabels/getMilestones
      // swallow 404s, so without this a typo produces a bogus card and leaves a
      // stale claim that blocks any retry (reaction or tag) on this thread.
      if (!(await github.repoExists(repo))) {
        await postRepoNotFound(client, { channel: event.channel, user: userId, threadTs, repo });
        return;
      }

      let prevMessage = null;

      if (event.thread_ts) {
        // In a thread: seed from the thread's root message (the one that started
        // the thread), not whatever message happened to be above this @mention.
        prevMessage = (await resolveThreadRootMessage(client, event.channel, event.thread_ts)).root;
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
        await postEphemeral(client, {
          channel: event.channel,
          user: userId,
          threadTs,
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
        parentIncluded: prevMessage.ts === threadTs,
        seedTs: prevMessage.ts,
        seedMessage: prevMessage,
      }).catch(async (err) => {
        console.error("Failed to post issue card from caret mention:", err);
        // Release the claim on failure so the user can try again
        await releaseCardPost(threadTs).catch(() => {});
        await postEphemeral(client, {
          channel: event.channel,
          user: userId,
          threadTs,
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
      parentIncluded: false,
    };

    await postEphemeral(client, {
      channel: event.channel,
      user: event.user,
      threadTs,
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

  // Emoji reaction → show issue card or append to existing thread issue
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

    // Cross-instance dedup: drop Lambda retries of this reaction even when the
    // retry lands on a different instance.
    if (!(await claimEvent(`reaction:${event.event_ts ?? messageTs}`))) {
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
      await postEphemeral(client, {
        channel: channelId,
        user: userId,
        threadTs,
        text: "No default repo saved. Use *Create Issue* (form) once to set your preferences, or use a repo-specific emoji like `:frontend_github_butler:`.",
      });
      return;
    }

    // Check repo existence before claiming the thread. getLabels/getMilestones
    // swallow 404s, so without this a mis-named emoji produces a bogus card and
    // leaves a stale claim that blocks any retry (mention or tag) on this thread.
    if (!(await github.repoExists(repo))) {
      await postRepoNotFound(client, { channel: channelId, user: userId, threadTs, repo });
      return;
    }

    // Cross-instance dedup: claim the card post in DynamoDB / in-memory.
    // If another Lambda instance already claimed it, bail out silently.
    const claimed = await claimCardPost(threadTs).catch(() => true); // on error, proceed
    if (!claimed) {
      console.log("[reaction] card already claimed for thread, skipping", { threadTs });
      return;
    }

    // Seed from the thread's root message rather than the reacted message, so a
    // reaction anywhere in a thread builds the issue from the original message.
    // For a non-threaded message the root is that message itself.
    const seedMessage = (await resolveThreadRootMessage(client, channelId, threadTs)).root ?? message;
    const seedTs = seedMessage.ts;

    const permalinkResult = await client.chat.getPermalink({
      channel: channelId,
      message_ts: seedTs,
    }).catch(() => null);

    await postIssueCard({
      client,
      github,
      channelId,
      threadTs,
      userId,
      messageText: extractMessageText(seedMessage),
      permalink: permalinkResult?.permalink ?? "",
      repo,
      parentIncluded: seedTs === threadTs,
      seedTs,
      seedMessage,
    }).catch(async (err) => {
      console.error("Failed to post issue card:", err);
      // Release the claim on failure so the user can react again
      await releaseCardPost(threadTs).catch(() => {});
      await postEphemeral(client, {
        channel: channelId,
        user: userId,
        threadTs,
        text: `Failed to create issue card: ${safeErrorMessage(err)}`,
      });
    });
  });

  // "Add to GitHub Issue" message shortcut → open the add-to-issue modal
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

  // Add-to-issue modal submitted → add a comment to the specified GitHub issue
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
}
