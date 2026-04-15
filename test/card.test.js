import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildIssueCard, buildCardMeta } from "../src/card.js";

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
    const actionsBlock = blocks.find((b) => b.block_id === "card_actions");
    assert.ok(actionsBlock);
    const ids = actionsBlock.elements.map((e) => e.action_id);
    assert.ok(ids.includes("issue_card_create"));
    assert.ok(ids.includes("issue_card_customize"));
    assert.ok(ids.includes("issue_card_cancel"));
  });

  test("Create Issue button has primary style", () => {
    const blocks = buildIssueCard(minimalArgs);
    const actionsBlock = blocks.find((b) => b.block_id === "card_actions");
    const createBtn = actionsBlock.elements.find((e) => e.action_id === "issue_card_create");
    assert.equal(createBtn.style, "primary");
  });

  test("Cancel button has danger style", () => {
    const blocks = buildIssueCard(minimalArgs);
    const actionsBlock = blocks.find((b) => b.block_id === "card_actions");
    const cancelBtn = actionsBlock.elements.find((e) => e.action_id === "issue_card_cancel");
    assert.equal(cancelBtn.style, "danger");
  });

  test("cardMeta is JSON-stringified in Create Issue button value", () => {
    const cardMeta = { repo: "my-repo", title: "Something broke", projectId: "p1" };
    const blocks = buildIssueCard({ ...minimalArgs, cardMeta });
    const actionsBlock = blocks.find((b) => b.block_id === "card_actions");
    const createBtn = actionsBlock.elements.find((e) => e.action_id === "issue_card_create");
    assert.deepEqual(JSON.parse(createBtn.value), cardMeta);
  });

  test("omits priority, status, labels, and milestone blocks when none provided", () => {
    const blocks = buildIssueCard(minimalArgs);
    assert.ok(!blocks.some((b) => b.block_id === "card_priority"));
    assert.ok(!blocks.some((b) => b.block_id === "card_status"));
    assert.ok(!blocks.some((b) => b.block_id === "card_labels"));
    assert.ok(!blocks.some((b) => b.block_id === "card_milestone"));
  });

  test("includes priority dropdown in card_priority block when priorityField provided", () => {
    const priorityField = {
      id: "f1",
      options: [{ id: "o1", name: "High" }, { id: "o2", name: "Low" }],
    };
    const blocks = buildIssueCard({ ...minimalArgs, priorityField });
    const priorityBlock = blocks.find((b) => b.block_id === "card_priority");
    assert.ok(priorityBlock);
    assert.equal(priorityBlock.accessory.action_id, "card_priority_select");
  });

  test("defaults priority dropdown to High option (value is option ID)", () => {
    const priorityField = {
      id: "f1",
      options: [{ id: "o1", name: "Low" }, { id: "o2", name: "High" }, { id: "o3", name: "Medium" }],
    };
    const blocks = buildIssueCard({ ...minimalArgs, priorityField });
    const priorityEl = blocks.find((b) => b.block_id === "card_priority").accessory;
    assert.equal(priorityEl.initial_option.value, "o2");
    assert.equal(priorityEl.initial_option.text.text, "High");
  });

  test("includes status dropdown in card_status block when statusField provided", () => {
    const statusField = {
      id: "f2",
      options: [{ id: "o1", name: "Backlog" }, { id: "o2", name: "In Progress" }],
    };
    const blocks = buildIssueCard({ ...minimalArgs, statusField });
    const statusBlock = blocks.find((b) => b.block_id === "card_status");
    assert.ok(statusBlock);
    assert.equal(statusBlock.accessory.action_id, "card_status_select");
  });

  test("defaults status dropdown to Backlog option (value is option ID)", () => {
    const statusField = {
      id: "f2",
      options: [{ id: "o1", name: "In Progress" }, { id: "o2", name: "Backlog" }],
    };
    const blocks = buildIssueCard({ ...minimalArgs, statusField });
    const statusEl = blocks.find((b) => b.block_id === "card_status").accessory;
    assert.equal(statusEl.initial_option.value, "o2");
    assert.equal(statusEl.initial_option.text.text, "Backlog");
  });

  test("includes labels multi-select in card_labels block when labels provided", () => {
    const labels = [{ text: "bug", value: "bug" }, { text: "feature", value: "feature" }];
    const blocks = buildIssueCard({ ...minimalArgs, labels });
    const labelsBlock = blocks.find((b) => b.block_id === "card_labels");
    assert.ok(labelsBlock);
    assert.equal(labelsBlock.accessory.action_id, "card_labels_select");
  });

  test("pre-selects default labels", () => {
    const labels = [{ text: "bug", value: "bug" }, { text: "feature", value: "feature" }];
    const blocks = buildIssueCard({ ...minimalArgs, labels, defaultLabelValues: ["bug"] });
    const labelsEl = blocks.find((b) => b.block_id === "card_labels").accessory;
    assert.equal(labelsEl.initial_options.length, 1);
    assert.equal(labelsEl.initial_options[0].value, "bug");
  });

  test("includes milestone dropdown in card_milestone block when milestones provided", () => {
    const milestones = [{ text: "v1.0", value: "1" }];
    const blocks = buildIssueCard({ ...minimalArgs, milestones });
    assert.ok(blocks.some((b) => b.block_id === "card_milestone"));
  });

  test("milestone dropdown includes No milestone option", () => {
    const milestones = [{ text: "v1.0", value: "1" }];
    const blocks = buildIssueCard({ ...minimalArgs, milestones });
    const milestoneEl = blocks.find((b) => b.block_id === "card_milestone").accessory;
    assert.ok(milestoneEl.options.some((o) => o.value === "__none__"));
  });

  test("omits card_milestone block when milestones is empty", () => {
    const blocks = buildIssueCard({ ...minimalArgs, milestones: [] });
    assert.ok(!blocks.some((b) => b.block_id === "card_milestone"));
  });

  test("caps labels options at 100", () => {
    const labels = Array.from({ length: 101 }, (_, i) => ({
      text: `label-${i}`,
      value: `label-${i}`,
    }));
    const blocks = buildIssueCard({ ...minimalArgs, labels });
    const labelsEl = blocks.find((b) => b.block_id === "card_labels").accessory;
    assert.equal(labelsEl.options.length, 100);
  });

  test("caps priority options at 100", () => {
    const priorityField = {
      id: "f1",
      options: Array.from({ length: 120 }, (_, i) => ({
        id: `o${i}`,
        name: i === 50 ? "High" : `P${i}`,
      })),
    };
    const blocks = buildIssueCard({ ...minimalArgs, priorityField });
    const priorityEl = blocks.find((b) => b.block_id === "card_priority").accessory;
    assert.equal(priorityEl.options.length, 100);
  });

  test("caps status options at 100", () => {
    const statusField = {
      id: "f2",
      options: Array.from({ length: 130 }, (_, i) => ({
        id: `o${i}`,
        name: i === 25 ? "Backlog" : `State ${i}`,
      })),
    };
    const blocks = buildIssueCard({ ...minimalArgs, statusField });
    const statusEl = blocks.find((b) => b.block_id === "card_status").accessory;
    assert.equal(statusEl.options.length, 100);
  });

  test('caps milestone options so total remains 100 including "No milestone"', () => {
    const milestones = Array.from({ length: 120 }, (_, i) => ({
      text: `v${i}`,
      value: `${i}`,
    }));
    const blocks = buildIssueCard({ ...minimalArgs, milestones });
    const milestoneEl = blocks.find((b) => b.block_id === "card_milestone").accessory;
    assert.equal(milestoneEl.options.length, 100);
    assert.equal(milestoneEl.options[0].value, "__none__");
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
      defaultLabelValues: Array.from({ length: 300 }, (_, i) => `label-${i}`),
    });

    const blocks = buildIssueCard({ ...minimalArgs, cardMeta });
    const actionsBlock = blocks.find((b) => b.block_id === "card_actions");

    const createBtn = actionsBlock.elements.find((e) => e.action_id === "issue_card_create");
    const customizeBtn = actionsBlock.elements.find((e) => e.action_id === "issue_card_customize");

    assert.ok(createBtn.value.length <= 2000);
    assert.ok(customizeBtn.value.length <= 2000);
  });
});

// ── buildCardMeta ─────────────────────────────────────────────────────────────

describe("buildCardMeta", () => {
  const base = {
    repo: "my-repo",
    title: "Test issue",
    channelId: "C123",
    threadTs: "1234.5678",
    userId: "U999",
  };

  test("truncates title to 150 chars", () => {
    const meta = buildCardMeta({ ...base, title: "a".repeat(200) });
    assert.equal(meta.title.length, 150);
  });

  test("truncates messageText to 200 chars", () => {
    const meta = buildCardMeta({ ...base, messageText: "b".repeat(300) });
    assert.equal(meta.messageText.length, 200);
  });

  test("defaultPriorityOptionId is the ID of the High option", () => {
    const priorityField = {
      id: "pf1",
      options: [{ id: "o1", name: "Low" }, { id: "o2", name: "High" }],
    };
    const meta = buildCardMeta({ ...base, priorityField });
    assert.equal(meta.defaultPriorityOptionId, "o2");
  });

  test("defaultPriorityOptionId falls back to first option ID when no High", () => {
    const priorityField = {
      id: "pf1",
      options: [{ id: "o1", name: "Critical" }, { id: "o2", name: "Low" }],
    };
    const meta = buildCardMeta({ ...base, priorityField });
    assert.equal(meta.defaultPriorityOptionId, "o1");
  });

  test("defaultStatusOptionId is the ID of the Backlog option", () => {
    const statusField = {
      id: "sf1",
      options: [{ id: "o1", name: "In Progress" }, { id: "o2", name: "Backlog" }],
    };
    const meta = buildCardMeta({ ...base, statusField });
    assert.equal(meta.defaultStatusOptionId, "o2");
  });

  test("priorityFieldId and defaultPriorityOptionId are null when no priorityField", () => {
    const meta = buildCardMeta(base);
    assert.equal(meta.priorityFieldId, null);
    assert.equal(meta.defaultPriorityOptionId, null);
    assert.ok(!("priorityOptions" in meta), "priorityOptions should not exist in cardMeta");
  });

  test("statusFieldId and defaultStatusOptionId are null when no statusField", () => {
    const meta = buildCardMeta(base);
    assert.equal(meta.statusFieldId, null);
    assert.equal(meta.defaultStatusOptionId, null);
    assert.ok(!("statusOptions" in meta), "statusOptions should not exist in cardMeta");
  });

  test("passes through repo, channelId, threadTs, userId", () => {
    const meta = buildCardMeta(base);
    assert.equal(meta.repo, "my-repo");
    assert.equal(meta.channelId, "C123");
    assert.equal(meta.threadTs, "1234.5678");
    assert.equal(meta.userId, "U999");
  });

  test("defaultLabelValues and defaultMilestoneValue are included", () => {
    const meta = buildCardMeta({
      ...base,
      defaultLabelValues: ["bug"],
      defaultMilestoneValue: "3",
    });
    assert.deepEqual(meta.defaultLabelValues, ["bug"]);
    assert.equal(meta.defaultMilestoneValue, "3");
  });
});