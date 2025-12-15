#!/bin/bash
set -e

# ============================================================================
# Cryptarena Indexer - AWS ECS Deployment Script
# ============================================================================
#
# Usage:
#   ./scripts/deploy.sh [options]
#
# Options:
#   --skip-build     Skip Docker build (use existing image)
#   --skip-push      Skip pushing to ECR
#   --skip-infra     Skip CDK infrastructure update
#   --only-infra     Only deploy infrastructure (no app)
#
# Prerequisites:
#   - AWS CLI configured with profile 'casinoslord'
#   - Docker installed and running
#   - .env.production file configured in infra/ directory
#
# ============================================================================

# Configuration
AWS_PROFILE="${AWS_PROFILE:-casinoslord}"
AWS_REGION="${AWS_REGION:-us-east-1}"
SERVICE_NAME="cryptarena-indexer"
CLUSTER_NAME="cryptarena-indexer"

# Parse arguments
SKIP_BUILD=false
SKIP_PUSH=false
SKIP_INFRA=false
ONLY_INFRA=false

for arg in "$@"; do
  case $arg in
    --skip-build)
      SKIP_BUILD=true
      shift
      ;;
    --skip-push)
      SKIP_PUSH=true
      shift
      ;;
    --skip-infra)
      SKIP_INFRA=true
      shift
      ;;
    --only-infra)
      ONLY_INFRA=true
      shift
      ;;
  esac
done

echo "=============================================="
echo "🚀 Cryptarena Indexer Deployment"
echo "=============================================="
echo "AWS Profile: $AWS_PROFILE"
echo "AWS Region: $AWS_REGION"
echo ""

# Set AWS profile
export AWS_PROFILE
export AWS_DEFAULT_REGION=$AWS_REGION

# Navigate to project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

echo "Project directory: $PROJECT_DIR"

# ============================================================================
# Check for .env.production file
# ============================================================================
if [ ! -f "infra/.env.production" ]; then
  echo ""
  echo "❌ ERROR: infra/.env.production file not found!"
  echo ""
  echo "Please create it from the example:"
  echo "  cp infra/env.production.example infra/.env.production"
  echo ""
  echo "Then edit it with your configuration values."
  exit 1
fi

echo "✅ Found infra/.env.production"

# Get AWS account ID
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo "AWS Account: $ACCOUNT_ID"

# ECR repository URI
ECR_URI="$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$SERVICE_NAME"

# ============================================================================
# Step 1: Ensure ECR Repository exists
# ============================================================================
echo ""
echo "----------------------------------------------"
echo "📦 Step 1: Ensuring ECR Repository exists"
echo "----------------------------------------------"

# Check if ECR repository exists, create if not
if aws ecr describe-repositories --repository-names $SERVICE_NAME --region $AWS_REGION > /dev/null 2>&1; then
  echo "✅ ECR repository already exists"
else
  echo "Creating ECR repository..."
  aws ecr create-repository \
    --repository-name $SERVICE_NAME \
    --region $AWS_REGION \
    --image-scanning-configuration scanOnPush=true \
    > /dev/null
  echo "✅ ECR repository created"
fi

# ============================================================================
# Step 2: Build Docker Image (if not skipped)
# ============================================================================
if [ "$SKIP_BUILD" = false ] && [ "$ONLY_INFRA" = false ]; then
  echo ""
  echo "----------------------------------------------"
  echo "🔨 Step 2: Building Docker Image"
  echo "----------------------------------------------"
  
  # Generate a unique tag based on git commit or timestamp
  if git rev-parse --git-dir > /dev/null 2>&1; then
    IMAGE_TAG=$(git rev-parse --short HEAD)
  else
    IMAGE_TAG=$(date +%Y%m%d%H%M%S)
  fi
  
  echo "Building image with tag: $IMAGE_TAG (ARM64)"
  
  # Build for ARM64 (Fargate Graviton - cheaper and faster)
  docker build --platform linux/arm64 -t $SERVICE_NAME:$IMAGE_TAG -t $SERVICE_NAME:latest .
  
  echo "✅ Docker image built"
else
  IMAGE_TAG="latest"
fi

# ============================================================================
# Step 3: Push to ECR (if not skipped)
# ============================================================================
if [ "$SKIP_PUSH" = false ] && [ "$ONLY_INFRA" = false ]; then
  echo ""
  echo "----------------------------------------------"
  echo "📤 Step 3: Pushing to ECR"
  echo "----------------------------------------------"
  
  # Login to ECR
  echo "Logging into ECR..."
  aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com
  
  # Tag and push
  echo "Tagging and pushing image..."
  docker tag $SERVICE_NAME:$IMAGE_TAG $ECR_URI:$IMAGE_TAG
  docker tag $SERVICE_NAME:latest $ECR_URI:latest
  
  docker push $ECR_URI:$IMAGE_TAG
  docker push $ECR_URI:latest
  
  echo "✅ Image pushed to ECR: $ECR_URI:$IMAGE_TAG"
fi

if [ "$ONLY_INFRA" = false ] && [ "$SKIP_INFRA" = true ]; then
  # If only pushing image without infra, force ECS to pick it up
  echo ""
  echo "----------------------------------------------"
  echo "🔄 Updating ECS Service"
  echo "----------------------------------------------"
  
  echo "Forcing new deployment..."
  aws ecs update-service \
    --cluster $CLUSTER_NAME \
    --service $SERVICE_NAME \
    --force-new-deployment \
    --region $AWS_REGION \
    > /dev/null 2>&1 || echo "Note: ECS service may not exist yet"

  echo "Waiting for deployment to stabilize..."
  aws ecs wait services-stable \
    --cluster $CLUSTER_NAME \
    --services $SERVICE_NAME \
    --region $AWS_REGION 2>/dev/null || echo "Note: Skipping wait - service may not exist yet"
  
  echo "✅ Done"
  exit 0
fi

# ============================================================================
# Step 4: Deploy CDK Infrastructure (if not skipped)
# ============================================================================
if [ "$SKIP_INFRA" = false ]; then
  echo ""
  echo "----------------------------------------------"
  echo "🏗️  Step 4: Deploying CDK Infrastructure"
  echo "----------------------------------------------"
  
  cd infra
  
  # Install dependencies if needed
  if [ ! -d "node_modules" ]; then
    echo "Installing CDK dependencies..."
    npm install
  fi
  
  # Bootstrap CDK if needed (first time only)
  echo "Checking CDK bootstrap..."
  npx cdk bootstrap aws://$ACCOUNT_ID/$AWS_REGION --profile $AWS_PROFILE 2>/dev/null || true
  
  # Deploy stack
  echo "Deploying CDK stack..."
  echo "(Environment variables will be read from .env.production)"
  npx cdk deploy --require-approval never --profile $AWS_PROFILE
  
  cd ..
  
  echo "✅ Infrastructure deployed"
fi

if [ "$ONLY_INFRA" = true ]; then
  echo ""
  echo "=============================================="
  echo "✅ Infrastructure deployment complete!"
  echo "=============================================="
  exit 0
fi

# ============================================================================
# Step 5: Wait for ECS Service to stabilize
# ============================================================================
echo ""
echo "----------------------------------------------"
echo "⏳ Step 5: Waiting for ECS Service to stabilize"
echo "----------------------------------------------"

echo "Waiting for deployment to stabilize (this may take a few minutes)..."
aws ecs wait services-stable \
  --cluster $CLUSTER_NAME \
  --services $SERVICE_NAME \
  --region $AWS_REGION

echo "✅ ECS service is stable"

# ============================================================================
# Summary
# ============================================================================
echo ""
echo "=============================================="
echo "✅ Deployment Complete!"
echo "=============================================="

# Get ALB DNS
ALB_DNS=$(aws elbv2 describe-load-balancers \
  --names $SERVICE_NAME-alb \
  --query 'LoadBalancers[0].DNSName' \
  --output text \
  --region $AWS_REGION 2>/dev/null || echo "Not found")

echo ""
echo "Service URL: http://$ALB_DNS"
echo "Health Check: http://$ALB_DNS/health"
echo ""
echo "To view logs:"
echo "  aws logs tail /ecs/$SERVICE_NAME --follow --profile $AWS_PROFILE"
echo ""
