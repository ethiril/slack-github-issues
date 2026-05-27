// Shared helpers for the Slack handlers. Pure utilities (parsing, validation,
// state extraction) and the cross-handler orchestration helpers (posting the
// issue card, appending a thread update, displaying an issue) live here so the
// per-flow handler modules stay focused on wiring Slack events to behaviour.

import { getUserDefaults } from "../defaults.js";
import { resolveDefaultProjectId } from "../modal.js";
import {
  fetchThreadMessages,
  compileThreadWithMeta,
  deriveTitle,
  deriveBotAlertTitle,
} from "../thread.js";
import {
  buildIssueCard,
  buildCardMeta,
  resolveCardFields,
  cardFieldBlockId,
  cardFieldActionId,
} from "../card.js";
import { registerThreadIssue } from "../thread-store.js";

// ── In-process deduplication ────────────────────────────────────────────────

// Prevents duplicate modal opens or issue creations from Lambda retries or
// rapid double-clicks. Keyed on action_ts (actions/shortcuts) or view.id (view
// submissions). Entries expire after 30 seconds.
const _seen = new Map();
const DEDUP_MS = 30_000;

export function isDuplicate(key) {
  const now = Date.now();
  for (const [k, t] of _seen) {
    if (now - t > DEDUP_MS) _seen.delete(k);
  }
  if (_seen.has(key)) return true;
  _seen.set(key, now);
  return false;
}

// ── Repo name validation & caret-command parsing ─────────────────────────────

// GitHub repo names: alphanumeric, hyphen, underscore, dot; cannot start with
// dot or hyphen; max 100 chars. Validated before making any API call with a
// user-supplied repo name (e.g., from emoji suffix routing).
const VALID_REPO_RE = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,98}[a-zA-Z0-9._]$|^[a-zA-Z0-9_]$/;
export function isValidRepoName(name) {
  return typeof name === "string" && VALID_REPO_RE.test(name);
}

// Parses the text of a caret command (a mention whose text ends in "^").
// Supported forms (the trailing "^" is stripped first):
//   "^"                      → {}                              (use saved defaults)
//   "<repo> ^"               → { repoOverride }
//   "<repo> <number> ^"      → { repoOverride, issueNumber }   (update that ticket)
//   "<number> ^"             → { issueNumber }                 (update # in default repo)
// A leading "#" on the number is tolerated. Invalid repo tokens are ignored.
export function parseCaretCommand(rawText) {
  const beforeCaret = (rawText ?? "").replace(/\^\s*$/, "").trim();
  const words = beforeCaret.split(/\s+/).filter(Boolean);
  if (words.length === 0) return { repoOverride: null, issueNumber: null };

  const last = words[words.length - 1];
  if (/^#?\d+$/.test(last)) {
    const issueNumber = parseInt(last.replace(/^#/, ""), 10);
    const repoCandidate = words[words.length - 2] ?? null;
    const repoOverride = (repoCandidate && isValidRepoName(repoCandidate)) ? repoCandidate : null;
    return { repoOverride, issueNumber };
  }

  return { repoOverride: isValidRepoName(last) ? last : null, issueNumber: null };
}

export function safeErrorMessage(err) {
  return err?.message ?? "An unexpected error occurred.";
}

// ── Ephemeral message helpers ─────────────────────────────────────────────────

// Posts an ephemeral message, omitting thread_ts when there is no thread (Slack
// treats an explicit null differently from an absent key).
export function postEphemeral(client, { channel, user, threadTs, text, blocks }) {
  return client.chat.postEphemeral({
    channel,
    user,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    text,
    ...(blocks ? { blocks } : {}),
  });
}

// The "repo not found" message is identical across the mention and reaction
// flows; centralise it so the owner reference and wording stay in sync.
export function postRepoNotFound(client, { channel, user, threadTs, repo }) {
  return postEphemeral(client, {
    channel,
    user,
    threadTs,
    text: `Repo *${repo}* not found under ${process.env.GITHUB_OWNER}. Check the spelling and try again.`,
  });
}

// ── Modal state extraction ────────────────────────────────────────────────────

export function collectModalProjectFieldValues(stateValues = {}) {
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
export function collectCardProjectFieldValues(projectFields = [], stateValues = {}, cardMeta = {}) {
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

// ── Repo metadata fetch ───────────────────────────────────────────────────────

// Fetches the metadata needed to (re)build the create-issue modal or the issue
// card for a repo in parallel. `projectId` (when given) also loads that
// project's custom fields; `includeTemplates: false` skips the template lookup
// for flows that don't render a template picker (e.g. the card customize modal).
export async function fetchRepoFormData(github, repo, { projectId = null, includeTemplates = true } = {}) {
  const [repoOptions, labels, milestones, assignees, projects, templates, projectFields] = await Promise.all([
    github.getRepos(),
    github.getLabels(repo),
    github.getMilestones(repo),
    github.getAssignees(repo),
    github.getProjects(),
    includeTemplates ? github.getIssueTemplates(repo) : Promise.resolve([]),
    projectId ? github.getProjectFields(projectId).catch(() => []) : Promise.resolve([]),
  ]);
  return { repoOptions, labels, milestones, assignees, projects, templates, projectFields };
}

// Parse REPO_DEFAULT_LABELS env var: JSON map of repo → label names array.
// Returns the label names for the given repo, or [] if not configured.
export function getRepoDefaultLabels(repo) {
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

// ── Cross-handler orchestration ───────────────────────────────────────────────

export async function appendThreadUpdateToIssue(client, github, { channelId, threadTs, userId, existingIssue }) {
  const { repo: issueRepo, issueNumber, lastSyncedTs, parentIncluded } = existingIssue;
  const allMessages = await fetchThreadMessages(client, channelId, threadTs);
  const includeParent = !parentIncluded;
  const newContent = await compileThreadWithMeta(client, allMessages, {
    sinceTs: lastSyncedTs,
    includeParent,
    channel: channelId,
  });

  if (!newContent) {
    await postEphemeral(client, {
      channel: channelId,
      user: userId,
      threadTs,
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
    // Idempotent upsert: advances lastSyncedTs and (once the root is folded in)
    // marks parentIncluded. Also records the mapping for threads not previously
    // tracked — e.g. an explicitly-numbered `<repo> <number> ^` update — so
    // later bare `^` tags append to this same ticket.
    await registerThreadIssue(threadTs, issueRepo, issueNumber, latestTs, parentIncluded || includeParent);
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      unfurl_links: false,
      text: `Thread update added to <${comment.html_url}|${issueRepo}#${issueNumber}>`,
    });
  } catch (err) {
    console.error("[handlers] tag update failed:", err);
    await postEphemeral(client, {
      channel: channelId,
      user: userId,
      threadTs,
      text: `Failed to update issue: ${safeErrorMessage(err)}`,
    });
  }
}

// Fetches repo metadata and posts an inline issue-creation card as an ephemeral
// message. Used by emoji reactions and the Quick Create button from @mentions.
export async function postIssueCard({ client, github, channelId, threadTs, userId, messageText, permalink, repo, parentIncluded = false, seedTs = null, seedMessage = null }) {
  const userDefaults = getUserDefaults(userId);

  const [labels, milestones, assignees, allProjects] = await Promise.all([
    github.getLabels(repo),
    github.getMilestones(repo),
    github.getAssignees(repo),
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

  // Bot alerts (Sentry/PagerDuty/…) get a structured title like "[Dev][Sentry]
  // SplitClient is null". When that path succeeds we keep the full extracted
  // text as the body since the title no longer came from line 1.
  const botAlertTitle = seedMessage ? deriveBotAlertTitle(seedMessage) : null;
  const title = botAlertTitle ?? deriveTitle(messageText);
  const bodyLinesAfterTitle = botAlertTitle
    ? messageText.trim()
    : messageText.split("\n").slice(1).join("\n").trim();

  // Repo-level label defaults take priority over per-user saved defaults.
  // Label names from the env are matched against the fetched label list to get their values.
  const repoLabelNames = getRepoDefaultLabels(repo);
  const defaultLabelValues = repoLabelNames.length > 0
    ? labels.filter((label) => repoLabelNames.includes(label.text)).map((label) => label.value)
    : (userDefaults.labelValues ?? []);

  const defaultAssigneeLogins = (userDefaults.assigneeLogins ?? []).filter((login) =>
    assignees.some((assignee) => assignee.value === login)
  );

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
    defaultAssigneeLogins,
    parentIncluded,
    seedTs,
  });

  const blocks = buildIssueCard({
    repo,
    title,
    labels,
    milestones,
    assignees,
    cardFields,
    defaultLabelValues,
    defaultMilestoneValue: userDefaults.milestoneValue ?? null,
    defaultAssigneeLogins,
    cardMeta,
  });

  await client.chat.postMessage({
    channel: channelId,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    text: `New issue: ${title}`,
    blocks,
  });
}

export async function showIssue(client, channelId, userId, repo, issueNumber, github) {
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
