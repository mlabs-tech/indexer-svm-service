#!/bin/sh
set -e

echo "Running database migrations..."
npx prisma@6.8.2 migrate deploy

echo "Starting indexer service..."
exec node dist/index.js

