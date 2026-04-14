import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  registerThreadIssue,
  getThreadIssue,
  updateThreadIssueSyncTs,
  clearThreadIssueMap,
} from "../src/thread-store.js";

describe("thread-store", () => {
  beforeEach(() => clearThreadIssueMap());

  test("getThreadIssue returns null for unknown threadTs", () => {
    assert.equal(getThreadIssue("unknown.ts"), null);
  });

  test("registerThreadIssue stores entry retrievable by getThreadIssue", () => {
    registerThreadIssue("1000.0", "my-repo", 42, "999.0");
    const entry = getThreadIssue("1000.0");
    assert.equal(entry.repo, "my-repo");
    assert.equal(entry.issueNumber, 42);
    assert.equal(entry.lastSyncedTs, "999.0");
  });

  test("updateThreadIssueSyncTs updates lastSyncedTs for known threadTs", () => {
    registerThreadIssue("2000.0", "backend", 7, "1900.0");
    updateThreadIssueSyncTs("2000.0", "2100.0");
    assert.equal(getThreadIssue("2000.0").lastSyncedTs, "2100.0");
  });

  test("updateThreadIssueSyncTs is a no-op for unknown threadTs", () => {
    assert.doesNotThrow(() => updateThreadIssueSyncTs("nope.0", "1234.0"));
  });

  test("clearThreadIssueMap removes all entries", () => {
    registerThreadIssue("a.0", "repo-a", 1, "0.0");
    registerThreadIssue("b.0", "repo-b", 2, "0.0");
    clearThreadIssueMap();
    assert.equal(getThreadIssue("a.0"), null);
    assert.equal(getThreadIssue("b.0"), null);
  });

  test("multiple threads are stored independently", () => {
    registerThreadIssue("t1.0", "repo-x", 10, "t0.0");
    registerThreadIssue("t2.0", "repo-y", 20, "t0.0");
    assert.equal(getThreadIssue("t1.0").issueNumber, 10);
    assert.equal(getThreadIssue("t2.0").issueNumber, 20);
  });

  test("registering the same threadTs twice overwrites the previous entry", () => {
    registerThreadIssue("3000.0", "old-repo", 1, "0.0");
    registerThreadIssue("3000.0", "new-repo", 99, "500.0");
    const entry = getThreadIssue("3000.0");
    assert.equal(entry.repo, "new-repo");
    assert.equal(entry.issueNumber, 99);
  });
});
