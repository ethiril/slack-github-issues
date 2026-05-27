import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseCaretCommand,
  collectModalProjectFieldValues,
  fetchRepoFormData,
} from "../src/handlers/helpers.js";

describe("parseCaretCommand", () => {
  test("bare caret → no repo, no issue number", () => {
    assert.deepEqual(parseCaretCommand("^"), { repoOverride: null, issueNumber: null });
  });

  test("repo before caret → repo override", () => {
    assert.deepEqual(parseCaretCommand("moneysatnav_flutter ^"), {
      repoOverride: "moneysatnav_flutter",
      issueNumber: null,
    });
  });

  test("repo + number before caret → both", () => {
    assert.deepEqual(parseCaretCommand("moneysatnav_flutter 6715 ^"), {
      repoOverride: "moneysatnav_flutter",
      issueNumber: 6715,
    });
  });

  test("number with leading # is tolerated", () => {
    assert.deepEqual(parseCaretCommand("repo #6715^"), {
      repoOverride: "repo",
      issueNumber: 6715,
    });
  });

  test("bare number before caret → issue number, no repo (uses default)", () => {
    assert.deepEqual(parseCaretCommand("6715 ^"), {
      repoOverride: null,
      issueNumber: 6715,
    });
  });

  test("no space before caret still parses the repo", () => {
    assert.deepEqual(parseCaretCommand("repo^"), { repoOverride: "repo", issueNumber: null });
  });

  test("leading summary words are ignored; repo is the token before caret", () => {
    assert.deepEqual(parseCaretCommand("please file this repo-name ^"), {
      repoOverride: "repo-name",
      issueNumber: null,
    });
  });

  test("invalid repo token before a number is dropped, number kept", () => {
    assert.deepEqual(parseCaretCommand("not/a/repo 42 ^"), {
      repoOverride: null,
      issueNumber: 42,
    });
  });
});

describe("collectModalProjectFieldValues", () => {
  test("reads single-select option values from pf_<n> blocks", () => {
    const values = {
      pf_0: { pf_0_input: { selected_option: { value: "opt-1" } } },
      pf_1: { pf_1_input: { value: "free text" } },
    };
    assert.deepEqual(collectModalProjectFieldValues(values), { pf_0: "opt-1", pf_1: "free text" });
  });

  test("ignores non-project blocks and empty inputs", () => {
    const values = {
      title_block: { title_input: { value: "ignored" } },
      pf_0: { pf_0_input: { value: "" } },
      pf_2: { pf_2_input: {} },
    };
    assert.deepEqual(collectModalProjectFieldValues(values), {});
  });

  test("defaults to empty object when given no state", () => {
    assert.deepEqual(collectModalProjectFieldValues(), {});
  });
});

describe("fetchRepoFormData", () => {
  const baseGithub = () => {
    const calls = [];
    const record = (name, ret) => (...args) => { calls.push([name, ...args]); return Promise.resolve(ret); };
    return {
      calls,
      getRepos: record("getRepos", ["a", "b"]),
      getLabels: record("getLabels", [{ text: "bug", value: "bug" }]),
      getMilestones: record("getMilestones", [{ text: "v1", value: "1" }]),
      getAssignees: record("getAssignees", [{ text: "me", value: "me" }]),
      getProjects: record("getProjects", [{ text: "P", value: "p1" }]),
      getIssueTemplates: record("getIssueTemplates", [{ name: "t" }]),
      getProjectFields: record("getProjectFields", [{ id: "f1", name: "Priority" }]),
    };
  };

  test("fans out all fetches and returns the assembled form data", async () => {
    const github = baseGithub();
    const data = await fetchRepoFormData(github, "repo-x", { projectId: "p1" });
    assert.deepEqual(data.repoOptions, ["a", "b"]);
    assert.deepEqual(data.templates, [{ name: "t" }]);
    assert.deepEqual(data.projectFields, [{ id: "f1", name: "Priority" }]);
    assert.ok(github.calls.some(([name, arg]) => name === "getLabels" && arg === "repo-x"));
  });

  test("skips templates when includeTemplates is false and project fields when no projectId", async () => {
    const github = baseGithub();
    const data = await fetchRepoFormData(github, "repo-x", { includeTemplates: false });
    assert.deepEqual(data.templates, []);
    assert.deepEqual(data.projectFields, []);
    assert.ok(!github.calls.some(([name]) => name === "getIssueTemplates"));
    assert.ok(!github.calls.some(([name]) => name === "getProjectFields"));
  });

  test("swallows a getProjectFields rejection into an empty array", async () => {
    const github = baseGithub();
    github.getProjectFields = () => Promise.reject(new Error("boom"));
    const data = await fetchRepoFormData(github, "repo-x", { projectId: "p1" });
    assert.deepEqual(data.projectFields, []);
  });
});
