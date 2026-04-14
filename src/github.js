import yaml from "js-yaml";

// ── Pure helpers ──────────────────────────────────────────────────────────────

export function normalizeYamlLabels(rawLabels) {
  if (!rawLabels) return [];
  if (Array.isArray(rawLabels)) return rawLabels.map(String);
  return String(rawLabels).split(",").map((label) => label.trim()).filter(Boolean);
}

export function parseIssueTemplate(base64Content, filename) {
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

// ── GitHub API helpers ────────────────────────────────────────────────────────

export function createGitHubHelpers(octokit, githubOwner) {
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
    const orgQuery = `query($owner: String!) {
      organization(login: $owner) {
        projectsV2(first: 50, orderBy: {field: TITLE, direction: ASC}) {
          nodes { id title }
        }
      }
    }`;
    const userQuery = `query($owner: String!) {
      user(login: $owner) {
        projectsV2(first: 50, orderBy: {field: TITLE, direction: ASC}) {
          nodes { id title }
        }
      }
    }`;

    const toProjectOption = (project) => ({ text: project.title, value: project.id });

    const orgResult = await octokit.graphql(orgQuery, { owner: githubOwner }).catch(() => null);
    if (orgResult) {
      return orgResult.organization.projectsV2.nodes.map(toProjectOption);
    }

    const userResult = await octokit.graphql(userQuery, { owner: githubOwner }).catch(() => null);
    return (userResult?.user?.projectsV2?.nodes ?? []).map(toProjectOption);
  }

  async function getProjectFields(projectId) {
    const query = `query($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          fields(first: 50) {
            nodes {
              __typename
              ... on ProjectV2Field {
                id name dataType
              }
              ... on ProjectV2SingleSelectField {
                id name dataType
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

  async function createIssue({ repo, title, body, labels, milestone }) {
    const { data } = await octokit.rest.issues.create({
      owner: githubOwner,
      repo,
      title,
      body,
      labels: labels?.length > 0 ? labels : undefined,
      milestone,
    });
    return data;
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

  async function setProjectField(projectId, itemId, fieldId, value) {
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
    await octokit.graphql(mutation, { projectId, itemId, fieldId, value });
  }

  async function setProjectItemFields(projectId, itemId, projectFieldMap, formValues) {
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

        await setProjectField(projectId, itemId, field.id, fieldValue)
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

  async function getIssue(repo, issueNumber) {
    const { data } = await octokit.rest.issues.get({
      owner: githubOwner,
      repo,
      issue_number: issueNumber,
    });
    return data;
  }

  async function searchIssues(query) {
    const { data } = await octokit.rest.search.issuesAndPullRequests({
      q: `${query} user:${githubOwner} is:issue`,
      per_page: 10,
      sort: "updated",
      order: "desc",
    });
    return data.items;
  }

  async function addIssueComment(repo, issueNumber, body) {
    const { data } = await octokit.rest.issues.createComment({
      owner: githubOwner,
      repo,
      issue_number: issueNumber,
      body,
    });
    return data;
  }

  return {
    getRepos,
    getLabels,
    getMilestones,
    getProjects,
    getProjectFields,
    getIssueTemplates,
    createIssue,
    addIssueToProject,
    setProjectField,
    setProjectItemFields,
    linkParentIssue,
    getIssue,
    searchIssues,
    addIssueComment,
  };
}
