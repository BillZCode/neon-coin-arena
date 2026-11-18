#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID="${AWS_ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text)}"
ROLE_NAME="${AWS_ROLE_NAME:-LabRole}"
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
TABLE_NAME="${TABLE_NAME:-websocket-game-db}"
API_NAME="${API_NAME:-websocket-game-api}"

echo "=== 1. Verify AWS Identity ==="
aws sts get-caller-identity --region "$REGION"

echo "=== 2. Ensure DynamoDB Table: $TABLE_NAME ==="
if ! aws dynamodb describe-table --table-name "$TABLE_NAME" --region "$REGION" >/dev/null 2>&1; then
  aws dynamodb create-table \
    --table-name "$TABLE_NAME" \
    --attribute-definitions AttributeName=pk,AttributeType=S \
    --key-schema AttributeName=pk,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST \
    --region "$REGION" \
    --query 'TableDescription.{Name:TableName,Status:TableStatus}'
  aws dynamodb wait table-exists --table-name "$TABLE_NAME" --region "$REGION"
else
  echo "Table $TABLE_NAME already exists."
fi

echo "=== 3. Package Lambda Zips ==="
BUILD_DIR="${SCRIPT_DIR}/.build"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

python3 - "$SCRIPT_DIR" "$BUILD_DIR" <<'PY'
import os, sys, zipfile

root, build = sys.argv[1], sys.argv[2]
shared = os.path.join(root, "backend", "shared", "ws-utils.mjs")

for fn in ["game-connect", "game-disconnect", "game-events"]:
    src = os.path.join(root, "backend", fn, "index.mjs")
    zp = os.path.join(build, f"{fn}.zip")
    with zipfile.ZipFile(zp, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.write(src, "index.mjs")
        zf.write(shared, "ws-utils.mjs")
    print("Packaged", zp)
PY

echo "=== 4. Create or Update Lambda Functions ==="
upsert_lambda() {
  local fn="$1"
  local zp="${BUILD_DIR}/${fn}.zip"
  if aws lambda get-function --function-name "$fn" --region "$REGION" >/dev/null 2>&1; then
    aws lambda update-function-code --function-name "$fn" --zip-file "fileb://${zp}" --region "$REGION" --query '{FunctionName:FunctionName,LastUpdateStatus:LastUpdateStatus}'
    aws lambda wait function-updated-v2 --function-name "$fn" --region "$REGION"
    aws lambda update-function-configuration --function-name "$fn" --runtime nodejs22.x --timeout 10 --memory-size 256 --environment "Variables={TABLE_NAME=${TABLE_NAME}}" --region "$REGION" >/dev/null
    aws lambda wait function-updated-v2 --function-name "$fn" --region "$REGION"
  else
    aws lambda create-function \
      --function-name "$fn" \
      --runtime nodejs22.x \
      --role "$ROLE_ARN" \
      --handler index.handler \
      --timeout 10 \
      --memory-size 256 \
      --environment "Variables={TABLE_NAME=${TABLE_NAME}}" \
      --zip-file "fileb://${zp}" \
      --region "$REGION" \
      --query '{FunctionName:FunctionName,Runtime:Runtime,State:State}'
    aws lambda wait function-active-v2 --function-name "$fn" --region "$REGION"
  fi
}

upsert_lambda game-connect
upsert_lambda game-disconnect
upsert_lambda game-events

echo "=== 5. Create API Gateway WebSocket API: $API_NAME ==="
GAME_API_ID=$(aws apigatewayv2 get-apis --region "$REGION" --query "Items[?Name=='${API_NAME}'].ApiId | [0]" --output text)
if [[ -z "$GAME_API_ID" || "$GAME_API_ID" == "None" ]]; then
  GAME_API_ID=$(aws apigatewayv2 create-api \
    --name "$API_NAME" \
    --protocol-type WEBSOCKET \
    --route-selection-expression '$request.body.action' \
    --region "$REGION" \
    --query ApiId --output text)
fi
echo "GAME_API_ID=$GAME_API_ID"

attach_route() {
  local route="$1"
  local fn="$2"
  local existing_route
  existing_route=$(aws apigatewayv2 get-routes --api-id "$GAME_API_ID" --region "$REGION" --query "Items[?RouteKey=='${route}'].RouteId | [0]" --output text)
  if [[ -n "$existing_route" && "$existing_route" != "None" ]]; then
    echo "Route $route already configured ($existing_route)"
    return
  fi

  local integ_id
  integ_id=$(aws apigatewayv2 create-integration \
    --api-id "$GAME_API_ID" \
    --integration-type AWS_PROXY \
    --integration-method POST \
    --integration-uri "arn:aws:apigateway:${REGION}:lambda:path/2015-03-31/functions/arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${fn}/invocations" \
    --region "$REGION" \
    --query IntegrationId --output text)

  aws apigatewayv2 create-route \
    --api-id "$GAME_API_ID" \
    --route-key "$route" \
    --target "integrations/${integ_id}" \
    --region "$REGION" \
    --query '{RouteKey:RouteKey,RouteId:RouteId}'
}

attach_route '$connect' game-connect
attach_route '$disconnect' game-disconnect
attach_route 'join' game-events
attach_route 'move' game-events
attach_route 'collect' game-events
attach_route 'chat' game-events
attach_route 'ping' game-events
attach_route '$default' game-events

for fn in game-connect game-disconnect game-events; do
  aws lambda add-permission \
    --function-name "$fn" \
    --statement-id "apigw-ws-${GAME_API_ID}-${fn}" \
    --action "lambda:InvokeFunction" \
    --principal "apigateway.amazonaws.com" \
    --source-arn "arn:aws:execute-api:${REGION}:${ACCOUNT_ID}:${GAME_API_ID}/*/*" \
    --region "$REGION" >/dev/null 2>&1 || true
done

DEP_ID=$(aws apigatewayv2 create-deployment --api-id "$GAME_API_ID" --region "$REGION" --query DeploymentId --output text)
if aws apigatewayv2 get-stage --api-id "$GAME_API_ID" --stage-name dev --region "$REGION" >/dev/null 2>&1; then
  aws apigatewayv2 update-stage --api-id "$GAME_API_ID" --stage-name dev --deployment-id "$DEP_ID" --region "$REGION" >/dev/null
else
  aws apigatewayv2 create-stage --api-id "$GAME_API_ID" --stage-name dev --deployment-id "$DEP_ID" --region "$REGION" >/dev/null
fi

GAME_WS_URL="wss://${GAME_API_ID}.execute-api.${REGION}.amazonaws.com/dev"
GAME_CONN_URL="https://${GAME_API_ID}.execute-api.${REGION}.amazonaws.com/dev"
echo "GAME_WS_URL=$GAME_WS_URL"
echo "GAME_CONN_URL=$GAME_CONN_URL"
echo "=== GAME DEPLOY DONE ==="
