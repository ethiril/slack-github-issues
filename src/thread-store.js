// In-memory store tracking which Slack threads have an associated GitHub issue.
// Enables "tag update": when a thread already has an issue, a new butler emoji
// reaction appends only the new messages as a comment instead of creating a
// duplicate.

const threadIssueMap = new Map();

export function registerThreadIssue(threadTs, repo, issueNumber, lastSyncedTs) {
  threadIssueMap.set(threadTs, { repo, issueNumber, lastSyncedTs });
}

export function getThreadIssue(threadTs) {
  return threadIssueMap.get(threadTs) ?? null;
}

export function updateThreadIssueSyncTs(threadTs, lastSyncedTs) {
  const entry = threadIssueMap.get(threadTs);
  if (entry) entry.lastSyncedTs = lastSyncedTs;
}

// For testing only
export function clearThreadIssueMap() {
  threadIssueMap.clear();
}
