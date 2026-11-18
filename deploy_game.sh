#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID="${AWS_ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text)}"
ROLE_NAME="${AWS_ROLE_NAME:-LabRole}"
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
TABLE_NAME="${TABLE_NAME:-websocket-game-db}"
WS_API_NAME="${WS_API_NAME:-websocket-game-api}"
HTTP_API_NAME="${HTTP_API_NAME:-neon-coin-arena-http-api}"
SQS_QUEUE_NAME="${SQS_QUEUE_NAME:-neon-coin-arena-events}"
SNS_TOPIC_NAME="${SNS_TOPIC_NAME:-neon-coin-arena-alerts}"
DATA_BUCKET="${DATA_BUCKET:-neon-coin-arena-data-${ACCOUNT_ID}-${REGION}}"
SSM_CONFIG_PARAM="${SSM_CONFIG_PARAM:-/neon-coin-arena/config}"
EVENTBRIDGE_RULE="${EVENTBRIDGE_RULE:-neon-coin-arena-maintenance}"
CW_NAMESPACE="${CW_NAMESPACE:-NeonCoinArena}"

LAMBDA_FUNCTIONS=(
  game-connect
  game-disconnect
  game-events
  game-analytics-worker
  game-rest-api
  game-cleanup
)

echo "=== 1. Verify AWS Identity ==="
aws sts get-caller-identity --region "$REGION"

echo "=== 2. Ensure Amazon DynamoDB Table + TTL: $TABLE_NAME ==="
if ! aws dynamodb describe-table --table-name "$TABLE_NAME" --region "$REGION" >/dev/null 2>&1; then
  aws dynamodb create-table \
    --table-name "$TABLE_NAME" \
    --attribute-definitions AttributeName=pk,AttributeType=S \
    --key-schema AttributeName=pk,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST \
    --region "$REGION" \
    --query 'TableDescription.{Name:TableName,Status:TableStatus}'
  aws dynamodb wait table-exists --table-name "$TABLE_NAME" --region "$REGION"
fi
aws dynamodb update-time-to-live \
  --table-name "$TABLE_NAME" \
  --time-to-live-specification "Enabled=true,AttributeName=ttl" \
  --region "$REGION" >/dev/null 2>&1 || echo "DynamoDB TTL already enabled or skipped."

echo "=== 3. Ensure AWS SSM Parameter Store Config: $SSM_CONFIG_PARAM ==="
if ! aws ssm get-parameter --name "$SSM_CONFIG_PARAM" --region "$REGION" >/dev/null 2>&1; then
  aws ssm put-parameter \
    --name "$SSM_CONFIG_PARAM" \
    --type String \
    --value '{"targetCoins":12,"scoreMultiplier":1,"motd":"Powered by AWS WebSocket, DynamoDB, SQS, SNS, S3, SSM, EventBridge & CloudWatch"}' \
    --region "$REGION" >/dev/null
fi

echo "=== 4. Ensure Amazon S3 Data & Analytics Bucket: $DATA_BUCKET ==="
if ! aws s3api head-bucket --bucket "$DATA_BUCKET" --region "$REGION" 2>/dev/null; then
  if [[ "$REGION" == "us-east-1" ]]; then
    aws s3api create-bucket --bucket "$DATA_BUCKET" --region "$REGION" >/dev/null || DATA_BUCKET=""
  else
    aws s3api create-bucket --bucket "$DATA_BUCKET" --region "$REGION" --create-bucket-configuration "LocationConstraint=${REGION}" >/dev/null || DATA_BUCKET=""
  fi
fi

echo "=== 5. Ensure Amazon SNS Topic & Amazon SQS Queue ==="
SNS_TOPIC_ARN=$(aws sns create-topic --name "$SNS_TOPIC_NAME" --region "$REGION" --query TopicArn --output text 2>/dev/null || echo "")
SQS_QUEUE_URL=$(aws sqs create-queue --queue-name "$SQS_QUEUE_NAME" --attributes VisibilityTimeout=60 --region "$REGION" --query QueueUrl --output text 2>/dev/null || echo "")
SQS_QUEUE_ARN=""
if [[ -n "$SQS_QUEUE_URL" ]]; then
  SQS_QUEUE_ARN=$(aws sqs get-queue-attributes --queue-url "$SQS_QUEUE_URL" --attribute-names QueueArn --region "$REGION" --query 'Attributes.QueueArn' --output text 2>/dev/null || echo "")
fi
echo "SNS_TOPIC_ARN=${SNS_TOPIC_ARN:-none}"
echo "SQS_QUEUE_URL=${SQS_QUEUE_URL:-none}"

echo "=== 6. Package Lambda Zips ==="
BUILD_DIR="${SCRIPT_DIR}/.build"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

python3 - "$SCRIPT_DIR" "$BUILD_DIR" "${LAMBDA_FUNCTIONS[@]}" <<'PY'
import os, sys, zipfile

root, build, fns = sys.argv[1], sys.argv[2], sys.argv[3:]
shared_dir = os.path.join(root, "backend", "shared")
shared_files = [f for f in os.listdir(shared_dir) if f.endswith(".mjs")]

for fn in fns:
    src = os.path.join(root, "backend", fn, "index.mjs")
    zp = os.path.join(build, f"{fn}.zip")
    with zipfile.ZipFile(zp, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.write(src, f"{fn}/index.mjs")
        for sf in shared_files:
            zf.write(os.path.join(shared_dir, sf), f"shared/{sf}")
    print("Packaged", zp)
PY

LAMBDA_ENV="Variables={TABLE_NAME=${TABLE_NAME},SQS_QUEUE_URL=${SQS_QUEUE_URL},SNS_TOPIC_ARN=${SNS_TOPIC_ARN},DATA_BUCKET=${DATA_BUCKET},SSM_CONFIG_PARAM=${SSM_CONFIG_PARAM},CW_NAMESPACE=${CW_NAMESPACE},AWS_NODEJS_CONNECTION_REUSE_ENABLED=1}"

echo "=== 7. Deploy Lambda Functions & CloudWatch Log Retention ==="
upsert_lambda() {
  local fn="$1"
  local zp="${BUILD_DIR}/${fn}.zip"
  local handler="${fn}/index.handler"

  aws logs create-log-group --log-group-name "/aws/lambda/${fn}" --region "$REGION" >/dev/null 2>&1 || true
  aws logs put-retention-policy --log-group-name "/aws/lambda/${fn}" --retention-in-days 14 --region "$REGION" >/dev/null 2>&1 || true

  if aws lambda get-function --function-name "$fn" --region "$REGION" >/dev/null 2>&1; then
    aws lambda update-function-code --function-name "$fn" --zip-file "fileb://${zp}" --region "$REGION" --query '{FunctionName:FunctionName,LastUpdateStatus:LastUpdateStatus}'
    aws lambda wait function-updated-v2 --function-name "$fn" --region "$REGION"
    aws lambda update-function-configuration \
      --function-name "$fn" \
      --handler "$handler" \
      --runtime nodejs22.x \
      --timeout 15 \
      --memory-size 256 \
      --environment "$LAMBDA_ENV" \
      --region "$REGION" >/dev/null
    aws lambda wait function-updated-v2 --function-name "$fn" --region "$REGION"
  else
    aws lambda create-function \
      --function-name "$fn" \
      --runtime nodejs22.x \
      --role "$ROLE_ARN" \
      --handler "$handler" \
      --timeout 15 \
      --memory-size 256 \
      --environment "$LAMBDA_ENV" \
      --zip-file "fileb://${zp}" \
      --region "$REGION" \
      --query '{FunctionName:FunctionName,Runtime:Runtime,State:State}'
    aws lambda wait function-active-v2 --function-name "$fn" --region "$REGION"
  fi
}

for fn in "${LAMBDA_FUNCTIONS[@]}"; do
  upsert_lambda "$fn"
done

echo "=== 8. Wire SQS -> Lambda Event Source Mapping ==="
if [[ -n "$SQS_QUEUE_ARN" ]]; then
  EXISTING_ESM=$(aws lambda list-event-source-mappings --function-name game-analytics-worker --event-source-arn "$SQS_QUEUE_ARN" --region "$REGION" --query 'EventSourceMappings[0].UUID' --output text 2>/dev/null || echo "None")
  if [[ -z "$EXISTING_ESM" || "$EXISTING_ESM" == "None" ]]; then
    aws lambda create-event-source-mapping \
      --function-name game-analytics-worker \
      --event-source-arn "$SQS_QUEUE_ARN" \
      --batch-size 10 \
      --maximum-batching-window-in-seconds 5 \
      --region "$REGION" >/dev/null || echo "Note: SQS trigger permission may require IAM access in Learner Lab."
  fi
fi

echo "=== 9. Configure API Gateway WebSocket API: $WS_API_NAME ==="
GAME_API_ID=$(aws apigatewayv2 get-apis --region "$REGION" --query "Items[?Name=='${WS_API_NAME}' && ProtocolType=='WEBSOCKET'].ApiId | [0]" --output text)
if [[ -z "$GAME_API_ID" || "$GAME_API_ID" == "None" ]]; then
  GAME_API_ID=$(aws apigatewayv2 create-api \
    --name "$WS_API_NAME" \
    --protocol-type WEBSOCKET \
    --route-selection-expression '$request.body.action' \
    --region "$REGION" \
    --query ApiId --output text)
fi

attach_ws_route() {
  local route="$1"
  local fn="$2"
  local existing_route
  existing_route=$(aws apigatewayv2 get-routes --api-id "$GAME_API_ID" --region "$REGION" --query "Items[?RouteKey=='${route}'].RouteId | [0]" --output text)
  if [[ -n "$existing_route" && "$existing_route" != "None" ]]; then
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
  aws apigatewayv2 create-route --api-id "$GAME_API_ID" --route-key "$route" --target "integrations/${integ_id}" --region "$REGION" >/dev/null
}

attach_ws_route '$connect' game-connect
attach_ws_route '$disconnect' game-disconnect
attach_ws_route 'join' game-events
attach_ws_route 'move' game-events
attach_ws_route 'collect' game-events
attach_ws_route 'chat' game-events
attach_ws_route 'ping' game-events
attach_ws_route '$default' game-events

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

echo "=== 10. Configure API Gateway HTTP API (REST Hall of Fame): $HTTP_API_NAME ==="
HTTP_API_ID=$(aws apigatewayv2 get-apis --region "$REGION" --query "Items[?Name=='${HTTP_API_NAME}' && ProtocolType=='HTTP'].ApiId | [0]" --output text)
if [[ -z "$HTTP_API_ID" || "$HTTP_API_ID" == "None" ]]; then
  HTTP_API_ID=$(aws apigatewayv2 create-api \
    --name "$HTTP_API_NAME" \
    --protocol-type HTTP \
    --cors-configuration 'AllowOrigins=["*"],AllowMethods=["GET","OPTIONS"],AllowHeaders=["Content-Type"]' \
    --target "arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:game-rest-api" \
    --region "$REGION" \
    --query ApiId --output text)
fi
aws lambda add-permission \
  --function-name game-rest-api \
  --statement-id "apigw-http-${HTTP_API_ID}" \
  --action "lambda:InvokeFunction" \
  --principal "apigateway.amazonaws.com" \
  --source-arn "arn:aws:execute-api:${REGION}:${ACCOUNT_ID}:${HTTP_API_ID}/*/*" \
  --region "$REGION" >/dev/null 2>&1 || true

echo "=== 11. Configure Amazon EventBridge Maintenance Rule + CloudWatch Alarm ==="
RULE_ARN=$(aws events put-rule \
  --name "$EVENTBRIDGE_RULE" \
  --schedule-expression "rate(5 minutes)" \
  --state ENABLED \
  --region "$REGION" \
  --query RuleArn --output text 2>/dev/null || echo "")
if [[ -n "$RULE_ARN" ]]; then
  aws lambda add-permission \
    --function-name game-cleanup \
    --statement-id "eventbridge-${EVENTBRIDGE_RULE}" \
    --action "lambda:InvokeFunction" \
    --principal "events.amazonaws.com" \
    --source-arn "$RULE_ARN" \
    --region "$REGION" >/dev/null 2>&1 || true
  aws events put-targets \
    --rule "$EVENTBRIDGE_RULE" \
    --targets "Id=cleanup-target,Arn=arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:game-cleanup" \
    --region "$REGION" >/dev/null || true
fi

if [[ -n "$SNS_TOPIC_ARN" ]]; then
  aws cloudwatch put-metric-alarm \
    --alarm-name "neon-coin-arena-lambda-errors" \
    --metric-name Errors \
    --namespace AWS/Lambda \
    --statistic Sum \
    --period 300 \
    --threshold 3 \
    --comparison-operator GreaterThanOrEqualToThreshold \
    --dimensions "Name=FunctionName,Value=game-events" \
    --evaluation-periods 1 \
    --alarm-actions "$SNS_TOPIC_ARN" \
    --region "$REGION" >/dev/null 2>&1 || true
fi

AWS_WS_URL="wss://${GAME_API_ID}.execute-api.${REGION}.amazonaws.com/dev"
AWS_HTTP_API_URL="https://${HTTP_API_ID}.execute-api.${REGION}.amazonaws.com"

if [[ -n "${ENV_OUT_FILE:-}" ]]; then
  cat > "$ENV_OUT_FILE" <<EOF
AWS_REGION=${REGION}
AWS_WS_URL=${AWS_WS_URL}
AWS_HTTP_API_URL=${AWS_HTTP_API_URL}
DATA_BUCKET=${DATA_BUCKET:-}
SQS_QUEUE_URL=${SQS_QUEUE_URL:-}
SNS_TOPIC_ARN=${SNS_TOPIC_ARN:-}
EOF
fi

echo ""
echo "=== FULL AWS DEPLOY COMPLETE ==="
echo "WebSocket URL : ${AWS_WS_URL}"
echo "HTTP API URL  : ${AWS_HTTP_API_URL}"
echo "Data S3 Bucket: ${DATA_BUCKET:-not-created}"
echo "SQS Queue URL : ${SQS_QUEUE_URL:-not-created}"
echo "SNS Topic ARN : ${SNS_TOPIC_ARN:-not-created}"
echo "SSM Config    : ${SSM_CONFIG_PARAM}"
echo "EventBridge   : ${EVENTBRIDGE_RULE}"
