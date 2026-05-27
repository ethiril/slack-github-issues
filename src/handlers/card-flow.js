// The inline issue-creation card: the Quick Create button that posts it, the
// Create button that turns card state into a GitHub issue, the Customize button
// that re-opens the full modal pre-filled from card state, Cancel, and the
// no-op acknowledger for the card's inline dropdowns.

import { getUserDefaults } from "../defaults.js";
import { buildModal, buildProjectFieldMap } from "../modal.js";
import {
  fetchThreadMessages,
  compileThreadWithMeta,
  deriveBotAlertTitle,
  extractMessageText,
} from "../thread.js";
import { registerThreadIssue, releaseCardPost, claimEvent } from "../thread-store.js";
import {
  cardFieldBlockId,
  cardFieldActionId,
  CARD_TITLE_BLOCK_ID,
  CARD_TITLE_ACTION_ID,
  CARD_LABELS_BLOCK_ID,
  CARD_LABELS_ACTION_ID,
  CARD_MILESTONE_BLOCK_ID,
  CARD_MILESTONE_ACTION_ID,
  CARD_MILESTONE_NONE_VALUE,
  CARD_ASSIGNEES_BLOCK_ID,
  CARD_ASSIGNEES_ACTION_ID,
} from "../card.js";
import {
  isDuplicate,
  safeErrorMessage,
  postEphemeral,
  postIssueCard,
  collectCardProjectFieldValues,
  fetchRepoFormData,
} from "./helpers.js";

export function registerCardFlow(app, github) {
  // "Quick Create" button from @mention → show the issue card
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
      await postEphemeral(client, {
        channel: slackMessageContext.channelId,
        user: userId,
        threadTs: slackMessageContext.threadTs,
        text: `Failed to create issue card: ${safeErrorMessage(err)}`,
      });
    });
  });

  // Card "Create Issue" button → create issue from card state + cardMeta defaults
  app.action("issue_card_create", async ({ ack, action, body, client, respond }) => {
    await ack();
    // Cross-instance dedup: a retried button action must not create a 2nd issue.
    if (!(await claimEvent(`card_create:${action.action_ts}`))) return;

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

    const selectedAssigneeLogins =
      stateValues[CARD_ASSIGNEES_BLOCK_ID]?.[CARD_ASSIGNEES_ACTION_ID]?.selected_options?.map((option) => option.value)
      ?? cardMeta.defaultAssigneeLogins
      ?? [];

    // Re-fetch the full thread live instead of trusting cardMeta.messageText:
    // fitCardMeta may have truncated or dropped that field to keep the button
    // value under Slack's 2000-char limit, which would leave the issue body
    // empty for bot alerts (Sentry etc.) with long extracted content. We also
    // need the non-seed messages so any replies that existed at creation time
    // get folded into the issue body (compileThreadWithMeta filters out
    // Butler's own messages, so the card post itself is excluded).
    const allThreadMessages = (cardMeta.seedTs && cardMeta.channelId && cardMeta.threadTs)
      ? await fetchThreadMessages(client, cardMeta.channelId, cardMeta.threadTs).catch(() => [])
      : [];
    const liveSeed = cardMeta.seedTs
      ? allThreadMessages.find((m) => m.ts === cardMeta.seedTs) ?? null
      : null;

    let issueTitleFinal = issueTitle;
    let issueBody = cardMeta.messageText || "";
    if (liveSeed) {
      const liveText = extractMessageText(liveSeed);
      if (liveText) {
        const userTypedTitle = stateValues[CARD_TITLE_BLOCK_ID]?.[CARD_TITLE_ACTION_ID]?.value?.trim();
        const botAlertTitle = deriveBotAlertTitle(liveSeed);
        if (botAlertTitle) {
          if (!userTypedTitle) issueTitleFinal = botAlertTitle;
          // Title is synthesised separately from the body, so keep the full
          // extracted content in the body rather than dropping the first line.
          issueBody = liveText.trim();
        } else {
          const liveLines = liveText.split("\n");
          const liveBody = liveLines.slice(1).join("\n").trim();
          if (!userTypedTitle) issueTitleFinal = liveLines[0].trim() || issueTitleFinal;
          if (liveBody) issueBody = liveBody;
        }
      }
    }

    if (cardMeta.seedTs && allThreadMessages.length > 1) {
      const otherMessages = allThreadMessages.filter((m) => m.ts !== cardMeta.seedTs);
      const otherThreadContent = await compileThreadWithMeta(client, otherMessages, {
        channel: cardMeta.channelId,
      });
      if (otherThreadContent) {
        issueBody = issueBody ? `${issueBody}\n\n${otherThreadContent}` : otherThreadContent;
      }
    }

    if (cardMeta.permalink) {
      issueBody += `\n\n---\n_Created from Slack: ${cardMeta.permalink}_`;
    }

    try {
      const createdIssue = await github.createIssue({
        repo: cardMeta.repo,
        title: issueTitleFinal,
        body: issueBody,
        labels: selectedLabelValues.length > 0 ? selectedLabelValues : undefined,
        milestone:
          selectedMilestoneValue && selectedMilestoneValue !== "" && selectedMilestoneValue !== CARD_MILESTONE_NONE_VALUE
            ? Number(selectedMilestoneValue)
            : undefined,
        assignees: selectedAssigneeLogins,
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
        text: `Issue created: <${createdIssue.html_url}|${cardMeta.repo}#${createdIssue.number} -- ${issueTitleFinal}>`,
      });

      if (cardMeta.threadTs) {
        const latestTs = confirmMsg?.ts ?? cardMeta.threadTs;
        await registerThreadIssue(cardMeta.threadTs, cardMeta.repo, createdIssue.number, latestTs, cardMeta.parentIncluded === true);
      }
    } catch (err) {
      console.error("Card issue creation failed:", err);
      await respond({
        replace_original: true,
        text: `Failed to create issue: ${safeErrorMessage(err)}`,
      });
    }
  });

  // Card "Customize" button → open the full form modal pre-filled from card state
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

    const currentAssigneeValues =
      stateValues[CARD_ASSIGNEES_BLOCK_ID]?.[CARD_ASSIGNEES_ACTION_ID]?.selected_options?.map((option) => option.value)
      ?? cardMeta.defaultAssigneeLogins
      ?? [];

    // Re-fetch the seed to fill the modal with the full body, since fitCardMeta
    // may have truncated cardMeta.messageText to fit the card button value.
    const liveSeedPromise = cardMeta.seedTs && cardMeta.channelId && cardMeta.threadTs
      ? fetchThreadMessages(client, cardMeta.channelId, cardMeta.threadTs)
          .then((msgs) => msgs.find((m) => m.ts === cardMeta.seedTs) ?? null)
          .catch(() => null)
      : Promise.resolve(null);

    const [{ repoOptions, labels, milestones, assignees, projects, projectFields }, liveSeed] = await Promise.all([
      fetchRepoFormData(github, cardMeta.repo, { projectId: cardMeta.projectId, includeTemplates: false }),
      liveSeedPromise,
    ]);

    const initialProjectFieldValues = collectCardProjectFieldValues(projectFields, stateValues, cardMeta);

    const slackMessageContext = {
      channelId: cardMeta.channelId,
      threadTs: cardMeta.threadTs,
      userId: cardMeta.userId,
      permalink: cardMeta.permalink,
      projectFieldMap: buildProjectFieldMap(projectFields),
      parentIncluded: cardMeta.parentIncluded === true,
    };

    let liveTitleFromSeed = null;
    let liveBodyFromSeed = null;
    if (liveSeed) {
      const liveText = extractMessageText(liveSeed);
      if (liveText) {
        const botAlertTitle = deriveBotAlertTitle(liveSeed);
        if (botAlertTitle) {
          liveTitleFromSeed = botAlertTitle;
          liveBodyFromSeed = liveText.trim() || null;
        } else {
          const liveLines = liveText.split("\n");
          liveTitleFromSeed = liveLines[0].trim() || null;
          liveBodyFromSeed = liveLines.slice(1).join("\n").trim() || null;
        }
      }
    }

    const currentTitle =
      stateValues[CARD_TITLE_BLOCK_ID]?.[CARD_TITLE_ACTION_ID]?.value?.trim()
      || liveTitleFromSeed
      || cardMeta.title;

    await client.views.open({
      trigger_id: body.trigger_id,
      view: buildModal({
        selectedRepo: cardMeta.repo,
        metadata: slackMessageContext,
        currentTitle,
        currentBody: liveBodyFromSeed ?? cardMeta.messageText,
        labels,
        milestones,
        assignees,
        projects,
        projectFields,
        initialProjectId: cardMeta.projectId,
        initialLabelValues: currentLabelValues,
        initialMilestoneValue: currentMilestoneValue,
        initialAssigneeValues: currentAssigneeValues,
        initialProjectFieldValues,
        repoOptions,
      }),
    });

    await respond({ delete_original: true });
  });

  // Card "Cancel" button → dismiss the card and release the card claim so
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

  // No-op handler for card dropdown interactions.
  // The card uses section accessories (static_select / multi_static_select),
  // so Slack fires an action event on every dropdown change.
  // We ack immediately and let state accumulate in body.state.values for
  // when the Create button is pressed.
  app.action(/^card_/, async ({ ack }) => {
    await ack();
  });
}
