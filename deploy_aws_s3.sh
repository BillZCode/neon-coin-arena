#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID="${AWS_ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text)}"
BUCKET_NAME="${S3_BUCKET:-neon-coin-arena-${ACCOUNT_ID}-${REGION}}"
ENABLE_CLOUDFRONT="${ENABLE_CLOUDFRONT:-false}"

echo "=== 1. Ensure Amazon S3 Bucket: ${BUCKET_NAME} (${REGION}) ==="
if ! aws s3api head-bucket --bucket "$BUCKET_NAME" 2>/dev/null; then
  if [[ "$REGION" == "us-east-1" ]]; then
    aws s3api create-bucket --bucket "$BUCKET_NAME" --region "$REGION"
  else
    aws s3api create-bucket --bucket "$BUCKET_NAME" --region "$REGION" --create-bucket-configuration "LocationConstraint=${REGION}"
  fi
fi

echo "=== 2. Enable Static Website Hosting & Public Read Policy ==="
aws s3api put-public-access-block \
  --bucket "$BUCKET_NAME" \
  --public-access-block-configuration "BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false" \
  || echo "Warning: Account/Lab SCP may restrict PublicAccessBlock; continuing..."

aws s3 website "s3://${BUCKET_NAME}/" --index-document index.html --error-document index.html

aws s3api put-bucket-policy --bucket "$BUCKET_NAME" --policy "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [
    {
      \"Sid\": \"PublicReadGetObject\",
      \"Effect\": \"Allow\",
      \"Principal\": \"*\",
      \"Action\": \"s3:GetObject\",
      \"Resource\": \"arn:aws:s3:::${BUCKET_NAME}/*\"
    }
  ]
}" || echo "Warning: Public bucket policy rejected (check Block Public Access / Lab SCP)."

echo "=== 3. Upload Frontend & App Releases to S3 ==="
aws s3 sync "${SCRIPT_DIR}/frontend" "s3://${BUCKET_NAME}/" --delete --exclude "releases/*"
if [[ -d "${SCRIPT_DIR}/releases" ]]; then
  aws s3 sync "${SCRIPT_DIR}/releases" "s3://${BUCKET_NAME}/releases/"
fi

WEBSITE_HOST="${BUCKET_NAME}.s3-website-${REGION}.amazonaws.com"
WEBSITE_URL="http://${WEBSITE_HOST}"

if [[ "$ENABLE_CLOUDFRONT" == "true" ]]; then
  echo "=== 4. Provision Optional Amazon CloudFront HTTPS CDN ==="
  CF_DOMAIN=$(aws cloudfront create-distribution \
    --origin-domain-name "$WEBSITE_HOST" \
    --default-root-object index.html \
    --query 'Distribution.DomainName' --output text 2>/dev/null || echo "")
  if [[ -n "$CF_DOMAIN" ]]; then
    echo "CloudFront URL: https://${CF_DOMAIN}"
  else
    echo "Warning: CloudFront distribution creation skipped (check IAM permissions)."
  fi
fi

echo ""
echo "=== AMAZON S3 WEB DEPLOY COMPLETE ==="
echo "Public S3 URL : ${WEBSITE_URL}"
echo "Downloads URL : ${WEBSITE_URL}/downloads.html"
echo "WebSocket API : Check deploy_game.sh output (wss://<api-id>.execute-api.${REGION}.amazonaws.com/dev)"
