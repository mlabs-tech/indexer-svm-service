#!/bin/sh
set -e

echo "================================================"
echo "Cryptarena Indexer Service - Starting..."
echo "================================================"
echo "Instance ID: $(hostname)"
echo "Node Environment: ${NODE_ENV:-development}"
echo ""

# Validate required environment variables
echo "Checking required environment variables..."

if [ -z "$DATABASE_URL" ]; then
  echo "ERROR: DATABASE_URL is not set"
  exit 1
fi

if [ -z "$REDIS_URL" ]; then
  echo "ERROR: REDIS_URL is not set"
  exit 1
fi

if [ -z "$SOLANA_RPC_URL" ]; then
  echo "ERROR: SOLANA_RPC_URL is not set"
  exit 1
fi

if [ -z "$PROGRAM_ID" ]; then
  echo "ERROR: PROGRAM_ID is not set"
  exit 1
fi

echo "✅ All required environment variables are set"
echo ""

# Run database migrations
echo "Running database migrations..."
npx prisma@6.8.2 migrate deploy

if [ $? -eq 0 ]; then
  echo "✅ Database migrations completed successfully"
else
  echo "❌ Database migrations failed"
  exit 1
fi

echo ""
echo "================================================"
echo "Starting indexer service..."
echo "================================================"
echo ""

# Start the service
# Use exec to replace shell with node process for proper signal handling
exec node dist/index.js
