// All functions in this module are pure — no I/O, no env reads, no side effects.
// buildModal and buildAddToIssueModal both read metadata.threadTs to decide
// whether to render the "Append full thread" checkbox.

export function toSlackOption(displayText, value) {
  return {
    text: { type: "plain_text", text: String(displayText).slice(0, 75) },
    value: String(value),
  };
}

export function resolveDefaultProjectId(projects, userProjectId, defaultProjectName) {
  if (userProjectId && projects.some((project) => project.value === userProjectId)) {
    return userProjectId;
  }
  if (defaultProjectName) {
    return projects.find((project) => project.text === defaultProjectName)?.value ?? null;
  }
  return null;
}

export function buildProjectFieldMap(projectFields) {
  const fieldMap = {};
  projectFields.forEach((field, index) => {
    fieldMap[`pf_${index}`] = { id: field.id, dataType: field.dataType };
  });
  return fieldMap;
}

export function buildModal({
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
  initialProjectFieldValues = {},
  repoOptions = [],
}) {
  const blocks = [
    {
      type: "input",
      block_id: "repo_block",
      dispatch_action: true,
      label: { type: "plain_text", text: "Repository" },
      element: {
        type: "static_select",
        action_id: "repo_select",
        placeholder: { type: "plain_text", text: "Pick a repo…" },
        options: repoOptions.map((repo) => toSlackOption(repo, repo)),
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
        ...(preSelectedTemplate
          ? { initial_option: toSlackOption(preSelectedTemplate.name, preSelectedTemplate.name) }
          : {}),
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

  if (metadata?.threadTs) {
    blocks.push({
      type: "input",
      block_id: "thread_block",
      optional: true,
      label: { type: "plain_text", text: "Thread" },
      element: {
        type: "checkboxes",
        action_id: "include_thread",
        options: [{
          text: { type: "plain_text", text: "Append full thread to body" },
          value: "include_thread",
        }],
      },
    });
  }

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
    const preSelectedMilestone = milestones.find((m) => m.value === initialMilestoneValue);
    blocks.push({
      type: "input",
      block_id: "milestone_block",
      optional: true,
      label: { type: "plain_text", text: "Milestone" },
      element: {
        type: "static_select",
        action_id: "milestone_select",
        placeholder: { type: "plain_text", text: "Select milestone…" },
        options: milestones.map((m) => toSlackOption(m.text, m.value)),
        ...(preSelectedMilestone
          ? { initial_option: toSlackOption(preSelectedMilestone.text, preSelectedMilestone.value) }
          : {}),
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
        ...(preSelectedProject
          ? { initial_option: toSlackOption(preSelectedProject.text, preSelectedProject.value) }
          : {}),
      },
    });
  }

  projectFields.forEach((field, index) => {
    const blockId = `pf_${index}`;
    const fieldNameLower = field.name.toLowerCase();
    const initialProjectFieldValue = initialProjectFieldValues[blockId] ?? null;

    if (field.dataType === "SINGLE_SELECT" && field.options?.length > 0) {
      const isMandatory = fieldNameLower === "priority";
      const initialOption =
        field.options.find((opt) => opt.id === initialProjectFieldValue) ??
        (fieldNameLower === "status"
          ? field.options.find((opt) => opt.name.toLowerCase() === "backlog") ?? null
          : null);

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
          ...(initialOption ? { initial_option: toSlackOption(initialOption.name, initialOption.id) } : {}),
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
          ...(initialProjectFieldValue != null ? { initial_value: String(initialProjectFieldValue) } : {}),
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

export function buildAddToIssueModal({
  messageText = "",
  metadata,
  currentBody = "",
  repoOptions = [],
}) {
  const blocks = [
    {
      type: "input",
      block_id: "repo_block",
      label: { type: "plain_text", text: "Repository" },
      element: {
        type: "static_select",
        action_id: "repo_select",
        placeholder: { type: "plain_text", text: "Pick a repo…" },
        options: repoOptions.map((repo) => toSlackOption(repo, repo)),
      },
    },
    {
      type: "input",
      block_id: "issue_number_block",
      label: { type: "plain_text", text: "Issue Number" },
      element: {
        type: "plain_text_input",
        action_id: "issue_number_input",
        placeholder: { type: "plain_text", text: "e.g. 123" },
      },
    },
    {
      type: "input",
      block_id: "body_block",
      label: { type: "plain_text", text: "Comment" },
      element: {
        type: "plain_text_input",
        action_id: "body_input",
        multiline: true,
        initial_value: currentBody || messageText,
      },
    },
  ];

  if (metadata?.threadTs) {
    blocks.push({
      type: "input",
      block_id: "thread_block",
      optional: true,
      label: { type: "plain_text", text: "Thread" },
      element: {
        type: "checkboxes",
        action_id: "include_thread",
        options: [{
          text: { type: "plain_text", text: "Append full thread to comment" },
          value: "include_thread",
        }],
      },
    });
  }

  return {
    type: "modal",
    callback_id: "add_to_issue_modal",
    private_metadata: JSON.stringify(metadata),
    title: { type: "plain_text", text: "Add to GitHub Issue" },
    submit: { type: "plain_text", text: "Add Comment" },
    close: { type: "plain_text", text: "Cancel" },
    blocks,
  };
}