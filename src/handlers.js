import { getUserDefaults, setUserDefaults } from "./defaults.js";
import {
  buildModal,
  buildAddToIssueModal,
  buildProjectFieldMap,
  resolveDefaultProjectId,
  toSlackOption,
} from "./modal.js";
import { fetchThreadMessages, compileThreadWithMeta, deriveTitle } from "./thread.js";
import { buildIssueCard, buildCardMeta } from "./card.js";
import { registerThreadIssue, getThreadIssue, updateThreadIssueSyncTs } from "./thread-store.js";

// GitHub repo names: alphanumeric, hyphen, underscore, dot; cannot start with
// dot or hyphen; max 100 chars. Validated before making any API call with a
// user-supplied repo name (e.g., from emoji suffix routing).
const VALID_REPO_RE = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,98}[a-zA-Z0-9._]$|^[a-zA-Z0-9_]$/;
function isValidRepoName(name) {
  return typeof name === "string" && VALID_REPO_RE.test(name);
}

// Return only the message from an error — never expose stack traces or tokens.
function safeErrMsg(err) {
  return err?.message ?? "An unexpected error occurred.";
}

function summarizeBlocks(blocks) {
  return blocks.map((block, i) => ({
    i,
    type: block.type,
    block_id: block.block_id ?? null,
    text_len: typeof block.text?.text === "string" ? block.text.text.length : 0,
    elements: Array.isArray(block.elements)
      ? block.elements.map((el) => ({
          type: el.type,
          action_id: el.action_id ?? null,
          options: Array.isArray(el.options) ? el.options.length : 0,
          initial_options: Array.isArray(el.initial_options) ? el.initial_options.length : 0,
          value_len: typeof el.value === "string" ? el.value.length : 0,
          text_len: typeof el.text?.text === "string" ? el.text.text.length : 0,
          placeholder_len:
            typeof el.placeholder?.text === "string" ? el.placeholder.text.length : 0,
        }))
      : undefined,
  }));
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

function collectCardProjectFieldValues(projectFields = [], stateValues = {}, cardMeta = {}) {
  const out = {};

  projectFields.forEach((field, index) => {
    const blockId = `pf_${index}`;
    const name = field.name.toLowerCase();

    if (field.dataType === "SINGLE_SELECT") {
      if (name === "priority") {
        out[blockId] =
          stateValues.card_priority?.card_priority_select?.selected_option?.value ??
          stateValues.card_selections?.card_priority_select?.selected_option?.value ??
          cardMeta.defaultPriorityOptionId ??
          null;
      } else if (name === "status") {
        out[blockId] =
          stateValues.card_status?.card_status_select?.selected_option?.value ??
          stateValues.card_selections?.card_status_select?.selected_option?.value ??
          cardMeta.defaultStatusOptionId ??
          null;
      } else if (name === "type") {
        out[blockId] =
          stateValues.card_type?.card_type_select?.selected_option?.value ??
          stateValues.card_selections?.card_type_select?.selected_option?.value ??
          cardMeta.defaultTypeOptionId ??
          null;
      }
    }
  });

  return Object.fromEntries(Object.entries(out).filter(([, v]) => v != null));
}

// ── Issue card helper ─────────────────────────────────────────────────────────
// Fetches repo metadata and posts an inline issue-creation card as an ephemeral
// message. Used by emoji reactions and the Quick Create button from @mentions.

async function postIssueCard({ client, github, channelId, threadTs, userId, messageText, permalink, repo }) {
  const defaults = getUserDefaults(userId);

  const [labels, milestones, allProjects] = await Promise.all([
    github.getLabels(repo),
    github.getMilestones(repo),
    github.getProjects(),
  ]);

  const projectId = resolveDefaultProjectId(allProjects, defaults.projectId, process.env.DEFAULT_GITHUB_PROJECT);
  const projectFields = projectId
    ? await github.getProjectFields(projectId).catch(() => [])
    : [];

  const priorityField = projectFields.find((f) => /priority/i.test(f.name)) ?? null;
  const statusField = projectFields.find((f) => /status/i.test(f.name)) ?? null;
  const typeField = projectFields.find((f) => /^type$/i.test(f.name)) ?? null;
  const title = deriveTitle(messageText);

  const cardMeta = buildCardMeta({
    repo,
    title,
    messageText,
    channelId,
    threadTs,
    userId,
    permalink,
    projectId,
    priorityField,
    statusField,
    typeField,
    defaultLabelValues: defaults.labelValues ?? [],
    defaultMilestoneValue: defaults.milestoneValue ?? null,
  });

  const blocks = buildIssueCard({
    repo,
    title,
    labels,
    milestones,
    priorityField,
    statusField,
    typeField,
    defaultLabelValues: defaults.labelValues ?? [],
    defaultMilestoneValue: defaults.milestoneValue ?? null,
    cardMeta,
  });

  const blockSummary = summarizeBlocks(blocks);

  console.log("[issue-card] repo:", repo);
  console.log("[issue-card] counts:", {
    labels: labels.length,
    milestones: milestones.length,
    projectFields: projectFields.length,
    typeOptions: typeField?.options?.length ?? 0,
    priorityOptions: priorityField?.options?.length ?? 0,
    statusOptions: statusField?.options?.length ?? 0,
  });

  console.log("[issue-card] cardMeta lengths:", {
    json: JSON.stringify(cardMeta).length,
    title: String(cardMeta.title ?? "").length,
    messageText: String(cardMeta.messageText ?? "").length,
    permalink: String(cardMeta.permalink ?? "").length,
    defaultLabelValues: Array.isArray(cardMeta.defaultLabelValues)
      ? cardMeta.defaultLabelValues.length
      : 0,
  });

  console.log("[issue-card] block summary:", JSON.stringify(blockSummary, null, 2));
  console.log("[issue-card] full blocks:", JSON.stringify(blocks, null, 2));

  try {
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      text: `New issue: ${title}`,
      blocks,
    });
  } catch (err) {
    console.error("[issue-card] Slack rejected blocks:", err?.data ?? err);
    console.error("[issue-card] rejected block summary:", JSON.stringify(blockSummary, null, 2));
    console.error("[issue-card] rejected full blocks:", JSON.stringify(blocks, null, 2));
    throw err;
  }
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

    await client.views.open({
      trigger_id: shortcut.trigger_id,
      view: buildModal({ messageText, metadata: slackMessageContext }),
    });
  });

  // 2. /issue slash command
  //    /issue           → open form
  //    /issue 123       → look up issue #123 in last-used repo
  //    /issue repo#123  → look up issue in a specific repo
  //    /issue search q  → search open issues
  //    /issue <text>    → open form with title pre-filled
  app.command("/issue", async ({ command, ack, client }) => {
    await ack();

    const text = (command.text ?? "").trim();
    const userId = command.user_id;

    const plainNumMatch = /^(\d+)$/.exec(text);
    if (plainNumMatch) {
      const defaults = getUserDefaults(userId);
      if (!defaults.repo) {
        await client.chat.postEphemeral({
          channel: command.channel_id,
          user: userId,
          text: "No default repo saved. Create an issue first, or use `/issue repo-name#123`.",
        });
        return;
      }
      await showIssue(client, command.channel_id, userId, defaults.repo, parseInt(plainNumMatch[1], 10), github);
      return;
    }

    const repoNumMatch = /^([^#\s]+)#(\d+)$/.exec(text);
    if (repoNumMatch) {
      await showIssue(client, command.channel_id, userId, repoNumMatch[1], parseInt(repoNumMatch[2], 10), github);
      return;
    }

    if (text.toLowerCase().startsWith("search ")) {
      const query = text.slice(7).trim();
      if (!query) {
        await client.chat.postEphemeral({
          channel: command.channel_id,
          user: userId,
          text: "Usage: `/issue search <query>`",
        });
        return;
      }
      const items = await github.searchIssues(query).catch(() => []);
      if (items.length === 0) {
        await client.chat.postEphemeral({
          channel: command.channel_id,
          user: userId,
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
        channel: command.channel_id,
        user: userId,
        text: `Search results for "${query}"`,
        blocks: [{
          type: "section",
          text: { type: "mrkdwn", text: `*Search results for "${query}":*\n\n${lines}` },
        }],
      });
      return;
    }

    // Default: open form (text becomes pre-filled title)
    await client.views.open({
      trigger_id: command.trigger_id,
      view: buildModal({
        currentTitle: text,
        metadata: {
          channelId: command.channel_id,
          threadTs: null,
          messageTs: null,
          userId,
          permalink: "",
          projectFieldMap: {},
        },
      }),
    });
  });

  // 3. @mention in a thread → ephemeral message with Create Issue + Quick Create buttons
  // Workaround: Slack does not provide a trigger_id on message events,
  // so a modal cannot be opened directly. The button click provides one.
  // Usage: @GitHub Butler [optional title]
  app.event("app_mention", async ({ event, client }) => {
    const issueTitle = event.text.replace(/<@[^>]+>/g, "").trim();
    const threadTs = event.thread_ts ?? event.ts;

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

    const { issueTitle, ...slackMessageContext } = JSON.parse(action.value);

    await client.views.open({
      trigger_id: body.trigger_id,
      view: buildModal({ currentTitle: issueTitle ?? "", metadata: slackMessageContext }),
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
        text: `Failed to create issue card: ${safeErrMsg(err)}`,
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

    let repo = null;
    if (reaction === "github_butler") {
      const defaults = getUserDefaults(event.user);
      repo = defaults.repo ?? null;
    } else if (reaction.endsWith(BUTLER_SUFFIX)) {
      const candidate = reaction.slice(0, -BUTLER_SUFFIX.length);
      if (!isValidRepoName(candidate)) return;
      repo = candidate;
    } else {
      return;
    }

    if (event.item.type !== "message") return;

    const channelId = event.item.channel;
    const messageTs = event.item.ts;

    const historyResult = await client.conversations.history({
      channel: channelId,
      latest: messageTs,
      inclusive: true,
      limit: 1,
    }).catch(() => null);

    const message = historyResult?.messages?.[0];
    if (!message) return;

    const threadTs = message.thread_ts ?? message.ts;
    const userId = event.user;

    // Check for an existing thread → issue mapping (tag update flow)
    const existingIssue = getThreadIssue(threadTs);
    if (existingIssue) {
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
        updateThreadIssueSyncTs(threadTs, latestTs);
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          unfurl_links: false,
          text: `Thread update added to <${comment.html_url}|${issueRepo}#${issueNumber}>`,
        });
      } catch (err) {
        console.error("Tag update failed:", err);
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          thread_ts: threadTs,
          text: `Failed to update issue: ${safeErrMsg(err)}`,
        });
      }
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
      messageText: message.text ?? "",
      permalink: permalinkResult?.permalink ?? "",
      repo,
    }).catch(async (err) => {
      console.error("Failed to post issue card:", err);
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        thread_ts: threadTs,
        text: `Failed to create issue card: ${safeErrMsg(err)}`,
      });
    });
  });

  // 7. External data source for the repo selector (used by both modals)
  app.options("repo_select", async ({ ack }) => {
    try {
      const repos = await github.getRepos();
      await ack({ options: repos.map((repoName) => toSlackOption(repoName, repoName)) });
    } catch (err) {
      await ack({ options: [toSlackOption(`Error: ${err.message}`, "__error__")] });
    }
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

    const [labels, milestones, projects, templates] = await Promise.all([
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

    const [labels, milestones, projects, templates, projectFields] = await Promise.all([
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

    const [labels, milestones, projects, templates, projectFields] = await Promise.all([
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

    await client.views.open({
      trigger_id: shortcut.trigger_id,
      view: buildAddToIssueModal({ messageText, metadata: slackMessageContext }),
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
        registerThreadIssue(slackMessageContext.threadTs, selectedRepo, createdIssue.number, latestTs);
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
        text: `Failed to create GitHub issue in *${selectedRepo}*: ${safeErrMsg(err)}`,
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
        text: `Failed to add comment to *${selectedRepo}#${issueNumber}*: ${safeErrMsg(err)}`,
      });
    }
  });

  // 14. Card "Create Issue" button → create issue from card state + cardMeta defaults
  app.action("issue_card_create", async ({ ack, action, body, client, respond }) => {
    await ack();

    const cardMeta = JSON.parse(action.value);
    const stateValues = body.state?.values ?? {};

    const typeOptionId =
      stateValues.card_type?.card_type_select?.selected_option?.value ??
      stateValues.card_selections?.card_type_select?.selected_option?.value ??
      cardMeta.defaultTypeOptionId;

    const priorityOptionId =
      stateValues.card_priority?.card_priority_select?.selected_option?.value ??
      stateValues.card_selections?.card_priority_select?.selected_option?.value ??
      cardMeta.defaultPriorityOptionId;

    const statusOptionId =
      stateValues.card_status?.card_status_select?.selected_option?.value ??
      stateValues.card_selections?.card_status_select?.selected_option?.value ??
      cardMeta.defaultStatusOptionId;

    const selectedLabelValues =
      stateValues.card_labels?.card_labels_select?.selected_options?.map((o) => o.value) ??
      stateValues.card_selections?.card_labels_select?.selected_options?.map((o) => o.value) ??
      cardMeta.defaultLabelValues ??
      [];

    const milestoneValue =
      stateValues.card_milestone?.card_milestone_select?.selected_option?.value ??
      cardMeta.defaultMilestoneValue ??
      null;

    // Compile thread for the issue body
    let issueBody = cardMeta.messageText || "";
    if (cardMeta.threadTs) {
      const threadMsgs = await fetchThreadMessages(client, cardMeta.channelId, cardMeta.threadTs);
      if (threadMsgs.length > 1) {
        const threadContent = await compileThreadWithMeta(client, threadMsgs);
        if (threadContent) issueBody = threadContent;
      }
    }
    if (cardMeta.permalink) {
      issueBody += `\n\n---\n_Created from Slack: ${cardMeta.permalink}_`;
    }

    try {
      const createdIssue = await github.createIssue({
        repo: cardMeta.repo,
        title: cardMeta.title,
        body: issueBody,
        labels: selectedLabelValues.length > 0 ? selectedLabelValues : undefined,
        milestone: milestoneValue && milestoneValue !== "" && milestoneValue !== "__none__" ? Number(milestoneValue) : undefined,
      });

      if (cardMeta.projectId) {
        const projectItemId = await github.addIssueToProject(cardMeta.projectId, createdIssue.node_id)
          .catch((err) => { console.error("Failed to add card issue to project:", err.message); return null; });

        if (projectItemId) {
          const fieldUpdates = [];

          if (cardMeta.typeFieldId && typeOptionId) {
            fieldUpdates.push(
              github.setProjectField(
                cardMeta.projectId,
                projectItemId,
                cardMeta.typeFieldId,
                { singleSelectOptionId: typeOptionId }
              ).catch((err) => console.error("Failed to set type:", err.message))
            );
          }

          if (cardMeta.priorityFieldId && priorityOptionId) {
            fieldUpdates.push(
              github.setProjectField(
                cardMeta.projectId,
                projectItemId,
                cardMeta.priorityFieldId,
                { singleSelectOptionId: priorityOptionId }
              ).catch((err) => console.error("Failed to set priority:", err.message))
            );
          }

          if (cardMeta.statusFieldId && statusOptionId) {
            fieldUpdates.push(
              github.setProjectField(
                cardMeta.projectId,
                projectItemId,
                cardMeta.statusFieldId,
                { singleSelectOptionId: statusOptionId }
              ).catch((err) => console.error("Failed to set status:", err.message))
            );
          }

          await Promise.all(fieldUpdates);
        }
      }

      // Register thread → issue mapping for future tag updates
      if (cardMeta.threadTs) {
        const allMsgs = await fetchThreadMessages(client, cardMeta.channelId, cardMeta.threadTs).catch(() => []);
        const latestTs = allMsgs.length > 0 ? allMsgs[allMsgs.length - 1].ts : cardMeta.threadTs;
        registerThreadIssue(cardMeta.threadTs, cardMeta.repo, createdIssue.number, latestTs);
      }

      await respond({ delete_original: true });
      await client.chat.postMessage({
        channel: cardMeta.channelId,
        ...(cardMeta.threadTs ? { thread_ts: cardMeta.threadTs } : {}),
        unfurl_links: false,
        text: `Issue created: <${createdIssue.html_url}|${cardMeta.repo}#${createdIssue.number} -- ${cardMeta.title}>`,
      });
    } catch (err) {
      console.error("Card issue creation failed:", err);
      await respond({
        replace_original: true,
        text: `Failed to create issue: ${safeErrMsg(err)}`,
      });
    }
  });

  // 15. Card "Customize" button → open the full form modal pre-filled from card state
  app.action("issue_card_customize", async ({ ack, action, body, client, respond }) => {
    await ack();

    const cardMeta = JSON.parse(action.value);
    const stateValues = body.state?.values ?? {};

    const currentLabelValues =
      stateValues.card_labels?.card_labels_select?.selected_options?.map((o) => o.value) ??
      stateValues.card_selections?.card_labels_select?.selected_options?.map((o) => o.value) ??
      cardMeta.defaultLabelValues ?? [];

    const currentMilestoneValue =
      stateValues.card_milestone?.card_milestone_select?.selected_option?.value ??
      cardMeta.defaultMilestoneValue ?? null;

    const [labels, milestones, projects, projectFields] = await Promise.all([
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

    await client.views.open({
      trigger_id: body.trigger_id,
      view: buildModal({
        selectedRepo: cardMeta.repo,
        metadata: slackMessageContext,
        currentTitle: cardMeta.title,
        currentBody: cardMeta.messageText,
        labels,
        milestones,
        projects,
        projectFields,
        initialProjectId: cardMeta.projectId,
        initialLabelValues: currentLabelValues,
        initialMilestoneValue: currentMilestoneValue,
        initialProjectFieldValues,
      }),
    });

    await respond({ delete_original: true });
  });

  // 16. Card "Cancel" button → dismiss the card
  app.action("issue_card_cancel", async ({ ack, respond }) => {
    await ack();
    await respond({ delete_original: true });
  });

  // 17. No-op handler for card dropdown interactions
  // The card uses actions blocks/section accessories, so Slack fires an
  // action event on every dropdown change. We ack immediately and let state
  // accumulate in body.state.values for when the Create button is pressed.
  app.action(/^card_/, async ({ ack }) => {
    await ack();
  });
}