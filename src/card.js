// Pure card-building functions. No I/O, no side effects.
//
// buildIssueCard produces the Slack blocks for the inline issue-creation card
// that is posted as an ephemeral message after an emoji reaction or a Quick
// Create button click. The card carries all state needed for creation in the
// Create button's `value` field (cardMeta JSON), and reads inline dropdown
// selections from body.state.values when the button is pressed.
//
// Option values in the dropdowns are the human-readable option NAMES (e.g.
// "High", "Backlog"). cardMeta maps those names back to the GitHub option IDs
// needed by the GraphQL mutation, keeping option values well within Slack's
// 75-char limit.

import { toSlackOption } from "./modal.js";

export function buildIssueCard({
  repo,
  title,
  labels = [],
  milestones = [],
  priorityField = null,
  statusField = null,
  defaultLabelValues = [],
  defaultMilestoneValue = null,
  cardMeta,
}) {
  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*New issue in ${repo}*\n${title}`,
      },
    },
    { type: "divider" },
  ];

  // Row: priority, status, labels (up to 5 elements per actions block)
  const selectionElements = [];

  if (priorityField?.options?.length > 0) {
    const defaultOpt =
      priorityField.options.find((o) => /high/i.test(o.name)) ?? priorityField.options[0];
    selectionElements.push({
      type: "static_select",
      action_id: "card_priority_select",
      placeholder: { type: "plain_text", text: "Priority" },
      initial_option: toSlackOption(defaultOpt.name, defaultOpt.name),
      options: priorityField.options.map((o) => toSlackOption(o.name, o.name)),
    });
  }

  if (statusField?.options?.length > 0) {
    const defaultOpt =
      statusField.options.find((o) => /backlog/i.test(o.name)) ?? statusField.options[0];
    selectionElements.push({
      type: "static_select",
      action_id: "card_status_select",
      placeholder: { type: "plain_text", text: "Status" },
      initial_option: toSlackOption(defaultOpt.name, defaultOpt.name),
      options: statusField.options.map((o) => toSlackOption(o.name, o.name)),
    });
  }

  if (labels.length > 0) {
    const preSelected = labels.filter((l) => defaultLabelValues.includes(l.value));
    selectionElements.push({
      type: "multi_static_select",
      action_id: "card_labels_select",
      placeholder: { type: "plain_text", text: "Labels" },
      options: labels.map((l) => toSlackOption(l.text, l.value)),
      ...(preSelected.length > 0
        ? { initial_options: preSelected.map((l) => toSlackOption(l.text, l.value)) }
        : {}),
    });
  }

  if (selectionElements.length > 0) {
    blocks.push({
      type: "actions",
      block_id: "card_selections",
      elements: selectionElements,
    });
  }

  if (milestones.length > 0) {
    const preSelected = milestones.find((m) => m.value === defaultMilestoneValue);
    blocks.push({
      type: "actions",
      block_id: "card_milestone",
      elements: [
        {
          type: "static_select",
          action_id: "card_milestone_select",
          placeholder: { type: "plain_text", text: "Milestone (optional)" },
          options: [
            toSlackOption("No milestone", ""),
            ...milestones.map((m) => toSlackOption(m.text, m.value)),
          ],
          ...(preSelected
            ? { initial_option: toSlackOption(preSelected.text, preSelected.value) }
            : {}),
        },
      ],
    });
  }

  blocks.push(
    { type: "divider" },
    {
      type: "actions",
      block_id: "card_actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Create Issue" },
          action_id: "issue_card_create",
          style: "primary",
          value: JSON.stringify(cardMeta),
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Customize" },
          action_id: "issue_card_customize",
          value: JSON.stringify(cardMeta),
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Cancel" },
          action_id: "issue_card_cancel",
          style: "danger",
          value: "cancel",
        },
      ],
    }
  );

  return blocks;
}

// Build the cardMeta object that is stored in the Create/Customize button values.
// Keeps the JSON compact: messageText is capped at 500 chars, title at 150.
// priorityOptions / statusOptions are name → optionId maps so we can set
// GitHub project fields without re-fetching on submit.
export function buildCardMeta({
  repo,
  title,
  messageText = "",
  channelId,
  threadTs,
  userId,
  permalink = "",
  projectId = null,
  priorityField = null,
  statusField = null,
  defaultLabelValues = [],
  defaultMilestoneValue = null,
}) {
  return {
    repo,
    title: String(title).slice(0, 150),
    messageText: String(messageText).slice(0, 500),
    channelId,
    threadTs,
    userId,
    permalink,
    projectId,
    priorityFieldId: priorityField?.id ?? null,
    priorityOptions: priorityField?.options
      ? Object.fromEntries(priorityField.options.map((o) => [o.name, o.id]))
      : null,
    defaultPriority:
      priorityField?.options?.find((o) => /high/i.test(o.name))?.name ??
      priorityField?.options?.[0]?.name ??
      null,
    statusFieldId: statusField?.id ?? null,
    statusOptions: statusField?.options
      ? Object.fromEntries(statusField.options.map((o) => [o.name, o.id]))
      : null,
    defaultStatus:
      statusField?.options?.find((o) => /backlog/i.test(o.name))?.name ??
      statusField?.options?.[0]?.name ??
      null,
    defaultLabelValues,
    defaultMilestoneValue,
  };
}
