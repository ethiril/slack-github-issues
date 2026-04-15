// Pure card-building functions. No I/O, no side effects.
//
// buildIssueCard produces the Slack blocks for the inline issue-creation card
// that is posted as an ephemeral message after an emoji reaction or a Quick
// Create button click. The card carries all state needed for creation in the
// Create/Customize button `value` field (cardMeta JSON), and reads inline
// dropdown selections from body.state.values when the button is pressed.
//
// Dropdown option values are GitHub option IDs (not names), so cardMeta does
// not need to carry a name→ID map. This keeps button value JSON well under
// Slack's 2000-char limit.

import { toSlackOption } from "./modal.js";

const MAX_SELECT_OPTIONS = 100;
const MAX_BUTTON_VALUE_CHARS = 2000;

function takeOptions(items, limit = MAX_SELECT_OPTIONS) {
  return Array.isArray(items) ? items.slice(0, limit) : [];
}

function fitCardMeta(cardMeta) {
  const fitted = { ...cardMeta };

  if (Array.isArray(cardMeta?.defaultLabelValues)) {
    fitted.defaultLabelValues = [...cardMeta.defaultLabelValues];
  }

  while (
    JSON.stringify(fitted).length > MAX_BUTTON_VALUE_CHARS &&
    Array.isArray(fitted.defaultLabelValues) &&
    fitted.defaultLabelValues.length > 0
  ) {
    fitted.defaultLabelValues.pop();
  }

  if (JSON.stringify(fitted).length > MAX_BUTTON_VALUE_CHARS) {
    fitted.permalink = "";
  }

  if (JSON.stringify(fitted).length > MAX_BUTTON_VALUE_CHARS) {
    fitted.messageText = String(fitted.messageText ?? "").slice(0, 100);
  }

  if (JSON.stringify(fitted).length > MAX_BUTTON_VALUE_CHARS) {
    fitted.messageText = "";
  }

  if (JSON.stringify(fitted).length > MAX_BUTTON_VALUE_CHARS) {
    fitted.title = String(fitted.title ?? "").slice(0, 100);
  }

  return fitted;
}

export function buildIssueCard({
  repo,
  title,
  labels = [],
  milestones = [],
  priorityField = null,
  statusField = null,
  typeField = null,
  defaultLabelValues = [],
  defaultMilestoneValue = null,
  cardMeta,
}) {
  const safePriorityOptions = takeOptions(priorityField?.options);
  const safeStatusOptions = takeOptions(statusField?.options);
  const safeLabels = takeOptions(labels);
  const safeMilestones = takeOptions(milestones, MAX_SELECT_OPTIONS - 1);
  const safeCardMeta = fitCardMeta(cardMeta);

  const blocks = [
    {
      type: "section",
      block_id: "card_intro",
      text: {
        type: "mrkdwn",
        text: `*New issue in ${repo}*`,
      },
    },
    {
      type: "input",
      block_id: "card_title_block",
      optional: true,
      label: { type: "plain_text", text: "Issue title" },
      element: {
        type: "plain_text_input",
        action_id: "card_title_input",
        initial_value: title || "",
        placeholder: { type: "plain_text", text: "Brief summary" },
      },
    },
  ];

  const safeTypeOptions = takeOptions(typeField?.options);

  if (safeTypeOptions.length > 0) {
    blocks.push({
      type: "section",
      block_id: "card_type",
      text: {
        type: "mrkdwn",
        text: "*Type*",
      },
      accessory: {
        type: "static_select",
        action_id: "card_type_select",
        placeholder: { type: "plain_text", text: "Type" },
        options: safeTypeOptions.map((o) => toSlackOption(o.name, o.id)),
      },
    });
  }

  if (safePriorityOptions.length > 0) {
    const defaultOpt =
      safePriorityOptions.find((o) => /high|p0/i.test(o.name)) ?? safePriorityOptions[0];

    blocks.push({
      type: "section",
      block_id: "card_priority",
      text: {
        type: "mrkdwn",
        text: "*Priority*",
      },
      accessory: {
        type: "static_select",
        action_id: "card_priority_select",
        placeholder: { type: "plain_text", text: "Priority" },
        initial_option: toSlackOption(defaultOpt.name, defaultOpt.id),
        options: safePriorityOptions.map((o) => toSlackOption(o.name, o.id)),
      },
    });
  }

  if (safeStatusOptions.length > 0) {
    const defaultOpt =
      safeStatusOptions.find((o) => /backlog/i.test(o.name)) ?? safeStatusOptions[0];

    blocks.push({
      type: "section",
      block_id: "card_status",
      text: {
        type: "mrkdwn",
        text: "*Status*",
      },
      accessory: {
        type: "static_select",
        action_id: "card_status_select",
        placeholder: { type: "plain_text", text: "Status" },
        initial_option: toSlackOption(defaultOpt.name, defaultOpt.id),
        options: safeStatusOptions.map((o) => toSlackOption(o.name, o.id)),
      },
    });
  }

  if (safeLabels.length > 0) {
    const preSelected = safeLabels.filter((l) => defaultLabelValues.includes(l.value));

    blocks.push({
      type: "section",
      block_id: "card_labels",
      text: {
        type: "mrkdwn",
        text: "*Labels*",
      },
      accessory: {
        type: "multi_static_select",
        action_id: "card_labels_select",
        placeholder: { type: "plain_text", text: "Labels" },
        options: safeLabels.map((l) => toSlackOption(l.text, l.value)),
        ...(preSelected.length > 0
          ? { initial_options: preSelected.map((l) => toSlackOption(l.text, l.value)) }
          : {}),
      },
    });
  }

  if (safeMilestones.length > 0) {
    const preSelected = safeMilestones.find((m) => m.value === defaultMilestoneValue);

    blocks.push({
      type: "section",
      block_id: "card_milestone",
      text: {
        type: "mrkdwn",
        text: "*Milestone*",
      },
      accessory: {
        type: "static_select",
        action_id: "card_milestone_select",
        placeholder: { type: "plain_text", text: "Milestone (optional)" },
        options: [
          toSlackOption("No milestone", "__none__"),
          ...safeMilestones.map((m) => toSlackOption(m.text, m.value)),
        ],
        ...(preSelected
          ? { initial_option: toSlackOption(preSelected.text, preSelected.value) }
          : {}),
      },
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
          value: JSON.stringify(safeCardMeta),
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Customize" },
          action_id: "issue_card_customize",
          value: JSON.stringify(safeCardMeta),
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Cancel" },
          action_id: "issue_card_cancel",
          style: "danger",
          value: JSON.stringify({ threadTs: safeCardMeta.threadTs }),
        },
      ],
    }
  );

  return blocks;
}

// Build the compact JSON stored in the Create/Customize button value fields.
// Slack button values are limited to 2000 chars — keep this lean:
//   - messageText capped at 200 chars (thread content is re-fetched on submit)
//   - title capped at 150 chars
//   - option IDs stored as scalar defaults, not as full name→ID maps
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
  typeField = null,
  isNativeType = false,
  defaultLabelValues = [],
  defaultMilestoneValue = null,
}) {
  return {
    repo,
    title: String(title).slice(0, 150),
    messageText: String(messageText).slice(0, 200),
    channelId,
    threadTs,
    userId,
    permalink,
    projectId,
    priorityFieldId: priorityField?.id ?? null,
    defaultPriorityOptionId:
      priorityField?.options?.find((o) => /high|p0/i.test(o.name))?.id ??
      priorityField?.options?.[0]?.id ??
      null,
    statusFieldId: statusField?.id ?? null,
    defaultStatusOptionId:
      statusField?.options?.find((o) => /backlog/i.test(o.name))?.id ??
      statusField?.options?.[0]?.id ??
      null,
    typeFieldId: typeField?.id ?? null,
    isNativeType: isNativeType || false,
    defaultTypeOptionId: null,
    defaultLabelValues,
    defaultMilestoneValue,
  };
}