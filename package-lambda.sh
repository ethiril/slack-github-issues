#!/usr/bin/env bash
set -euo pipefail

OUTPUT="${1:-github_butler.zip}"

echo "→ Installing production dependencies…"
npm ci --omit=dev --silent > /dev/null 2>&1

echo "→ Creating zip: $OUTPUT"
zip -qr "$OUTPUT" \
  app.js \
  src/ \
  node_modules/ \
  package.json \
  --exclude "*.test.js"

SIZE=$(du -sh "$OUTPUT" | cut -f1)
echo "→ Done — $OUTPUT ($SIZE)"
echo ""
echo "Upload via AWS CLI:"
echo "  aws lambda update-function-code \\"
echo "    --function-name <your-function-name> \\"
echo "    --zip-file fileb://$OUTPUT \\"
echo "    --region \${AWS_REGION:-us-east-1}"
echo ""
echo "Or via Terraform — set source_code_hash to force re-deploy on change:"
echo "  source_code_hash = filebase64sha256(\"$OUTPUT\")"
