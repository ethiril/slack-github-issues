import bolt from "@slack/bolt";
import { Octokit } from "@octokit/rest";
import { createGitHubHelpers } from "./src/github.js";
import { registerHandlers } from "./src/handlers.js";

const { App, AwsLambdaReceiver } = bolt;

// When running on Lambda, SLACK_GITHUB_ISSUES_SECRET_ID is set and the real
// token values are never in the environment at deploy time. The Parameters &
// Secrets Lambda extension exposes them over a local HTTP endpoint so we can
// populate process.env before Bolt reads it. In Socket Mode this block is
// skipped entirely.
if (process.env.SLACK_GITHUB_ISSUES_SECRET_ID) {
  const secretId = process.env.SLACK_GITHUB_ISSUES_SECRET_ID;
  const port = process.env.PARAMETERS_SECRETS_EXTENSION_HTTP_PORT ?? 2773;
  const res = await fetch(
    `http://localhost:${port}/secretsmanager/get?secretId=${encodeURIComponent(secretId)}`,
    { headers: { "X-Aws-Parameters-Secrets-Token": process.env.AWS_SESSION_TOKEN } }
  );
  if (!res.ok) {
    throw new Error(`Parameters & Secrets extension returned HTTP ${res.status} for secret "${secretId}"`);
  }
  const { SecretString } = await res.json();
  Object.assign(process.env, JSON.parse(SecretString));
}

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
const github = createGitHubHelpers(octokit, process.env.GITHUB_OWNER);

registerHandlers(app, github);

// ── Start ─────────────────────────────────────────────────────────────────────

const requiredEnvVars = isSocketMode
  ? ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "GITHUB_TOKEN", "GITHUB_OWNER"]
  : ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET", "GITHUB_TOKEN", "GITHUB_OWNER"];

const missingEnvVars = requiredEnvVars.filter((name) => !process.env[name]);
if (missingEnvVars.length > 0) {
  console.error(`[error] Missing required environment variables: ${missingEnvVars.join(", ")}`);
  process.exit(1);
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
