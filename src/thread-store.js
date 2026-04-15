// Thread → GitHub issue mapping store.
// Enables "tag update": when a thread already has an issue, a new butler emoji
// reaction appends only the new messages as a comment instead of creating a
// duplicate.
//
// Backend: DynamoDB when DYNAMODB_TABLE is set, in-memory Map otherwise.
// All exports are async.

const TABLE = process.env.DYNAMODB_TABLE;

// In-memory fallback
const memoryMap = new Map();

// Tracks threads where a card has been posted but no issue created yet.
// Prevents duplicate cards from Lambda retries or rapid reactions.
const claimedCards = new Set();

// DynamoDB client — created lazily only if TABLE is set, to avoid loading the
// AWS SDK in local Socket Mode where DynamoDB is not used.
let dynamo = null;

async function getDynamo() {
  if (dynamo) return dynamo;
  const { DynamoDBClient, CreateTableCommand } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
  const clientConfig = {
    region: process.env.AWS_REGION ?? "eu-west-2",
    ...(process.env.DYNAMODB_ENDPOINT ? { endpoint: process.env.DYNAMODB_ENDPOINT } : {}),
  };
  const raw = new DynamoDBClient(clientConfig);
  try {
    await raw.send(new CreateTableCommand({
      TableName: TABLE,
      AttributeDefinitions: [{ AttributeName: "threadTs", AttributeType: "S" }],
      KeySchema: [{ AttributeName: "threadTs", KeyType: "HASH" }],
      BillingMode: "PAY_PER_REQUEST",
    }));
    console.log(`[thread-store] created DynamoDB table: ${TABLE}`);
  } catch (err) {
    if (err.name === "ResourceInUseException") {
      // Table already exists — expected on every cold start after first deploy
    } else if (err.name === "AccessDeniedException") {
      // Role lacks CreateTable — assume the table was pre-provisioned and proceed
      console.warn(`[thread-store] no CreateTable permission; assuming ${TABLE} already exists`);
    } else {
      throw err;
    }
  }
  dynamo = DynamoDBDocumentClient.from(raw);
  return dynamo;
}

// Atomically claim the right to post a card for a thread.
// Returns true if the claim was acquired (this caller should post the card).
// Returns false if another process already claimed it (duplicate — skip).
// The claim is released when:
//   a) The user cancels the card → releaseCardPost()
//   b) An issue is created → registerThreadIssue() overwrites the entry
export async function claimCardPost(threadTs) {
  if (!TABLE) {
    if (claimedCards.has(threadTs) || memoryMap.has(threadTs)) return false;
    claimedCards.add(threadTs);
    return true;
  }

  const { PutCommand } = await import("@aws-sdk/lib-dynamodb");
  const db = await getDynamo();
  try {
    await db.send(new PutCommand({
      TableName: TABLE,
      Item: { threadTs, status: "card_pending", claimedAt: Date.now() },
      ConditionExpression: "attribute_not_exists(threadTs)",
    }));
    return true;
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

// Release the card claim so the user can react again later.
// No-op if the thread already has a real issue registered.
export async function releaseCardPost(threadTs) {
  if (!TABLE) {
    claimedCards.delete(threadTs);
    return;
  }

  const { DeleteCommand } = await import("@aws-sdk/lib-dynamodb");
  const db = await getDynamo();
  // Only delete if still pending (not overwritten by a real issue entry)
  await db.send(new DeleteCommand({
    TableName: TABLE,
    Key: { threadTs },
    ConditionExpression: "#s = :pending",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: { ":pending": "card_pending" },
  })).catch(() => {}); // Ignore if item doesn't exist or is a real issue
}

export async function registerThreadIssue(threadTs, repo, issueNumber, lastSyncedTs) {
  if (!TABLE) {
    memoryMap.set(threadTs, { repo, issueNumber, lastSyncedTs });
    return;
  }

  const { PutCommand } = await import("@aws-sdk/lib-dynamodb");
  const db = await getDynamo();
  await db.send(new PutCommand({
    TableName: TABLE,
    Item: { threadTs, repo, issueNumber, lastSyncedTs },
  }));
}

export async function getThreadIssue(threadTs) {
  if (!TABLE) {
    return memoryMap.get(threadTs) ?? null;
  }

  const { GetCommand } = await import("@aws-sdk/lib-dynamodb");
  const db = await getDynamo();
  const result = await db.send(new GetCommand({
    TableName: TABLE,
    Key: { threadTs },
  }));
  const item = result.Item;
  // Ignore pending card claims — only return entries for actually-created issues.
  // claimCardPost shares this table/key and writes {threadTs, status: "card_pending"}.
  if (!item || item.status === "card_pending" || item.issueNumber == null) return null;
  return item;
}

export async function updateThreadIssueSyncTs(threadTs, lastSyncedTs) {
  if (!TABLE) {
    const entry = memoryMap.get(threadTs);
    if (entry) entry.lastSyncedTs = lastSyncedTs;
    return;
  }

  const { UpdateCommand } = await import("@aws-sdk/lib-dynamodb");
  const db = await getDynamo();
  await db.send(new UpdateCommand({
    TableName: TABLE,
    Key: { threadTs },
    UpdateExpression: "SET lastSyncedTs = :ts",
    ExpressionAttributeValues: { ":ts": lastSyncedTs },
  }));
}

// For testing only
export function clearThreadIssueMap() {
  memoryMap.clear();
  claimedCards.clear();
}
