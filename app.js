import bolt from "@slack/bolt";
import { Octokit } from "@octokit/rest";
import yaml from "js-yaml";

const { App, AwsLambdaReceiver } = bolt;

// ── Clients ───────────────────────────────────────────────────────────────────
// Mode is inferred from the environment:
//   SLACK_APP_TOKEN present → Socket Mode (local / server)
//   SLACK_APP_TOKEN absent  → HTTP mode via AwsLambdaReceiver (Lambda)

const isSocketMode = !!process.env.SLACK_APP_TOKEN;

let awsLambdaReceiver;
let app;

if (isSocketMode) {
  app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
  });
} else {
  awsLambdaReceiver = new AwsLambdaReceiver({
    signingSecret: process.env.SLACK_SIGNING_SECRET,
  });
  app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    receiver: awsLambdaReceiver,
  });
}

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const githubOwner = process.env.GITHUB_OWNER;

// ── Per-user defaults ─────────────────────────────────────────────────────────
// In-memory store of each user's last-used selections. Resets on restart.

const userDefaults = new Map();

function getUserDefaults(userId) {
  return userDefaults.get(userId) ?? { repo: null, projectId: null, milestoneValue: null, labelValues: [] };
}

// ── GitHub helpers ────────────────────────────────────────────────────────────

async function getRepos() {
  if (process.env.GITHUB_REPOS) {
    return process.env.GITHUB_REPOS.split(",").map((repoName) => repoName.trim());
  }
  const repos = await octokit.paginate(octokit.rest.repos.listForOrg, {
    org: githubOwner,
    type: "all",
    per_page: 100,
  }).catch(() =>
    octokit.paginate(octokit.rest.repos.listForUser, {
      username: githubOwner,
      per_page: 100,
    })
  );
  return repos.map((repo) => repo.name).sort();
}

async function getLabels(repoName) {
  const labels = await octokit.paginate(octokit.rest.issues.listLabelsForRepo, {
    owner: githubOwner,
    repo: repoName,
    per_page: 100,
  }).catch(() => []);
  return labels.map((label) => ({ text: label.name, value: label.name }));
}

async function getMilestones(repoName) {
  const milestones = await octokit.paginate(octokit.rest.issues.listMilestones, {
    owner: githubOwner,
    repo: repoName,
    state: "open",
    per_page: 100,
  }).catch(() => []);
  return milestones.map((milestone) => ({
    text: milestone.title,
    value: String(milestone.number),
  }));
}

async function getProjects() {
  const orgProjectsQuery = `query($owner: String!) {
    organization(login: $owner) {
      projectsV2(first: 50, orderBy: {field: TITLE, direction: ASC}) {
        nodes { id title }
      }
    }
  }`;
  const userProjectsQuery = `query($owner: String!) {
    user(login: $owner) {
      projectsV2(first: 50, orderBy: {field: TITLE, direction: ASC}) {
        nodes { id title }
      }
    }
  }`;
  try {
    const orgResponse = await octokit.graphql(orgProjectsQuery, { owner: githubOwner });
    return orgResponse.organization.projectsV2.nodes.map((project) => ({
      text: project.title,
      value: project.id,
    }));
  } catch {
    try {
      const userResponse = await octokit.graphql(userProjectsQuery, { owner: githubOwner });
      return userResponse.user.projectsV2.nodes.map((project) => ({
        text: project.title,
        value: project.id,
      }));
    } catch {
      return [];
    }
  }
}

async function getProjectFields(projectId) {
  const query = `query($projectId: ID!) {
    node(id: $projectId) {
      ... on ProjectV2 {
        fields(first: 50) {
          nodes {
            __typename
            ... on ProjectV2Field {
              id
              name
              dataType
            }
            ... on ProjectV2SingleSelectField {
              id
              name
              dataType
              options { id name }
            }
          }
        }
      }
    }
  }`;

  const skippedDataTypes = new Set([
    "TITLE", "ASSIGNEES", "LABELS", "MILESTONE",
    "LINKED_PULL_REQUESTS", "REVIEWERS", "REPOSITORY",
    "TRACKED_BY", "ITERATION",
  ]);

  try {
    const response = await octokit.graphql(query, { projectId });
    return (response.node?.fields?.nodes ?? []).filter(
      (field) => field?.id && field?.name && !skippedDataTypes.has(field.dataType)
    );
  } catch {
    return [];
  }
}

async function getIssueTemplates(repoName) {
  const dirResponse = await octokit.rest.repos.getContent({
    owner: githubOwner,
    repo: repoName,
    path: ".github/ISSUE_TEMPLATE",
  }).catch(() => null);

  if (!dirResponse || !Array.isArray(dirResponse.data)) return [];

  const templateFiles = dirResponse.data.filter(
    (file) => file.type === "file" && /\.(md|ya?ml)$/.test(file.name)
  );

  const templates = await Promise.all(
    templateFiles.map(async (file) => {
      const fileResponse = await octokit.rest.repos.getContent({
        owner: githubOwner,
        repo: repoName,
        path: file.path,
      }).catch(() => null);
      if (!fileResponse?.data?.content) return null;
      return parseIssueTemplate(fileResponse.data.content, file.name);
    })
  );

  return templates.filter(Boolean);
}

function parseIssueTemplate(base64Content, filename) {
  const content = Buffer.from(base64Content, "base64").toString("utf-8");

  if (/\.ya?ml$/.test(filename)) {
    try {
      const parsed = yaml.load(content);
      return {
        name: parsed.name ?? filename,
        title: parsed.title ?? "",
        body: "",
        labels: normalizeYamlLabels(parsed.labels),
      };
    } catch {
      return null;
    }
  }

  const frontMatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!frontMatterMatch) return null;

  try {
    const frontMatter = yaml.load(frontMatterMatch[1]);
    return {
      name: frontMatter.name ?? filename.replace(/\.md$/, ""),
      title: frontMatter.title ?? "",
      body: frontMatterMatch[2].trim(),
      labels: normalizeYamlLabels(frontMatter.labels),
    };
  } catch {
    return null;
  }
}

function normalizeYamlLabels(rawLabels) {
  if (!rawLabels) return [];
  if (Array.isArray(rawLabels)) return rawLabels.map(String);
  return String(rawLabels).split(",").map((l) => l.trim()).filter(Boolean);
}

async function addIssueToProject(projectId, issueNodeId) {
  const mutation = `mutation($projectId: ID!, $contentId: ID!) {
    addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) {
      item { id }
    }
  }`;
  const response = await octokit.graphql(mutation, { projectId, contentId: issueNodeId });
  return response.addProjectV2ItemById.item.id;
}

async function setProjectItemFields(projectId, itemId, projectFieldMap, formValues) {
  const mutation = `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
    updateProjectV2ItemFieldValue(input: {
      projectId: $projectId
      itemId: $itemId
      fieldId: $fieldId
      value: $value
    }) {
      projectV2Item { id }
    }
  }`;

  await Promise.all(
    Object.entries(projectFieldMap).map(async ([blockId, field]) => {
      const elementValues = formValues[blockId]?.[`${blockId}_input`];
      if (!elementValues) return;

      let fieldValue;
      if (field.dataType === "SINGLE_SELECT") {
        const optionId = elementValues.selected_option?.value;
        if (!optionId) return;
        fieldValue = { singleSelectOptionId: optionId };
      } else if (field.dataType === "NUMBER") {
        const num = parseFloat(elementValues.value);
        if (isNaN(num)) return;
        fieldValue = { number: num };
      } else if (field.dataType === "TEXT") {
        const text = elementValues.value?.trim();
        if (!text) return;
        fieldValue = { text };
      } else {
        return;
      }

      await octokit.graphql(mutation, { projectId, itemId, fieldId: field.id, value: fieldValue })
        .catch((err) => console.error(`Failed to set project field ${field.id}:`, err.message));
    })
  );
}

async function linkParentIssue(repoName, parentIssueInput, childNodeId) {
  const parentIssueNumber = parseInt(String(parentIssueInput).replace(/^#/, ""), 10);
  if (isNaN(parentIssueNumber)) return;

  const parentIssue = await octokit.rest.issues.get({
    owner: githubOwner,
    repo: repoName,
    issue_number: parentIssueNumber,
  }).catch(() => null);

  if (!parentIssue) return;

  await octokit.graphql(`
    mutation($parentId: ID!, $childId: ID!) {
      addSubIssue(input: { issueId: $parentId, subIssueId: $childId }) {
        subIssue { id }
      }
    }
  `, { parentId: parentIssue.data.node_id, childId: childNodeId })
    .catch((err) => console.error("Failed to link parent issue:", err.message));
}

// ── Defaults resolution ───────────────────────────────────────────────────────

function resolveDefaultProjectId(projects, userProjectId) {
  if (userProjectId && projects.some((project) => project.value === userProjectId)) {
    return userProjectId;
  }
  if (process.env.DEFAULT_GITHUB_PROJECT) {
    return projects.find((project) => project.text === process.env.DEFAULT_GITHUB_PROJECT)?.value ?? null;
  }
  return null;
}

function buildProjectFieldMap(projectFields) {
  const fieldMap = {};
  projectFields.forEach((field, index) => {
    fieldMap[`pf_${index}`] = { id: field.id, dataType: field.dataType };
  });
  return fieldMap;
}

// ── Modal builder ─────────────────────────────────────────────────────────────

function toSlackOption(displayText, value) {
  return {
    text: { type: "plain_text", text: String(displayText).slice(0, 75) },
    value: String(value),
  };
}

function buildModal({
  messageText = "",
  selectedRepo = null,
  metadata,
  currentTitle = "",
  currentBody = "",
  labels = [],
  milestones = [],
  projects = [],
  templates = [],
  projectFields = [],
  initialLabelValues = [],
  initialMilestoneValue = null,
  initialProjectId = null,
  initialTemplateId = null,
}) {
  const blocks = [
    {
      type: "input",
      block_id: "repo_block",
      dispatch_action: true,
      label: { type: "plain_text", text: "Repository" },
      element: {
        type: "external_select",
        action_id: "repo_select",
        min_query_length: 0,
        placeholder: { type: "plain_text", text: "Pick a repo…" },
        ...(selectedRepo ? { initial_option: toSlackOption(selectedRepo, selectedRepo) } : {}),
      },
    },
  ];

  if (templates.length > 0) {
    const preSelectedTemplate = templates.find((t) => t.name === initialTemplateId);
    blocks.push({
      type: "input",
      block_id: "template_block",
      dispatch_action: true,
      optional: true,
      label: { type: "plain_text", text: "Template" },
      element: {
        type: "static_select",
        action_id: "template_select",
        placeholder: { type: "plain_text", text: "Select a template…" },
        options: templates.map((t) => toSlackOption(t.name, t.name)),
        ...(preSelectedTemplate ? { initial_option: toSlackOption(preSelectedTemplate.name, preSelectedTemplate.name) } : {}),
      },
    });
  }

  blocks.push(
    {
      type: "input",
      block_id: "title_block",
      label: { type: "plain_text", text: "Issue Title" },
      element: {
        type: "plain_text_input",
        action_id: "title_input",
        initial_value: currentTitle,
        placeholder: { type: "plain_text", text: "Brief summary" },
      },
    },
    {
      type: "input",
      block_id: "body_block",
      label: { type: "plain_text", text: "Issue Body" },
      element: {
        type: "plain_text_input",
        action_id: "body_input",
        multiline: true,
        initial_value: currentBody || messageText,
      },
    }
  );

  if (!selectedRepo) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: "Select a repo to load its labels, milestones & projects." }],
    });
  }

  if (labels.length > 0) {
    const preSelectedLabels = labels
      .filter((label) => initialLabelValues.includes(label.value))
      .map((label) => toSlackOption(label.text, label.value));
    blocks.push({
      type: "input",
      block_id: "labels_block",
      optional: true,
      label: { type: "plain_text", text: "Labels" },
      element: {
        type: "multi_static_select",
        action_id: "labels_select",
        placeholder: { type: "plain_text", text: "Select labels…" },
        options: labels.map((label) => toSlackOption(label.text, label.value)),
        ...(preSelectedLabels.length > 0 ? { initial_options: preSelectedLabels } : {}),
      },
    });
  }

  if (milestones.length > 0) {
    const preSelectedMilestone = milestones.find((milestone) => milestone.value === initialMilestoneValue);
    blocks.push({
      type: "input",
      block_id: "milestone_block",
      optional: true,
      label: { type: "plain_text", text: "Milestone" },
      element: {
        type: "static_select",
        action_id: "milestone_select",
        placeholder: { type: "plain_text", text: "Select milestone…" },
        options: milestones.map((milestone) => toSlackOption(milestone.text, milestone.value)),
        ...(preSelectedMilestone ? { initial_option: toSlackOption(preSelectedMilestone.text, preSelectedMilestone.value) } : {}),
      },
    });
  }

  if (projects.length > 0) {
    const preSelectedProject = projects.find((project) => project.value === initialProjectId);
    blocks.push({
      type: "input",
      block_id: "project_block",
      dispatch_action: true,
      label: { type: "plain_text", text: "Project" },
      element: {
        type: "static_select",
        action_id: "project_select",
        placeholder: { type: "plain_text", text: "Select project…" },
        options: projects.map((project) => toSlackOption(project.text, project.value)),
        ...(preSelectedProject ? { initial_option: toSlackOption(preSelectedProject.text, preSelectedProject.value) } : {}),
      },
    });
  }

  projectFields.forEach((field, index) => {
    const blockId = `pf_${index}`;
    const fieldNameLower = field.name.toLowerCase();
    if (field.dataType === "SINGLE_SELECT" && field.options?.length > 0) {
      const isMandatory = fieldNameLower === "priority";
      const defaultOption = fieldNameLower === "status"
        ? field.options.find((opt) => opt.name.toLowerCase() === "backlog") ?? null
        : null;
      blocks.push({
        type: "input",
        block_id: blockId,
        ...(isMandatory ? {} : { optional: true }),
        label: { type: "plain_text", text: field.name },
        element: {
          type: "static_select",
          action_id: `${blockId}_input`,
          placeholder: { type: "plain_text", text: `Select ${field.name}…` },
          options: field.options.map((opt) => toSlackOption(opt.name, opt.id)),
          ...(defaultOption ? { initial_option: toSlackOption(defaultOption.name, defaultOption.id) } : {}),
        },
      });
    } else if (field.dataType === "NUMBER" || field.dataType === "TEXT") {
      blocks.push({
        type: "input",
        block_id: blockId,
        optional: true,
        label: { type: "plain_text", text: field.name },
        element: {
          type: "plain_text_input",
          action_id: `${blockId}_input`,
          placeholder: { type: "plain_text", text: `Enter ${field.name}…` },
        },
      });
    }
  });

  if (selectedRepo) {
    blocks.push({
      type: "input",
      block_id: "parent_issue_block",
      optional: true,
      label: { type: "plain_text", text: "Parent Issue" },
      element: {
        type: "plain_text_input",
        action_id: "parent_issue_input",
        placeholder: { type: "plain_text", text: "Issue number (e.g. 123)" },
      },
    });
  }

  return {
    type: "modal",
    callback_id: "create_issue_modal",
    private_metadata: JSON.stringify(metadata),
    title: { type: "plain_text", text: "Create GitHub Issue" },
    submit: { type: "plain_text", text: "Create Issue" },
    close: { type: "plain_text", text: "Cancel" },
    blocks,
  };
}

// ── Event handlers ────────────────────────────────────────────────────────────

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

  const slackMessageContext = { channelId, threadTs, messageTs, userId, permalink: permalinkResult?.permalink ?? "", projectFieldMap: {} };

  await client.views.open({
    trigger_id: shortcut.trigger_id,
    view: buildModal({ messageText, metadata: slackMessageContext }),
  });
});

// 2. /issue slash command → open the modal with title pre-filled
app.command("/issue", async ({ command, ack, client }) => {
  await ack();

  const slackMessageContext = {
    channelId: command.channel_id,
    threadTs: null,
    messageTs: null,
    userId: command.user_id,
    permalink: "",
    projectFieldMap: {},
  };

  await client.views.open({
    trigger_id: command.trigger_id,
    view: buildModal({ currentTitle: command.text?.trim() ?? "", metadata: slackMessageContext }),
  });
});

// 3. @mention in a thread → ephemeral button to open the modal
// Workaround for Slack not supporting slash commands in threads.
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
          text: issueTitle ? `Create issue: *${issueTitle}*` : "Create a GitHub issue from this thread?",
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
        ],
      },
    ],
  });
});

// 4. Button from @mention → open the modal
app.action("open_modal_from_mention", async ({ ack, action, body, client }) => {
  await ack();

  const { issueTitle, ...slackMessageContext } = JSON.parse(action.value);

  await client.views.open({
    trigger_id: body.trigger_id,
    view: buildModal({ currentTitle: issueTitle ?? "", metadata: slackMessageContext }),
  });
});

// 5. External data source for the repo selector
app.options("repo_select", async ({ ack }) => {
  try {
    const repos = await getRepos();
    await ack({ options: repos.map((repoName) => toSlackOption(repoName, repoName)) });
  } catch (err) {
    await ack({ options: [toSlackOption(`Error: ${err.message}`, "__error__")] });
  }
});

// 6. Repo selected → load labels/milestones/projects/templates and apply user defaults
app.action("repo_select", async ({ ack, action, body, client }) => {
  await ack();

  const selectedRepo = action.selected_option?.value;
  if (!selectedRepo || selectedRepo === "__error__") return;

  const modalView = body.view;
  const slackMessageContext = JSON.parse(modalView.private_metadata);
  const currentTitle = modalView.state.values.title_block?.title_input?.value ?? "";
  const currentBody = modalView.state.values.body_block?.body_input?.value ?? "";

  const defaults = getUserDefaults(body.user?.id);

  const [labels, milestones, projects, templates] = await Promise.all([
    getLabels(selectedRepo),
    getMilestones(selectedRepo),
    getProjects(),
    getIssueTemplates(selectedRepo),
  ]);

  const initialProjectId = resolveDefaultProjectId(projects, defaults.projectId);
  const projectFields = initialProjectId ? await getProjectFields(initialProjectId).catch(() => []) : [];
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
    }),
  });
});

// 7. Template selected → pre-fill title, body, and labels from the template
app.action("template_select", async ({ ack, action, body, client }) => {
  await ack();

  const selectedTemplateName = action.selected_option?.value;
  const modalView = body.view;
  const slackMessageContext = JSON.parse(modalView.private_metadata);

  const selectedRepo = modalView.state.values.repo_block?.repo_select?.selected_option?.value;
  if (!selectedRepo) return;

  const defaults = getUserDefaults(body.user?.id);
  const initialProjectId = slackMessageContext.projectFieldMap
    ? (modalView.state.values.project_block?.project_select?.selected_option?.value ?? null)
    : null;

  const [labels, milestones, projects, templates, projectFields] = await Promise.all([
    getLabels(selectedRepo),
    getMilestones(selectedRepo),
    getProjects(),
    getIssueTemplates(selectedRepo),
    initialProjectId ? getProjectFields(initialProjectId).catch(() => []) : Promise.resolve([]),
  ]);

  const selectedTemplate = templates.find((t) => t.name === selectedTemplateName);
  const resolvedProjectId = resolveDefaultProjectId(projects, defaults.projectId) ?? initialProjectId;
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
    }),
  });
});

// 8. Project selected → load and display the project's custom fields
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

  const [labels, milestones, projects, templates, projectFields] = await Promise.all([
    getLabels(selectedRepo),
    getMilestones(selectedRepo),
    getProjects(),
    getIssueTemplates(selectedRepo),
    selectedProjectId ? getProjectFields(selectedProjectId).catch(() => []) : Promise.resolve([]),
  ]);

  const projectFieldMap = buildProjectFieldMap(projectFields);

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
      initialTemplateId: selectedTemplateName,
      initialProjectId: selectedProjectId,
      initialMilestoneValue: currentMilestoneValue,
      initialLabelValues: currentLabelValues,
    }),
  });
});

// 9. Modal submitted → create the GitHub issue and save user defaults
app.view("create_issue_modal", async ({ ack, view, client }) => {
  const formValues = view.state.values;
  const slackMessageContext = JSON.parse(view.private_metadata);

  const selectedRepo = formValues.repo_block?.repo_select?.selected_option?.value ?? "";
  const issueTitle = formValues.title_block?.title_input?.value ?? "";
  const selectedLabels = formValues.labels_block?.labels_select?.selected_options?.map((selectedOption) => selectedOption.value) ?? [];
  const milestoneValue = formValues.milestone_block?.milestone_select?.selected_option?.value ?? null;
  const milestoneNumber = milestoneValue ? Number(milestoneValue) : undefined;
  const selectedProjectId = formValues.project_block?.project_select?.selected_option?.value ?? null;
  const parentIssueInput = formValues.parent_issue_block?.parent_issue_input?.value?.trim() ?? null;

  const slackThreadLink = slackMessageContext.permalink
    ? `\n\n---\n_Created from Slack: ${slackMessageContext.permalink}_`
    : "";
  const issueBody = (formValues.body_block?.body_input?.value ?? "") + slackThreadLink;

  userDefaults.set(slackMessageContext.userId, {
    repo: selectedRepo,
    projectId: selectedProjectId,
    milestoneValue,
    labelValues: selectedLabels,
  });

  await ack();

  try {
    const { data: createdIssue } = await octokit.rest.issues.create({
      owner: githubOwner,
      repo: selectedRepo,
      title: issueTitle,
      body: issueBody,
      labels: selectedLabels.length > 0 ? selectedLabels : undefined,
      milestone: milestoneNumber,
    });

    if (selectedProjectId) {
      const projectItemId = await addIssueToProject(selectedProjectId, createdIssue.node_id)
        .catch((err) => { console.error("Failed to add issue to project:", err.message); return null; });

      if (projectItemId && slackMessageContext.projectFieldMap) {
        await setProjectItemFields(selectedProjectId, projectItemId, slackMessageContext.projectFieldMap, formValues);
      }
    }

    if (parentIssueInput) {
      await linkParentIssue(selectedRepo, parentIssueInput, createdIssue.node_id);
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
      text: `Failed to create GitHub issue in *${selectedRepo}*: ${err.message}`,
    });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const requiredEnvVars = isSocketMode
  ? ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "GITHUB_TOKEN", "GITHUB_OWNER"]
  : ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET", "GITHUB_TOKEN", "GITHUB_OWNER"];

const missingEnvVars = requiredEnvVars.filter((envVarName) => !process.env[envVarName]);
if (missingEnvVars.length > 0) {
  console.warn(`[warn] Missing required environment variables: ${missingEnvVars.join(", ")}`);
}

if (isSocketMode) {
  (async () => {
    await app.start();
    console.log("slack-github-issues is running (Socket Mode)");
  })();
}

// Lambda handler — only invoked when deployed to AWS Lambda (HTTP mode)
export const handler = async (event, context) => {
  if (!awsLambdaReceiver) throw new Error("Lambda handler invoked but app is configured for Socket Mode");
  const lambdaHandler = await awsLambdaReceiver.start();
  return lambdaHandler(event, context);
};
