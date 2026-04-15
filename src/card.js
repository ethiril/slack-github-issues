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

// Prominent single-select fields rendered as card accessories.
// Order here is the display order on the card. Adding a new prominent card
// field is a one-line change: give it a key, a label, a project-field name
// matcher, and a default-option matcher (or null for "first option"). Set
// `noDefault: true` to leave the field unselected by default.
const CARD_FIELD_SPECS = [
  { key: "type",     label: "Type",     fieldNameMatcher: /^type$/i,   defaultOptionMatcher: null },
  { key: "priority", label: "Priority", fieldNameMatcher: /priority/i, defaultOptionMatcher: /high|p0/i },
  { key: "severity", label: "Severity", fieldNameMatcher: /severity/i, defaultOptionMatcher: null, noDefault: true },
  { key: "status",   label: "Status",   fieldNameMatcher: /status/i,   defaultOptionMatcher: /backlog/i },
];

// Returns `card_<key>` / `card_<key>_select` — the stable IDs used for the
// inline Slack block, its action, and the no-op `^card_` action matcher.
export function cardFieldBlockId(cardFieldKey) {
  return `card_${cardFieldKey}`;
}
export function cardFieldActionId(cardFieldKey) {
  return `${cardFieldBlockId(cardFieldKey)}_select`;
}

// Stable IDs for the non-single-select card blocks (title, labels, milestone).
// Handlers reference these when reading back the user's inline selections; the
// card builder uses them when emitting the blocks. Keeping them here ensures
// both sides stay in sync.
export const CARD_TITLE_BLOCK_ID = "card_title_block";
export const CARD_TITLE_ACTION_ID = "card_title_input";
export const CARD_LABELS_BLOCK_ID = "card_labels";
export const CARD_LABELS_ACTION_ID = "card_labels_select";
export const CARD_MILESTONE_BLOCK_ID = "card_milestone";
export const CARD_MILESTONE_ACTION_ID = "card_milestone_select";
export const CARD_MILESTONE_NONE_VALUE = "__none__";

function takeOptions(items, limit = MAX_SELECT_OPTIONS) {
  return Array.isArray(items) ? items.slice(0, limit) : [];
}

function pickDefaultOption(options, defaultOptionMatcher) {
  if (!Array.isArray(options) || options.length === 0) return null;
  if (defaultOptionMatcher) {
    return options.find((option) => defaultOptionMatcher.test(option?.name ?? "")) ?? options[0];
  }
  return options[0];
}

// Resolve CARD_FIELD_SPECS against the project's fields (and native org-level
// issue types for the "type" slot). A project field named "Type" takes
// precedence over native issue types; if no Type project field exists, the
// native issue types (if any) populate the Type slot instead.
//
// Returns an array of resolved card fields ready for rendering and persistence:
//   { key, label, fieldId, isNativeType, options, defaultOptionId }
export function resolveCardFields(projectFields = [], nativeIssueTypes = []) {
  const resolvedCardFields = [];

  for (const spec of CARD_FIELD_SPECS) {
    const matchingProjectField = projectFields.find((field) =>
      spec.fieldNameMatcher.test(field?.name ?? "")
    );

    if (matchingProjectField?.options?.length > 0) {
      resolvedCardFields.push({
        key: spec.key,
        label: spec.label,
        fieldId: matchingProjectField.id ?? null,
        isNativeType: false,
        options: matchingProjectField.options,
        defaultOptionId: spec.noDefault
          ? null
          : pickDefaultOption(matchingProjectField.options, spec.defaultOptionMatcher)?.id ?? null,
      });
      continue;
    }

    if (spec.key === "type" && nativeIssueTypes?.length > 0) {
      resolvedCardFields.push({
        key: spec.key,
        label: spec.label,
        fieldId: null,
        isNativeType: true,
        options: nativeIssueTypes,
        defaultOptionId: spec.noDefault
          ? null
          : pickDefaultOption(nativeIssueTypes, spec.defaultOptionMatcher)?.id ?? null,
      });
    }
  }

  return resolvedCardFields;
}

// Truncate cardMeta fields progressively so its JSON fits under Slack's 2000-char
// button value limit. Drops non-essential data first (extra labels, permalink,
// body text), then truncates title last. Serialized length is cached and only
// recomputed after each mutation to avoid repeatedly stringifying the whole
// object.
function fitCardMeta(cardMeta) {
  const fitted = { ...cardMeta };

  if (Array.isArray(cardMeta?.defaultLabelValues)) {
    fitted.defaultLabelValues = [...cardMeta.defaultLabelValues];
  }

  let serializedLength = JSON.stringify(fitted).length;
  const isOverLimit = () => serializedLength > MAX_BUTTON_VALUE_CHARS;
  const remeasure = () => { serializedLength = JSON.stringify(fitted).length; };

  while (
    isOverLimit() &&
    Array.isArray(fitted.defaultLabelValues) &&
    fitted.defaultLabelValues.length > 0
  ) {
    fitted.defaultLabelValues.pop();
    remeasure();
  }

  if (isOverLimit()) {
    fitted.permalink = "";
    remeasure();
  }

  if (isOverLimit()) {
    fitted.messageText = String(fitted.messageText ?? "").slice(0, 100);
    remeasure();
  }

  if (isOverLimit()) {
    fitted.messageText = "";
    remeasure();
  }

  if (isOverLimit()) {
    fitted.title = String(fitted.title ?? "").slice(0, 100);
  }

  return fitted;
}

function buildCardSingleSelectBlock(cardField) {
  const cappedOptions = takeOptions(cardField.options);
  if (cappedOptions.length === 0) return null;

  const defaultOption = cappedOptions.find((option) => option.id === cardField.defaultOptionId);
  const placeholderText = defaultOption ? cardField.label : `${cardField.label} (optional)`;

  return {
    type: "section",
    block_id: cardFieldBlockId(cardField.key),
    text: { type: "mrkdwn", text: `*${cardField.label}*` },
    accessory: {
      type: "static_select",
      action_id: cardFieldActionId(cardField.key),
      placeholder: { type: "plain_text", text: placeholderText },
      options: cappedOptions.map((option) => toSlackOption(option.name, option.id)),
      ...(defaultOption ? { initial_option: toSlackOption(defaultOption.name, defaultOption.id) } : {}),
    },
  };
}

export function buildIssueCard({
  repo,
  title,
  labels = [],
  milestones = [],
  cardFields = [],
  defaultLabelValues = [],
  defaultMilestoneValue = null,
  cardMeta,
}) {
  const cappedLabels = takeOptions(labels);
  const cappedMilestones = takeOptions(milestones, MAX_SELECT_OPTIONS - 1);
  const fittedCardMeta = fitCardMeta(cardMeta);

  const blocks = [
    {
      type: "section",
      block_id: "card_intro",
      text: { type: "mrkdwn", text: `*New issue in ${repo}*` },
    },
    {
      type: "input",
      block_id: CARD_TITLE_BLOCK_ID,
      optional: true,
      label: { type: "plain_text", text: "Issue title" },
      element: {
        type: "plain_text_input",
        action_id: CARD_TITLE_ACTION_ID,
        initial_value: title || "",
        placeholder: { type: "plain_text", text: "Brief summary" },
      },
    },
  ];

  for (const cardField of cardFields) {
    const cardFieldBlock = buildCardSingleSelectBlock(cardField);
    if (cardFieldBlock) blocks.push(cardFieldBlock);
  }

  if (cappedLabels.length > 0) {
    const preSelectedLabels = cappedLabels.filter((label) => defaultLabelValues.includes(label.value));

    blocks.push({
      type: "section",
      block_id: CARD_LABELS_BLOCK_ID,
      text: { type: "mrkdwn", text: "*Labels*" },
      accessory: {
        type: "multi_static_select",
        action_id: CARD_LABELS_ACTION_ID,
        placeholder: { type: "plain_text", text: "Labels" },
        options: cappedLabels.map((label) => toSlackOption(label.text, label.value)),
        ...(preSelectedLabels.length > 0
          ? { initial_options: preSelectedLabels.map((label) => toSlackOption(label.text, label.value)) }
          : {}),
      },
    });
  }

  if (cappedMilestones.length > 0) {
    const preSelectedMilestone = cappedMilestones.find((milestone) => milestone.value === defaultMilestoneValue);

    blocks.push({
      type: "section",
      block_id: CARD_MILESTONE_BLOCK_ID,
      text: { type: "mrkdwn", text: "*Milestone*" },
      accessory: {
        type: "static_select",
        action_id: CARD_MILESTONE_ACTION_ID,
        placeholder: { type: "plain_text", text: "Milestone (optional)" },
        options: [
          toSlackOption("No milestone", CARD_MILESTONE_NONE_VALUE),
          ...cappedMilestones.map((milestone) => toSlackOption(milestone.text, milestone.value)),
        ],
        ...(preSelectedMilestone
          ? { initial_option: toSlackOption(preSelectedMilestone.text, preSelectedMilestone.value) }
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
          value: JSON.stringify(fittedCardMeta),
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Customize" },
          action_id: "issue_card_customize",
          value: JSON.stringify(fittedCardMeta),
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Cancel" },
          action_id: "issue_card_cancel",
          style: "danger",
          value: JSON.stringify({ threadTs: fittedCardMeta.threadTs }),
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
//   - cardFields stores only the minimal data needed to apply selections:
//     { key, fieldId, isNativeType, defaultOptionId }. blockId / actionId are
//     derivable from key via cardFieldBlockId() / cardFieldActionId().
export function buildCardMeta({
  repo,
  title,
  messageText = "",
  channelId,
  threadTs,
  userId,
  permalink = "",
  projectId = null,
  cardFields = [],
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
    cardFields: cardFields.map((cardField) => ({
      key: cardField.key,
      fieldId: cardField.fieldId,
      isNativeType: cardField.isNativeType === true,
      defaultOptionId: cardField.defaultOptionId ?? null,
    })),
    defaultLabelValues,
    defaultMilestoneValue,
  };
}
