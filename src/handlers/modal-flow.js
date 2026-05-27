// The full create-issue modal pipeline: opening the modal (from a message
// shortcut, the /butler command, or the @mention button), reacting to the
// repo/template/project dropdowns to reload its metadata, and handling the
// final submit that creates the GitHub issue.

import { getUserDefaults, setUserDefaults } from "../defaults.js";
import { buildModal, buildProjectFieldMap, resolveDefaultProjectId } from "../modal.js";
import { fetchThreadMessages, compileThreadWithMeta } from "../thread.js";
import { registerThreadIssue, claimEvent } from "../thread-store.js";
import {
  isDuplicate,
  safeErrorMessage,
  collectModalProjectFieldValues,
  fetchRepoFormData,
  postEphemeral,
  showIssue,
} from "./helpers.js";

export function registerModalFlow(app, github) {
  // Message shortcut → open the modal
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
      parentIncluded: messageTs === threadTs,
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

  // /butler slash command
  //    /butler           → open form
  //    /butler 123       → look up issue #123 in last-used repo
  //    /butler repo#123  → look up issue in a specific repo
  //    /butler <text>    → open form with title pre-filled
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
        await postEphemeral(client, {
          channel: channelId,
          user: userId,
          threadTs,
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
          parentIncluded: false,
        },
        repoOptions,
      }),
    });
  });

  // "Create Issue" button from @mention → open the modal
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

  // Repo selected → load labels/milestones/projects/templates and apply user defaults
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

    const { repoOptions, labels, milestones, assignees, projects, templates } =
      await fetchRepoFormData(github, selectedRepo);

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
    const initialAssigneeValues = (defaults.assigneeLogins ?? []).filter((login) =>
      assignees.some((assignee) => assignee.value === login)
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
        assignees,
        projects,
        templates,
        projectFields,
        initialProjectId,
        initialMilestoneValue,
        initialLabelValues,
        initialAssigneeValues,
        initialProjectFieldValues: currentProjectFieldValues,
        repoOptions,
      }),
    });
  });

  // Template selected → pre-fill title, body, and labels from the template
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

    const currentAssigneeValues = modalView.state.values.assignees_block?.assignees_select?.selected_options?.map((o) => o.value) ?? null;

    const { repoOptions, labels, milestones, assignees, projects, templates, projectFields } =
      await fetchRepoFormData(github, selectedRepo, { projectId: currentProjectId });

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

    const initialAssigneeValues = (currentAssigneeValues ?? defaults.assigneeLogins ?? [])
      .filter((login) => assignees.some((a) => a.value === login));

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
        assignees,
        projects,
        templates,
        projectFields,
        initialTemplateId: selectedTemplateName,
        initialProjectId: resolvedProjectId,
        initialMilestoneValue,
        initialLabelValues,
        initialAssigneeValues,
        initialProjectFieldValues: currentProjectFieldValues,
        repoOptions,
      }),
    });
  });

  // Project selected → load and display the project's custom fields
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
    const currentAssigneeValues = modalView.state.values.assignees_block?.assignees_select?.selected_options?.map((o) => o.value) ?? [];
    const currentProjectFieldValues = collectModalProjectFieldValues(modalView.state.values);

    const { repoOptions, labels, milestones, assignees, projects, templates, projectFields } =
      await fetchRepoFormData(github, selectedRepo, { projectId: selectedProjectId });

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
        assignees,
        projects,
        templates,
        projectFields,
        initialTemplateId: selectedTemplateName,
        initialProjectId: selectedProjectId,
        initialMilestoneValue: currentMilestoneValue,
        initialLabelValues: currentLabelValues,
        initialAssigneeValues: currentAssigneeValues,
        initialProjectFieldValues: currentProjectFieldValues,
        repoOptions,
      }),
    });
  });

  // Create issue modal submitted → create the GitHub issue and save user defaults
  app.view("create_issue_modal", async ({ ack, view, client }) => {
    const formValues = view.state.values;
    const slackMessageContext = JSON.parse(view.private_metadata);

    const selectedRepo = formValues.repo_block?.repo_select?.selected_option?.value ?? "";
    const issueTitle = formValues.title_block?.title_input?.value ?? "";
    const selectedLabels = formValues.labels_block?.labels_select?.selected_options?.map((opt) => opt.value) ?? [];
    const selectedAssignees = formValues.assignees_block?.assignees_select?.selected_options?.map((opt) => opt.value) ?? [];
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
      assigneeLogins: selectedAssignees,
    });

    await ack();
    // Cross-instance dedup: a retried modal submit must not create a 2nd issue.
    if (!(await claimEvent(`view:${view.id}`))) return;

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
        assignees: selectedAssignees,
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
        const parentIncluded =
          slackMessageContext.parentIncluded === true
          || includeThread
          || (slackMessageContext.messageTs != null && slackMessageContext.messageTs === slackMessageContext.threadTs);
        await registerThreadIssue(slackMessageContext.threadTs, selectedRepo, createdIssue.number, latestTs, parentIncluded);
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
}
