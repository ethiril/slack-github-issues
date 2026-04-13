import bolt from "@slack/bolt";
import { Octokit } from "@octokit/rest";

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

async function addIssueToProject(projectId, issueNodeId) {
  const mutation = `mutation($projectId: ID!, $contentId: ID!) {
    addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) {
      item { id }
    }
  }`;
  await octokit.graphql(mutation, { projectId, contentId: issueNodeId });
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
  initialLabelValues = [],
  initialMilestoneValue = null,
  initialProjectId = null,
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
    },
  ];

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
      optional: true,
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

  const slackMessageContext = { channelId, threadTs, messageTs, userId, permalink: permalinkResult?.permalink ?? "" };

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
  };

  await client.views.open({
    trigger_id: command.trigger_id,
    view: buildModal({ currentTitle: command.text?.trim() ?? "", metadata: slackMessageContext }),
  });
});

// 3. External data source for the repo selector
app.options("repo_select", async ({ ack }) => {
  try {
    const repos = await getRepos();
    await ack({ options: repos.map((repoName) => toSlackOption(repoName, repoName)) });
  } catch (err) {
    await ack({ options: [toSlackOption(`Error: ${err.message}`, "__error__")] });
  }
});

// 4. Repo selected → update modal with labels/milestones/projects and apply user defaults
app.action("repo_select", async ({ ack, action, body, client }) => {
  await ack();

  const selectedRepo = action.selected_option?.value;
  if (!selectedRepo || selectedRepo === "__error__") return;

  const modalView = body.view;
  const slackMessageContext = JSON.parse(modalView.private_metadata);
  const currentTitle = modalView.state.values.title_block?.title_input?.value ?? "";
  const currentBody = modalView.state.values.body_block?.body_input?.value ?? "";

  const defaults = getUserDefaults(body.user?.id);

  const [labels, milestones, projects] = await Promise.all([
    getLabels(selectedRepo),
    getMilestones(selectedRepo),
    getProjects(),
  ]);

  const initialProjectId = resolveDefaultProjectId(projects, defaults.projectId);
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
      metadata: slackMessageContext,
      currentTitle,
      currentBody,
      labels,
      milestones,
      projects,
      initialProjectId,
      initialMilestoneValue,
      initialLabelValues,
    }),
  });
});

// 5. Modal submitted → create the GitHub issue and save user defaults
app.view("create_issue_modal", async ({ ack, view, client }) => {
  const formValues = view.state.values;
  const slackMessageContext = JSON.parse(view.private_metadata);

  const selectedRepo = formValues.repo_block?.repo_select?.selected_option?.value ?? "";
  const issueTitle = formValues.title_block?.title_input?.value ?? "";
  const selectedLabels = formValues.labels_block?.labels_select?.selected_options?.map((selectedOption) => selectedOption.value) ?? [];
  const milestoneValue = formValues.milestone_block?.milestone_select?.selected_option?.value ?? null;
  const milestoneNumber = milestoneValue ? Number(milestoneValue) : undefined;
  const selectedProjectId = formValues.project_block?.project_select?.selected_option?.value ?? null;

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
      await addIssueToProject(selectedProjectId, createdIssue.node_id).catch((err) =>
        console.error("Failed to add issue to project:", err.message)
      );
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
