#!/usr/bin/env bash
set -euo pipefail

# ── Configuration ─────────────────────────────────────────
# Edit these or pass as environment variables
AWS_REGION="${AWS_REGION:-us-east-1}"
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:?Set AWS_ACCOUNT_ID}"
ECR_REPO_NAME="slack-github-issues"
STACK_NAME="slack-github-issues"

ECR_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO_NAME}"

# ── Step 1: Create ECR repo (idempotent) ──────────────────
echo "→ Ensuring ECR repository exists…"
aws ecr describe-repositories --repository-names "$ECR_REPO_NAME" --region "$AWS_REGION" 2>/dev/null \
  || aws ecr create-repository --repository-name "$ECR_REPO_NAME" --region "$AWS_REGION"

# ── Step 2: Build & push ─────────────────────────────────
echo "→ Building Docker image…"
docker build -t "$ECR_REPO_NAME" .

echo "→ Logging in to ECR…"
aws ecr get-login-password --region "$AWS_REGION" | \
  docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

echo "→ Pushing image…"
docker tag "$ECR_REPO_NAME:latest" "$ECR_URI:latest"
docker push "$ECR_URI:latest"

# ── Step 3: Deploy CloudFormation ─────────────────────────
echo "→ Deploying CloudFormation stack…"
echo "  You'll be prompted for parameters (tokens, VPC, subnets)."
echo ""

aws cloudformation deploy \
  --template-file cloudformation.yml \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    ImageUri="$ECR_URI:latest" \
    SlackBotToken="${SLACK_BOT_TOKEN:?Set SLACK_BOT_TOKEN}" \
    SlackAppToken="${SLACK_APP_TOKEN:?Set SLACK_APP_TOKEN}" \
    GitHubToken="${GITHUB_TOKEN:?Set GITHUB_TOKEN}" \
    GitHubOwner="${GITHUB_OWNER:?Set GITHUB_OWNER}" \
    GitHubRepos="${GITHUB_REPOS:-}" \
    VpcId="${VPC_ID:?Set VPC_ID}" \
    SubnetIds="${SUBNET_IDS:?Set SUBNET_IDS (comma-separated)}"

echo ""
echo "✅ Deployed! Check logs with:"
echo "   aws logs tail /ecs/slack-github-issues --follow --region $AWS_REGION"
