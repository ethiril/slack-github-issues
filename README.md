# github-butler

Create GitHub issues directly from Slack — right-click any message, fill in the details, and the confirmation posts back in the thread.

No public URL required. Runs over a persistent outbound WebSocket (Socket Mode).

---

## Features

- **Message shortcut** — right-click any Slack message to open the issue creation modal
- **Slash command** — `/issue`, `/issue <title>`, `/issue <repo>#<num>`
- **@mention** — mention the bot in a thread to get a prompt with Create Issue and Quick Create buttons; end with `^` (e.g. `@github-butler ^` or `@github-butler summarise that ^`) to instantly create an issue from the previous message
- **Emoji reaction** — react with `:github_butler:` or `:<repo>_github_butler:` to create an issue from the reacted message; re-reacting updates the linked issue with new thread messages
- **Labels, milestones, and GitHub Projects v2** — load dynamically per repo; custom project fields (single-select, number, text) are supported
- **Issue templates** — `.github/ISSUE_TEMPLATE/` templates pre-fill the title, body, and labels
- **Per-user defaults** — last-used repo, project, milestone, and labels are remembered for the next interaction
- **Add to existing issue** — right-click a message → **Add to GitHub Issue** to append a comment

---

## Quick Start

```bash
git clone https://github.com/your-org/slack-github-issues
cd slack-github-issues
npm install
# set the required environment variables (see Setup below), then:
npm start
```

You should see:

```
slack-github-issues is running (Socket Mode)
```

---

## Setup

### 1. Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest**
2. Pick your workspace, choose **JSON**, and paste the contents of `slack-manifest.json`
3. Click **Create** — this pre-configures Socket Mode, all bot scopes, and the message shortcut

**Get your tokens:**

| Token | Where to find it |
|---|---|
| `SLACK_APP_TOKEN` (`xapp-…`) | Basic Information → App-Level Tokens → Generate → scope: `connections:write` |
| `SLACK_BOT_TOKEN` (`xoxb-…`) | OAuth & Permissions → Install to Workspace → Bot User OAuth Token |

### 2. Create a GitHub Token

**Option A: Classic PAT** (required for milestones + Projects v2)

Go to [github.com/settings/tokens](https://github.com/settings/tokens) → **Generate new token (classic)** → select scopes:
- `repo` — full repo access (includes issues and milestones)
- `project` — required for Projects v2

> Fine-grained tokens do not support the Projects v2 GraphQL API. If the Projects dropdown is empty, switch to a classic token.

**Option B: Fine-grained token** (issues only, no Projects)

- Resource owner: your org or user account
- Repository access: all or selected repos
- Permissions: Issues → Read and write, Metadata → Read

**Option C: GitHub App** (recommended for organizations)

Avoids tying the token to a personal account. Create the app under your org's Developer Settings, grant Issues (read/write) and optionally Projects (read/write), install it, then generate an installation access token to use as `GITHUB_TOKEN`.

### 3. Configure

Set the following environment variables (see the full [Configuration reference](#configuration) below):

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
GITHUB_TOKEN=ghp_...
GITHUB_OWNER=your-org
```

### 4. Test It

1. Invite the bot to a channel: `/invite @GitHub Issues`
2. Right-click any message → **Create GitHub Issue**
3. Fill in the modal and submit — a link to the issue appears in the thread

---

## Usage

### Message shortcut

Right-click (or long-press on mobile) any Slack message → **Create GitHub Issue**.

The message text pre-fills the issue body. Pick a repo and the labels, milestones, and projects load dynamically.

### Slash command

```
/issue                        open the modal (no pre-fill)
/issue Fix the login bug      open the modal with the title pre-filled
/issue 123                    look up issue #123 in your last-used repo
/issue frontend#42            look up issue #42 in the "frontend" repo
```

> Slash commands only work at the channel level — Slack does not support them inside threads. Use @mention instead.

### @mention (threads)

```
@GitHub Butler
@GitHub Butler Fix the login bug
```

The bot posts an ephemeral prompt with two buttons:
- **Create Issue** — opens the full modal
- **Quick Create** — skips the modal, uses your saved defaults, and posts the card immediately

### Emoji reaction

React to any message with:
- `:github_butler:` — uses your default repo
- `:<repo>_github_butler:` — uses the named repo (e.g. `:frontend_github_butler:`)

An inline card appears with dropdowns for type, priority, status, labels, and milestone. Hit **Create Issue** to confirm or **Customize** to open the full modal.

**Thread sync:** if the thread already has a linked issue from a previous creation, reacting again appends only the new messages as a comment instead of creating a duplicate.

### Add to existing issue

Right-click any message → **Add to GitHub Issue**. Pick the repo and issue number, optionally include the full thread, and a comment is added.

---

## Configuration

| Variable | Required | Description |
|---|---|---|
| `SLACK_BOT_TOKEN` | required | Bot token (`xoxb-…`) |
| `SLACK_APP_TOKEN` | Socket Mode only | App-level token (`xapp-…`). Its presence enables Socket Mode. |
| `SLACK_SIGNING_SECRET` | HTTP/Lambda only | Request signing secret. Required when `SLACK_APP_TOKEN` is absent. |
| `GITHUB_TOKEN` | required | Classic PAT with `repo` + `project` scopes, or a GitHub App installation token |
| `GITHUB_OWNER` | required | GitHub org or username |
| `GITHUB_REPOS` | optional | Comma-separated repo names to show in the dropdown (omit to list all) |
| `DEFAULT_GITHUB_PROJECT` | optional | Project name to pre-select for all users (must match the project title exactly) |
| `REPO_DEFAULT_LABELS` | optional | JSON map of repo → label names to pre-select on the issue card. E.g. `{"my-repo":["bug","triage"]}`. Overrides per-user saved defaults. |
| `DYNAMODB_TABLE` | optional | DynamoDB table name for persistent thread→issue mapping. Without it, mappings are in-memory only (lost on restart). Table must have a String PK named `threadTs` with no sort key. Recommended for Lambda deployments. |
| `GITHUB_BUTLER_SECRET_ID` | Lambda + Secrets Manager | AWS Secrets Manager secret ID containing all other env vars as a JSON object. When set, the app fetches secrets at cold-start via the [Parameters & Secrets Lambda extension](https://docs.aws.amazon.com/secretsmanager/latest/userguide/retrieving-secrets_lambda.html) instead of reading them from environment variables. |

---

## Deployment

The app detects its mode from environment variables:

| Env | Mode |
|---|---|
| `SLACK_APP_TOKEN` present | Socket Mode — persistent outbound WebSocket, no inbound URL needed |
| `SLACK_APP_TOKEN` absent | HTTP mode — Lambda-compatible, requires `SLACK_SIGNING_SECRET` and a public HTTPS endpoint |

### Socket Mode (long-running process)

**systemd** (Linux / EC2):

```ini
# /etc/systemd/system/slack-github-issues.service
[Unit]
Description=Slack GitHub Issues bot
After=network.target

[Service]
WorkingDirectory=/opt/slack-github-issues
ExecStart=/usr/bin/node app.js
Restart=always
Environment=SLACK_BOT_TOKEN=xoxb-...
Environment=SLACK_APP_TOKEN=xapp-...
Environment=GITHUB_TOKEN=ghp_...
Environment=GITHUB_OWNER=your-org

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now slack-github-issues
```

**Docker:**

```bash
docker build -t slack-github-issues .
docker run -d \
  -e SLACK_BOT_TOKEN=xoxb-... \
  -e SLACK_APP_TOKEN=xapp-... \
  -e GITHUB_TOKEN=ghp_... \
  -e GITHUB_OWNER=your-org \
  --restart=unless-stopped slack-github-issues
```

**AWS ECS Fargate** (no ALB, no public IP, no inbound rules — outbound-only):

```bash
export AWS_ACCOUNT_ID=123456789012
export AWS_REGION=us-east-1
export SLACK_BOT_TOKEN=xoxb-...
export SLACK_APP_TOKEN=xapp-...
export GITHUB_TOKEN=ghp_...
export GITHUB_OWNER=your-org
export VPC_ID=vpc-abc123
export SUBNET_IDS=subnet-aaa,subnet-bbb   # private subnets with a NAT gateway

chmod +x deploy.sh
./deploy.sh
```

Costs roughly ~$3-4/month (0.25 vCPU / 512 MB task). The subnets must be private subnets with a NAT gateway so the container can reach Slack and GitHub APIs.

### AWS Lambda (HTTP mode)

No persistent process — effectively free at this usage level (~$0.25/month for a typical Slack bot, vs ~$15-20/month for Fargate).

#### 1. Package the zip

```bash
chmod +x package-lambda.sh
./package-lambda.sh            # produces github_butler.zip
# or specify a custom output path:
./package-lambda.sh dist/github_butler.zip
```

This installs production-only dependencies and zips `app.js`, `src/`, and `node_modules/`.

#### 2. Create the Lambda function

- **Runtime:** Node.js 22.x (or 20.x)
- **Handler:** `app.handler`
- **Architecture:** x86_64 or arm64
- **Memory:** 256 MB is sufficient; timeout 29 s (Slack's ack window)

#### 3. Upload the zip

**AWS CLI (one-off or CI):**

```bash
aws lambda update-function-code \
  --function-name <your-function-name> \
  --zip-file fileb://github_butler.zip \
  --region us-east-1
```

**Terraform:**

```hcl
resource "aws_lambda_function" "github_butler" {
  function_name    = "github-butler"
  filename         = "github_butler.zip"
  source_code_hash = filebase64sha256("github_butler.zip")
  handler          = "app.handler"
  runtime          = "nodejs22.x"
  role             = aws_iam_role.lambda_exec.arn

  environment {
    variables = {
      GITHUB_BUTLER_SECRET_ID = aws_secretsmanager_secret.bot.name
    }
  }
}
```

> `source_code_hash` tells Terraform to re-deploy whenever the zip changes.

#### 4. Enable a Function URL

In the Lambda console → **Configuration → Function URL → Create** — set auth type to `NONE` (Slack verifies requests via the signing secret).

#### 5. Set environment variables

**Option A — plain env vars** (simplest):

```
SLACK_BOT_TOKEN       = xoxb-…
SLACK_SIGNING_SECRET  = …
GITHUB_TOKEN          = ghp_…
GITHUB_OWNER          = your-org
```

Do **not** set `SLACK_APP_TOKEN` — its absence is what enables HTTP mode.

**Option B — AWS Secrets Manager** (recommended for Terraform):

Store all secrets in a single Secrets Manager secret as a JSON object:

```json
{
  "SLACK_BOT_TOKEN": "xoxb-…",
  "SLACK_SIGNING_SECRET": "…",
  "GITHUB_TOKEN": "ghp_…",
  "GITHUB_OWNER": "your-org"
}
```

Then set only one env var on the function:

```
GITHUB_BUTLER_SECRET_ID = <secret-name-or-arn>
```

The app fetches and injects secrets at cold-start via the [Parameters & Secrets Lambda extension](https://docs.aws.amazon.com/secretsmanager/latest/userguide/retrieving-secrets_lambda.html). Add the extension as a Lambda layer and grant `secretsmanager:GetSecretValue` to the function's execution role.

#### 6. (Optional) DynamoDB for thread→issue mapping

Without a DynamoDB table, mappings are in-memory and lost on each cold start. For persistent mappings:

1. Create a DynamoDB table with a String partition key named `threadTs` (no sort key)
2. Set `DYNAMODB_TABLE=<table-name>` on the function
3. Grant the execution role `dynamodb:GetItem`, `dynamodb:PutItem`, and `dynamodb:UpdateItem` on the table

#### 7. Wire up Slack

In your Slack app settings → **Interactivity & Shortcuts → Request URL** → paste the Function URL.

#### Testing Lambda mode locally

Use `local-lambda.js` to run the HTTP handler locally without deploying to AWS:

```bash
# In one terminal — start the local HTTP adapter (no SLACK_APP_TOKEN)
npm run dev:lambda

# In another terminal — expose it to the internet
ngrok http 3000
```

Then set your Slack app's **Request URL** to `https://<ngrok-id>.ngrok.io/slack/events` and test as normal. Set `SLACK_SIGNING_SECRET` in your environment (not `SLACK_APP_TOKEN` — its absence is what activates HTTP mode).

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "dispatch_failed" when clicking the shortcut | The app isn't running, or Socket Mode isn't enabled in the Slack app settings |
| Bot can't post in the channel | Invite it: `/invite @GitHub Issues` |
| No labels or milestones showing | The GitHub token may lack repo access, or the repo has none configured |
| Projects dropdown is empty | Fine-grained tokens don't support the Projects v2 GraphQL API — switch to a classic PAT with the `project` scope |
| Emoji reaction does nothing | Make sure the bot has been added to the channel |
