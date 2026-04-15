import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildIssueCard,
  buildCardMeta,
  resolveCardFields,
  cardFieldBlockId,
  cardFieldActionId,
} from "../src/card.js";

// A fully resolved cardField (as returned by resolveCardFields) for test input.
function makeCardField(overrides) {
  return {
    key: "priority",
    label: "Priority",
    fieldId: "pf_default",
    isNativeType: false,
    options: [],
    defaultOptionId: null,
    ...overrides,
  };
}

// ── resolveCardFields ─────────────────────────────────────────────────────────

describe("resolveCardFields", () => {
  test("returns empty array when no project fields and no native types", () => {
    assert.deepEqual(resolveCardFields([], []), []);
  });

  test("resolves priority field and picks High as default", () => {
    const projectFields = [
      {
        id: "pf_priority",
        name: "Priority",
        dataType: "SINGLE_SELECT",
        options: [{ id: "o1", name: "Low" }, { id: "o2", name: "High" }],
      },
    ];
    const [priority] = resolveCardFields(projectFields, []);
    assert.equal(priority.key, "priority");
    assert.equal(priority.fieldId, "pf_priority");
    assert.equal(priority.isNativeType, false);
    assert.equal(priority.defaultOptionId, "o2");
  });

  test("resolves status field and picks Backlog as default", () => {
    const projectFields = [
      {
        id: "pf_status",
        name: "Status",
        options: [{ id: "s1", name: "In Progress" }, { id: "s2", name: "Backlog" }],
      },
    ];
    const [status] = resolveCardFields(projectFields, []);
    assert.equal(status.key, "status");
    assert.equal(status.defaultOptionId, "s2");
  });

  test("resolves severity field with no default option selected", () => {
    const projectFields = [
      {
        id: "pf_severity",
        name: "Severity",
        options: [
          { id: "s0", name: "S0 - Incident" },
          { id: "s1", name: "S1 - Critical" },
          { id: "s2", name: "S2 - Major" },
          { id: "s3", name: "S3 - Minor" },
          { id: "s4", name: "S4 - Trivial" },
        ],
      },
    ];
    const [severity] = resolveCardFields(projectFields, []);
    assert.equal(severity.key, "severity");
    assert.equal(severity.label, "Severity");
    assert.equal(severity.fieldId, "pf_severity");
    assert.equal(severity.isNativeType, false);
    assert.equal(severity.defaultOptionId, null);
  });

  test("uses a project Type field when present", () => {
    const projectFields = [
      { id: "pf_type", name: "Type", options: [{ id: "t1", name: "Bug" }] },
    ];
    const nativeIssueTypes = [{ id: "native1", name: "Feature" }];
    const [type] = resolveCardFields(projectFields, nativeIssueTypes);
    assert.equal(type.key, "type");
    assert.equal(type.isNativeType, false);
    assert.equal(type.fieldId, "pf_type");
    assert.equal(type.defaultOptionId, "t1");
  });

  test("falls back to native issue types for Type when no project Type field", () => {
    const nativeIssueTypes = [{ id: "native1", name: "Bug" }, { id: "native2", name: "Feature" }];
    const [type] = resolveCardFields([], nativeIssueTypes);
    assert.equal(type.key, "type");
    assert.equal(type.isNativeType, true);
    assert.equal(type.fieldId, null);
    assert.equal(type.defaultOptionId, "native1");
  });

  test("skips fields whose options array is empty", () => {
    const projectFields = [{ id: "pf_priority", name: "Priority", options: [] }];
    assert.deepEqual(resolveCardFields(projectFields, []), []);
  });

  test("orders resolved fields as Type, Priority, Severity, Status", () => {
    const projectFields = [
      { id: "pf_status", name: "Status", options: [{ id: "s1", name: "Backlog" }] },
      { id: "pf_severity", name: "Severity", options: [{ id: "sv1", name: "S3 - Minor" }] },
      { id: "pf_priority", name: "Priority", options: [{ id: "p1", name: "High" }] },
      { id: "pf_type", name: "Type", options: [{ id: "t1", name: "Bug" }] },
    ];
    const resolved = resolveCardFields(projectFields, []);
    assert.deepEqual(resolved.map((cardField) => cardField.key), ["type", "priority", "severity", "status"]);
  });
});

// ── buildIssueCard ────────────────────────────────────────────────────────────

describe("buildIssueCard", () => {
  const minimalArgs = {
    repo: "my-repo",
    title: "Something broke",
    cardMeta: { repo: "my-repo", title: "Something broke" },
  };

  test("first block is a section containing the repo name", () => {
    const blocks = buildIssueCard(minimalArgs);
    assert.equal(blocks[0].type, "section");
    assert.ok(blocks[0].text.text.includes("my-repo"));
  });

  test("second block is an input block with plain_text_input pre-filled with the title", () => {
    const blocks = buildIssueCard(minimalArgs);
    assert.equal(blocks[1].type, "input");
    assert.equal(blocks[1].block_id, "card_title_block");
    assert.equal(blocks[1].element.type, "plain_text_input");
    assert.equal(blocks[1].element.action_id, "card_title_input");
    assert.equal(blocks[1].element.initial_value, "Something broke");
  });

  test("always ends with Create Issue, Customize, and Cancel buttons", () => {
    const blocks = buildIssueCard(minimalArgs);
    const actionsBlock = blocks.find((block) => block.block_id === "card_actions");
    assert.ok(actionsBlock);
    const actionIds = actionsBlock.elements.map((element) => element.action_id);
    assert.ok(actionIds.includes("issue_card_create"));
    assert.ok(actionIds.includes("issue_card_customize"));
    assert.ok(actionIds.includes("issue_card_cancel"));
  });

  test("Create Issue button has primary style", () => {
    const blocks = buildIssueCard(minimalArgs);
    const actionsBlock = blocks.find((block) => block.block_id === "card_actions");
    const createButton = actionsBlock.elements.find((element) => element.action_id === "issue_card_create");
    assert.equal(createButton.style, "primary");
  });

  test("Cancel button has danger style", () => {
    const blocks = buildIssueCard(minimalArgs);
    const actionsBlock = blocks.find((block) => block.block_id === "card_actions");
    const cancelButton = actionsBlock.elements.find((element) => element.action_id === "issue_card_cancel");
    assert.equal(cancelButton.style, "danger");
  });

  test("cardMeta is JSON-stringified in Create Issue button value", () => {
    const cardMeta = { repo: "my-repo", title: "Something broke", projectId: "p1" };
    const blocks = buildIssueCard({ ...minimalArgs, cardMeta });
    const actionsBlock = blocks.find((block) => block.block_id === "card_actions");
    const createButton = actionsBlock.elements.find((element) => element.action_id === "issue_card_create");
    assert.deepEqual(JSON.parse(createButton.value), cardMeta);
  });

  test("omits single-select, labels, and milestone blocks when none provided", () => {
    const blocks = buildIssueCard(minimalArgs);
    assert.ok(!blocks.some((block) => block.block_id === "card_priority"));
    assert.ok(!blocks.some((block) => block.block_id === "card_status"));
    assert.ok(!blocks.some((block) => block.block_id === "card_type"));
    assert.ok(!blocks.some((block) => block.block_id === "card_severity"));
    assert.ok(!blocks.some((block) => block.block_id === "card_labels"));
    assert.ok(!blocks.some((block) => block.block_id === "card_milestone"));
  });

  test("renders each cardField as a section block with a static_select accessory", () => {
    const cardFields = [
      makeCardField({
        key: "priority",
        label: "Priority",
        options: [{ id: "o1", name: "High" }, { id: "o2", name: "Low" }],
        defaultOptionId: "o1",
      }),
    ];
    const blocks = buildIssueCard({ ...minimalArgs, cardFields });
    const priorityBlock = blocks.find((block) => block.block_id === "card_priority");
    assert.ok(priorityBlock);
    assert.equal(priorityBlock.type, "section");
    assert.equal(priorityBlock.accessory.action_id, "card_priority_select");
    assert.equal(priorityBlock.accessory.initial_option.value, "o1");
  });

  test("includes a Severity block when a severity cardField is provided", () => {
    const cardFields = [
      makeCardField({
        key: "severity",
        label: "Severity",
        options: [{ id: "s3", name: "S3 - Minor" }, { id: "s4", name: "S4 - Trivial" }],
        defaultOptionId: "s3",
      }),
    ];
    const blocks = buildIssueCard({ ...minimalArgs, cardFields });
    const severityBlock = blocks.find((block) => block.block_id === "card_severity");
    assert.ok(severityBlock);
    assert.equal(severityBlock.text.text, "*Severity*");
    assert.equal(severityBlock.accessory.action_id, "card_severity_select");
    assert.equal(severityBlock.accessory.initial_option.value, "s3");
    assert.equal(severityBlock.accessory.initial_option.text.text, "S3 - Minor");
  });

  test("omits a cardField that has no options", () => {
    const cardFields = [makeCardField({ key: "priority", options: [] })];
    const blocks = buildIssueCard({ ...minimalArgs, cardFields });
    assert.ok(!blocks.some((block) => block.block_id === "card_priority"));
  });

  test("cardField block omits initial_option when defaultOptionId does not match any option", () => {
    const cardFields = [
      makeCardField({
        key: "priority",
        options: [{ id: "o1", name: "Low" }],
        defaultOptionId: "nonexistent",
      }),
    ];
    const blocks = buildIssueCard({ ...minimalArgs, cardFields });
    const priorityBlock = blocks.find((block) => block.block_id === "card_priority");
    assert.ok(!("initial_option" in priorityBlock.accessory));
  });

  test("caps cardField options at 100", () => {
    const manyOptions = Array.from({ length: 120 }, (_, index) => ({
      id: `o${index}`,
      name: `Option ${index}`,
    }));
    const cardFields = [makeCardField({ key: "priority", options: manyOptions, defaultOptionId: "o0" })];
    const blocks = buildIssueCard({ ...minimalArgs, cardFields });
    const priorityBlock = blocks.find((block) => block.block_id === "card_priority");
    assert.equal(priorityBlock.accessory.options.length, 100);
  });

  test("includes labels multi-select in card_labels block when labels provided", () => {
    const labels = [{ text: "bug", value: "bug" }, { text: "feature", value: "feature" }];
    const blocks = buildIssueCard({ ...minimalArgs, labels });
    const labelsBlock = blocks.find((block) => block.block_id === "card_labels");
    assert.ok(labelsBlock);
    assert.equal(labelsBlock.accessory.action_id, "card_labels_select");
  });

  test("pre-selects default labels", () => {
    const labels = [{ text: "bug", value: "bug" }, { text: "feature", value: "feature" }];
    const blocks = buildIssueCard({ ...minimalArgs, labels, defaultLabelValues: ["bug"] });
    const labelsBlock = blocks.find((block) => block.block_id === "card_labels").accessory;
    assert.equal(labelsBlock.initial_options.length, 1);
    assert.equal(labelsBlock.initial_options[0].value, "bug");
  });

  test("includes milestone dropdown in card_milestone block when milestones provided", () => {
    const milestones = [{ text: "v1.0", value: "1" }];
    const blocks = buildIssueCard({ ...minimalArgs, milestones });
    assert.ok(blocks.some((block) => block.block_id === "card_milestone"));
  });

  test("milestone dropdown includes No milestone option", () => {
    const milestones = [{ text: "v1.0", value: "1" }];
    const blocks = buildIssueCard({ ...minimalArgs, milestones });
    const milestoneAccessory = blocks.find((block) => block.block_id === "card_milestone").accessory;
    assert.ok(milestoneAccessory.options.some((option) => option.value === "__none__"));
  });

  test("omits card_milestone block when milestones is empty", () => {
    const blocks = buildIssueCard({ ...minimalArgs, milestones: [] });
    assert.ok(!blocks.some((block) => block.block_id === "card_milestone"));
  });

  test("caps labels options at 100", () => {
    const labels = Array.from({ length: 101 }, (_, index) => ({
      text: `label-${index}`,
      value: `label-${index}`,
    }));
    const blocks = buildIssueCard({ ...minimalArgs, labels });
    const labelsAccessory = blocks.find((block) => block.block_id === "card_labels").accessory;
    assert.equal(labelsAccessory.options.length, 100);
  });

  test('caps milestone options so total remains 100 including "No milestone"', () => {
    const milestones = Array.from({ length: 120 }, (_, index) => ({
      text: `v${index}`,
      value: `${index}`,
    }));
    const blocks = buildIssueCard({ ...minimalArgs, milestones });
    const milestoneAccessory = blocks.find((block) => block.block_id === "card_milestone").accessory;
    assert.equal(milestoneAccessory.options.length, 100);
    assert.equal(milestoneAccessory.options[0].value, "__none__");
  });

  test("button values stay within Slack's 2000-char limit", () => {
    const cardMeta = buildCardMeta({
      repo: "my-repo",
      title: "Something broke",
      messageText: "x".repeat(300),
      channelId: "C123",
      threadTs: "1234.5678",
      userId: "U999",
      permalink: "https://example.com/" + "a".repeat(1500),
      defaultLabelValues: Array.from({ length: 300 }, (_, index) => `label-${index}`),
    });

    const blocks = buildIssueCard({ ...minimalArgs, cardMeta });
    const actionsBlock = blocks.find((block) => block.block_id === "card_actions");

    const createButton = actionsBlock.elements.find((element) => element.action_id === "issue_card_create");
    const customizeButton = actionsBlock.elements.find((element) => element.action_id === "issue_card_customize");

    assert.ok(createButton.value.length <= 2000);
    assert.ok(customizeButton.value.length <= 2000);
  });
});

// ── buildCardMeta ─────────────────────────────────────────────────────────────

describe("buildCardMeta", () => {
  const baseArgs = {
    repo: "my-repo",
    title: "Test issue",
    channelId: "C123",
    threadTs: "1234.5678",
    userId: "U999",
  };

  test("truncates title to 150 chars", () => {
    const meta = buildCardMeta({ ...baseArgs, title: "a".repeat(200) });
    assert.equal(meta.title.length, 150);
  });

  test("truncates messageText to 200 chars", () => {
    const meta = buildCardMeta({ ...baseArgs, messageText: "b".repeat(300) });
    assert.equal(meta.messageText.length, 200);
  });

  test("stores a compact cardFields array with only the data needed to apply selections", () => {
    const cardFields = [
      makeCardField({
        key: "priority",
        fieldId: "pf_priority",
        defaultOptionId: "o_high",
        options: [{ id: "o_high", name: "High" }],
      }),
      makeCardField({
        key: "severity",
        fieldId: "pf_severity",
        defaultOptionId: "o_s3",
        options: [{ id: "o_s3", name: "S3 - Minor" }],
      }),
    ];
    const meta = buildCardMeta({ ...baseArgs, cardFields });
    assert.deepEqual(meta.cardFields, [
      { key: "priority", fieldId: "pf_priority", isNativeType: false, defaultOptionId: "o_high" },
      { key: "severity", fieldId: "pf_severity", isNativeType: false, defaultOptionId: "o_s3" },
    ]);
  });

  test("marks native issue type entries with isNativeType=true and fieldId=null", () => {
    const cardFields = [
      makeCardField({
        key: "type",
        fieldId: null,
        isNativeType: true,
        defaultOptionId: "native1",
        options: [{ id: "native1", name: "Bug" }],
      }),
    ];
    const meta = buildCardMeta({ ...baseArgs, cardFields });
    assert.deepEqual(meta.cardFields, [
      { key: "type", fieldId: null, isNativeType: true, defaultOptionId: "native1" },
    ]);
  });

  test("cardFields defaults to an empty array when omitted", () => {
    const meta = buildCardMeta(baseArgs);
    assert.deepEqual(meta.cardFields, []);
  });

  test("passes through repo, channelId, threadTs, userId", () => {
    const meta = buildCardMeta(baseArgs);
    assert.equal(meta.repo, "my-repo");
    assert.equal(meta.channelId, "C123");
    assert.equal(meta.threadTs, "1234.5678");
    assert.equal(meta.userId, "U999");
  });

  test("defaultLabelValues and defaultMilestoneValue are included", () => {
    const meta = buildCardMeta({
      ...baseArgs,
      defaultLabelValues: ["bug"],
      defaultMilestoneValue: "3",
    });
    assert.deepEqual(meta.defaultLabelValues, ["bug"]);
    assert.equal(meta.defaultMilestoneValue, "3");
  });
});

// ── cardFieldBlockId / cardFieldActionId ──────────────────────────────────────

describe("cardFieldBlockId and cardFieldActionId", () => {
  test("produce the stable inline IDs used by the card and action handlers", () => {
    assert.equal(cardFieldBlockId("severity"), "card_severity");
    assert.equal(cardFieldActionId("severity"), "card_severity_select");
  });
});
