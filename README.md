# slack-github-issues

Create GitHub issues directly from Slack messages — right-click any message, fill in the details, done. The confirmation posts back **in the thread**, not at the top of the channel.

Supports labels, milestones, and GitHub Projects (v2).

## How it works

1. Right-click (or long-press) any Slack message → **Create GitHub Issue**
2. A modal opens with the message pre-filled as the issue body
3. Pick the repo — labels, milestones, and projects load dynamically
4. Hit **Create Issue** → issue is created and a link is posted back in the thread

No public URL required — runs via Slack **Socket Mode** (outbound WebSocket).

---

## Setup

### 1. Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest**
2. Pick your workspace
3. Choose **YAML** and paste the contents of `slack-manifest.yml` from this repo
4. Click **Create**

This pre-configures Socket Mode, all bot scopes, and the message shortcut automatically.

#### Grab your tokens

1. **Basic Information** → scroll to **App-Level Tokens** → **Generate Token and Scopes**
   - Name: `socket`, Scope: `connections:write` → **Generate**
   - Copy the token (starts with `xapp-`) → this is your `SLACK_APP_TOKEN`
2. **OAuth & Permissions** → **Install to Workspace** → Authorize
   - Copy the **Bot User OAuth Token** (starts with `xoxb-`) → this is your `SLACK_BOT_TOKEN`

### 2. Create a GitHub Token

#### Option A: Personal access token (personal accounts or small teams)

Go to [github.com/settings/tokens](https://github.com/settings/tokens) and create a **fine-grained personal access token** with:

- **Resource owner**: your org (or your user account)
- **Repository access**: All repositories (or select specific ones)
- **Permissions**:
  - Issues → **Read and write**
  - Metadata → **Read** (auto-selected)

> **Note**: Fine-grained tokens scoped to an org require an org admin to approve them under **Organization Settings → Personal access token policies**.

If you want **Projects** support, you also need the **classic** token with the `project` scope (fine-grained tokens don't support Projects v2 GraphQL yet as of early 2025 — check if this has changed).

#### Option B: GitHub App (recommended for organizations)

A GitHub App avoids tying the token to any individual user account, which is better for shared/production deployments.

1. Go to your org → **Settings → Developer settings → GitHub Apps → New GitHub App**
2. Fill in a name (e.g. `slack-github-issues`) and set the Homepage URL to anything (e.g. your repo URL)
3. Uncheck **Active** under Webhook (not needed)
4. Under **Repository permissions**, set:
   - Issues → **Read and write**
   - Metadata → **Read** (auto-selected)
5. Under **Organization permissions** (only if you need Projects support):
   - Projects → **Read and write**
6. Set **Where can this GitHub App be installed?** → **Only on this account**
7. Click **Create GitHub App**
8. On the app page, note the **App ID**, then scroll down and click **Generate a private key** — save the `.pem` file
9. Click **Install App** → install it on your org, choosing which repos it can access

Then generate an installation access token to use as `GITHUB_TOKEN`. The simplest approach is using the [`gh` CLI](https://cli.github.com/) or a small script with the [`@octokit/auth-app`](https://github.com/octokit/auth-app.js) package to exchange your App ID + private key for a short-lived token. Alternatively, use a tool like [generate-github-app-token](https://github.com/tibdex/github-app-token) in CI to mint tokens on demand.

### 3. Configure & Run

```bash
# Clone / copy the project
cd slack-github-issues

# Install dependencies
npm install

# Create your .env from the template
cp .env.example .env
# Edit .env with your tokens:
#   SLACK_BOT_TOKEN=xoxb-...
#   SLACK_APP_TOKEN=xapp-...
#   GITHUB_TOKEN=ghp_...
#   GITHUB_OWNER=your-org

# Run it
npm start
```

You should see:

```
⚡ slack-github-issues is running (Socket Mode)
```

### 4. Test It

1. Go to any Slack channel the bot has been invited to
2. Find a message (ideally in a thread)
3. Click the **⋮** menu (or right-click) → **Create GitHub Issue**
4. Fill in the modal → submit
5. A confirmation with a link to the issue appears in the thread

> **Note**: The bot must be in the channel to post messages. Invite it with `/invite @GitHub Issues` or by mentioning it.

---

## Running in Production

Since this uses Socket Mode, you just need a long-running process. A few lightweight options:

**systemd** (on any Linux box / EC2):
```ini
# /etc/systemd/system/slack-github-issues.service
[Unit]
Description=Slack GitHub Issues bot
After=network.target

[Service]
WorkingDirectory=/opt/slack-github-issues
ExecStart=/usr/bin/node app.js
Restart=always
EnvironmentFile=/opt/slack-github-issues/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now slack-github-issues
```

**Docker** (local or any server):
```bash
docker build -t slack-github-issues .
docker run -d --env-file .env --restart=unless-stopped slack-github-issues
```

### AWS ECS Fargate

The repo includes a CloudFormation template and deploy script. Socket Mode means **no ALB, no public IP, no inbound security group rules** — just an outbound-only Fargate task.

```bash
# Set your variables
export AWS_ACCOUNT_ID=123456789012
export AWS_REGION=us-east-1
export SLACK_BOT_TOKEN=xoxb-...
export SLACK_APP_TOKEN=xapp-...
export GITHUB_TOKEN=ghp_...
export GITHUB_OWNER=your-org
export VPC_ID=vpc-abc123
export SUBNET_IDS=subnet-aaa,subnet-bbb   # private subnets with NAT gateway

# Build, push, deploy
chmod +x deploy.sh
./deploy.sh
```

This creates an ECR repo, pushes the image, stores tokens in Secrets Manager, and spins up a 0.25 vCPU / 512 MB Fargate task. Costs roughly **~$3-4/month**.

> **Important**: The subnets must be **private subnets with a NAT gateway** so the container can reach the internet (Slack + GitHub APIs) without a public IP.

---

## Configuration

| Variable | Required | Description |
|---|---|---|
| `SLACK_BOT_TOKEN` | ✅ | Bot token (`xoxb-…`) |
| `SLACK_APP_TOKEN` | ✅ | App-level token for Socket Mode (`xapp-…`) |
| `GITHUB_TOKEN` | ✅ | Personal access token with `repo` + `project` scopes |
| `GITHUB_OWNER` | ✅ | GitHub org or username |
| `GITHUB_REPOS` | ❌ | Comma-separated repo names to show (omit to list all) |

---

## Troubleshooting

**"dispatch_failed" error when clicking the shortcut**
→ The app isn't running, or Socket Mode isn't enabled.

**Bot can't post in the channel**
→ Invite the bot to the channel: `/invite @GitHub Issues`

**No labels/milestones showing up**
→ Make sure the GitHub token has access to the repo and that the repo actually has labels/milestones configured.

**Projects dropdown is empty**
→ Projects v2 requires a classic PAT with the `project` scope. Fine-grained tokens don't support the Projects GraphQL API yet.
