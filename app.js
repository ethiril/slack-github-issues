import "dotenv/config";
import bolt from "@slack/bolt";
import { Octokit } from "@octokit/rest";

const { App } = bolt;

// ── Clients ──────────────────────────────────────────────────────────────────

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

const OWNER = process.env.GITHUB_OWNER;

// ── GitHub helpers ───────────────────────────────────────────────────────────

async function getRepos() {
  // If repos are explicitly listed, use those
  if (process.env.GITHUB_REPOS) {
    return process.env.GITHUB_REPOS.split(",").map((r) => r.trim());
  }
  // Otherwise fetch from the org/user
  const repos = await octokit.paginate(octokit.rest.repos.listForOrg, {
    org: OWNER,
    type: "all",
    per_page: 100,
  }).catch(async () => {
    // Fall back to user repos if not an org
    return octokit.paginate(octokit.rest.repos.listForUser, {
      username: OWNER,
      per_page: 100,
    });
  });
  return repos.map((r) => r.name).sort();
}

async function getLabels(repo) {
  const labels = await octokit.paginate(octokit.rest.issues.listLabelsForRepo, {
    owner: OWNER,
    repo,
    per_page: 100,
  });
  return labels.map((l) => ({ text: l.name, value: l.name }));
}

async function getMilestones(repo) {
  const milestones = await octokit.paginate(
    octokit.rest.issues.listMilestones,
    { owner: OWNER, repo, state: "open", per_page: 100 }
  );
  return milestones.map((m) => ({
    text: m.title,
    value: String(m.number),
  }));
}

async function getOrgProjects() {
  // Projects v2 requires GraphQL
  const query = `query($owner: String!) {
    organization(login: $owner) {
      projectsV2(first: 50, orderBy: {field: TITLE, direction: ASC}) {
        nodes { id title }
      }
    }
  }`;
  try {
    const resp = await octokit.graphql(query, { owner: OWNER });
    return resp.organization.projectsV2.nodes.map((p) => ({
      text: p.title,
      value: p.id,
    }));
  } catch {
    // Fall back to user projects if not an org
    try {
      const userQuery = `query($owner: String!) {
        user(login: $owner) {
          projectsV2(first: 50, orderBy: {field: TITLE, direction: ASC}) {
            nodes { id title }
          }
        }
      }`;
      const resp = await octokit.graphql(userQuery, { owner: OWNER });
      return resp.user.projectsV2.nodes.map((p) => ({
        text: p.title,
        value: p.id,
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

// ── Slack modal helpers ──────────────────────────────────────────────────────

function option(text, value) {
  return {
    text: { type: "plain_text", text: String(text).slice(0, 75) },
    value: String(value),
  };
}

/** Build the initial modal (repo picker + title + body only). */
function buildInitialModal({ messageText, metadata }) {
  return {
    type: "modal",
    callback_id: "create_issue_modal",
    private_metadata: JSON.stringify(metadata),
    title: { type: "plain_text", text: "Create GitHub Issue" },
    submit: { type: "plain_text", text: "Create Issue" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "repo_block",
        dispatch_action: true,
        label: { type: "plain_text", text: "Repository" },
        element: {
          type: "external_select",
          action_id: "repo_select",
          placeholder: { type: "plain_text", text: "Pick a repo…" },
          min_query_length: 0,
        },
      },
      {
        type: "input",
        block_id: "title_block",
        label: { type: "plain_text", text: "Issue Title" },
        element: {
          type: "plain_text_input",
          action_id: "title_input",
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
          initial_value: messageText,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "💡 Select a repo to load its labels, milestones & projects.",
          },
        ],
      },
    ],
  };
}

/** Rebuild the modal with repo-specific fields populated. */
function buildFullModal({ repo, metadata, currentTitle, currentBody, labels, milestones, projects }) {
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
        initial_option: option(repo, repo),
      },
    },
    {
      type: "input",
      block_id: "title_block",
      label: { type: "plain_text", text: "Issue Title" },
      element: {
        type: "plain_text_input",
        action_id: "title_input",
        initial_value: currentTitle || "",
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
        initial_value: currentBody || "",
      },
    },
  ];

  // Labels (multi-select, optional)
  if (labels.length > 0) {
    blocks.push({
      type: "input",
      block_id: "labels_block",
      optional: true,
      label: { type: "plain_text", text: "Labels" },
      element: {
        type: "multi_static_select",
        action_id: "labels_select",
        placeholder: { type: "plain_text", text: "Select labels…" },
        options: labels.map((l) => option(l.text, l.value)),
      },
    });
  }

  // Milestone (single select, optional)
  if (milestones.length > 0) {
    blocks.push({
      type: "input",
      block_id: "milestone_block",
      optional: true,
      label: { type: "plain_text", text: "Milestone" },
      element: {
        type: "static_select",
        action_id: "milestone_select",
        placeholder: { type: "plain_text", text: "Select milestone…" },
        options: milestones.map((m) => option(m.text, m.value)),
      },
    });
  }

  // Project (single select, optional)
  if (projects.length > 0) {
    blocks.push({
      type: "input",
      block_id: "project_block",
      optional: true,
      label: { type: "plain_text", text: "Project" },
      element: {
        type: "static_select",
        action_id: "project_select",
        placeholder: { type: "plain_text", text: "Select project…" },
        options: projects.map((p) => option(p.text, p.value)),
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

// ── Event handlers ───────────────────────────────────────────────────────────

// 1. Message shortcut → open the modal
app.shortcut("create_github_issue", async ({ shortcut, ack, client }) => {
  await ack();

  const messageText = shortcut.message?.text || "";
  const channelId = shortcut.channel?.id;
  const threadTs = shortcut.message?.thread_ts || shortcut.message?.ts;
  const messageTs = shortcut.message?.ts;
  const userId = shortcut.user?.id;

  // Build a permalink to the original Slack message
  let permalink = "";
  try {
    const pl = await client.chat.getPermalink({
      channel: channelId,
      message_ts: messageTs,
    });
    permalink = pl.permalink;
  } catch { /* non-critical */ }

  const metadata = { channelId, threadTs, messageTs, permalink, userId };

  await client.views.open({
    trigger_id: shortcut.trigger_id,
    view: buildInitialModal({ messageText, metadata }),
  });
});

// 2. External data source for the repo selector
app.options("repo_select", async ({ ack }) => {
  const repos = await getRepos();
  await ack({
    options: repos.map((r) => option(r, r)),
  });
});

// 3. Repo selected → update modal with labels/milestones/projects
app.action("repo_select", async ({ ack, action, body, client }) => {
  await ack();

  const repo = action.selected_option.value;
  const view = body.view;
  const metadata = JSON.parse(view.private_metadata);

  // Grab whatever the user already typed so we don't blow it away
  const currentTitle =
    view.state.values.title_block?.title_input?.value || "";
  const currentBody =
    view.state.values.body_block?.body_input?.value || "";

  // Fetch repo-specific data in parallel
  const [labels, milestones, projects] = await Promise.all([
    getLabels(repo),
    getMilestones(repo),
    getOrgProjects(),
  ]);

  await client.views.update({
    view_id: view.id,
    hash: view.hash,
    view: buildFullModal({
      repo,
      metadata,
      currentTitle,
      currentBody,
      labels,
      milestones,
      projects,
    }),
  });
});

// 4. Modal submitted → create the GitHub issue
app.view("create_issue_modal", async ({ ack, view, client }) => {
  const vals = view.state.values;
  const metadata = JSON.parse(view.private_metadata);

  const repo = vals.repo_block.repo_select.selected_option.value;
  const title = vals.title_block.title_input.value;
  let body = vals.body_block.body_input.value || "";

  const labelNames =
    vals.labels_block?.labels_select?.selected_options?.map(
      (o) => o.value
    ) || [];

  const milestoneNumber = vals.milestone_block?.milestone_select
    ?.selected_option?.value
    ? Number(vals.milestone_block.milestone_select.selected_option.value)
    : undefined;

  const projectId =
    vals.project_block?.project_select?.selected_option?.value || null;

  // Append a link back to the Slack thread
  if (metadata.permalink) {
    body += `\n\n---\n_Created from Slack: ${metadata.permalink}_`;
  }

  // Acknowledge the modal immediately so Slack doesn't time out
  await ack();

  try {
    // Create the issue
    const { data: issue } = await octokit.rest.issues.create({
      owner: OWNER,
      repo,
      title,
      body,
      labels: labelNames.length > 0 ? labelNames : undefined,
      milestone: milestoneNumber,
    });

    // Add to project if selected
    if (projectId) {
      try {
        await addIssueToProject(projectId, issue.node_id);
      } catch (err) {
        console.error("Failed to add issue to project:", err.message);
      }
    }

    // Post confirmation back into the Slack thread
    await client.chat.postMessage({
      channel: metadata.channelId,
      thread_ts: metadata.threadTs,
      unfurl_links: false,
      text: `✅ Issue created: <${issue.html_url}|${repo}#${issue.number} — ${title}>`,
    });
  } catch (err) {
    console.error("Failed to create issue:", err);
    // DM the user so they know something went wrong
    await client.chat.postMessage({
      channel: metadata.userId,
      text: `❌ Failed to create GitHub issue in *${repo}*: ${err.message}`,
    });
  }
});

// ── Start ────────────────────────────────────────────────────────────────────

(async () => {
  await app.start();
  console.log("⚡ slack-github-issues is running (Socket Mode)");
})();
