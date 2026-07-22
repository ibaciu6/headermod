#!/usr/bin/env bash
# Publish/update this extension's package on Microsoft Edge Add-ons via the
# Publish API. Never hardcode credentials here — they're read from
# .edge-credentials.env (gitignored, chmod 600, never uploaded anywhere).
#
# Usage:
#   ./publish-edge.sh <product-id> <package.zip> [submission-notes]
#
# Example (HeaderMod):
#   ./publish-edge.sh "$EDGE_PRODUCT_ID_HEADERMOD" dist/headermod-1.0.0-edge.zip "1.0.0 release"
#
# Docs: https://learn.microsoft.com/en-us/microsoft-edge/extensions-chromium/publish/api/using-addons-api

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CREDS_FILE="$SCRIPT_DIR/.edge-credentials.env"

[ -f "$CREDS_FILE" ] || { echo "Missing $CREDS_FILE — see .edge-credentials.env.example / prior session notes" >&2; exit 1; }
# shellcheck disable=SC1090
source "$CREDS_FILE"

PRODUCT_ID="${1:?Usage: $0 <product-id> <package.zip> [notes]}"
PACKAGE="${2:?Usage: $0 <product-id> <package.zip> [notes]}"
NOTES="${3:-Automated package update}"

[ -f "$PACKAGE" ] || { echo "Package not found: $PACKAGE" >&2; exit 1; }
: "${EDGE_CLIENT_ID:?EDGE_CLIENT_ID not set in $CREDS_FILE}"
: "${EDGE_API_KEY:?EDGE_API_KEY not set in $CREDS_FILE}"
: "${EDGE_TENANT_ID:?EDGE_TENANT_ID not set in $CREDS_FILE — get it from the same Partner Center API credentials page}"

API_BASE="https://api.addons.microsoftedge.microsoft.com"
TOKEN_URL="https://login.microsoftonline.com/${EDGE_TENANT_ID}/oauth2/v2.0/token"

echo "→ Requesting access token..."
TOKEN_RESP="$(curl -sS -X POST "$TOKEN_URL" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "client_id=${EDGE_CLIENT_ID}" \
  --data-urlencode "client_secret=${EDGE_API_KEY}" \
  --data-urlencode "scope=https://api.addons.microsoftedge.microsoft.com/.default" \
  --data-urlencode "grant_type=client_credentials")"

ACCESS_TOKEN="$(python3 -c "import sys,json; print(json.load(sys.stdin).get('access_token',''))" <<<"$TOKEN_RESP")"
if [ -z "$ACCESS_TOKEN" ]; then
  echo "Failed to get access token. Response:" >&2
  echo "$TOKEN_RESP" >&2
  exit 1
fi
echo "✓ Got access token"

echo "→ Uploading package: $PACKAGE"
UPLOAD_HEADERS="$(mktemp)"
curl -sS -D "$UPLOAD_HEADERS" -o /dev/null -X POST \
  "${API_BASE}/v1/products/${PRODUCT_ID}/submissions/draft/package" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Authorization-Cache-Control: no-cache" \
  -H "Content-Type: application/zip" \
  --data-binary "@${PACKAGE}"

OPERATION_ID="$(grep -i '^location:' "$UPLOAD_HEADERS" | sed -E 's#.*/operations/([a-f0-9-]+).*#\1#i' | tr -d '\r')"
rm -f "$UPLOAD_HEADERS"

if [ -z "$OPERATION_ID" ]; then
  echo "Could not determine operation ID from upload response headers." >&2
  exit 1
fi
echo "✓ Upload accepted, operation ID: $OPERATION_ID"

echo "→ Polling package processing status..."
STATUS_URL="${API_BASE}/v1/products/${PRODUCT_ID}/submissions/draft/package/operations/${OPERATION_ID}"
for i in $(seq 1 30); do
  STATUS_RESP="$(curl -sS "$STATUS_URL" -H "Authorization: Bearer ${ACCESS_TOKEN}")"
  STATUS="$(python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" <<<"$STATUS_RESP")"
  echo "  [$i/30] status: $STATUS"
  case "$STATUS" in
    Succeeded) break ;;
    Failed) echo "Package processing failed:" >&2; echo "$STATUS_RESP" >&2; exit 1 ;;
    *) sleep 10 ;;
  esac
done
[ "$STATUS" = "Succeeded" ] || { echo "Timed out waiting for package processing." >&2; exit 1; }
echo "✓ Package processed"

echo "→ Publishing submission..."
PUBLISH_HEADERS="$(mktemp)"
curl -sS -D "$PUBLISH_HEADERS" -o /dev/null -X POST \
  "${API_BASE}/v1/products/${PRODUCT_ID}/submissions" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"notes\": \"${NOTES}\"}"

PUBLISH_OP_ID="$(grep -i '^location:' "$PUBLISH_HEADERS" | sed -E 's#.*/operations/([a-f0-9-]+).*#\1#i' | tr -d '\r')"
rm -f "$PUBLISH_HEADERS"
echo "✓ Publish submitted. Operation ID: ${PUBLISH_OP_ID:-<none returned>}"
echo "  Review progress on https://partner.microsoft.com/en-us/dashboard/microsoftedge/${PRODUCT_ID}/submissions"
