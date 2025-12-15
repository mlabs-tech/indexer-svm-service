# Cryptarena Indexer - AWS ECS Deployment Guide

This guide explains how to deploy the Cryptarena Indexer service to AWS ECS Fargate.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                           Internet                               │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Application Load Balancer                      │
│                     (cryptarena-indexer-alb)                     │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                        ECS Fargate                               │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                  Cryptarena Indexer                      │    │
│  │  ┌───────────────────┐  ┌──────────────────────────┐    │    │
│  │  │   API Server      │  │  Indexer + Workers       │    │    │
│  │  │   (All Tasks)     │  │  (Leader Task Only)      │    │    │
│  │  └───────────────────┘  └──────────────────────────┘    │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
┌─────────────────┐          ┌─────────────────────────┐
│  ElastiCache    │          │   External RDS          │
│  (Redis)        │          │   (PostgreSQL)          │
│  Created by CDK │          │   Your existing DB      │
└─────────────────┘          └─────────────────────────┘
```

## Leader Election

The service uses **PostgreSQL advisory locks** for leader election:

- Only one task runs the **Indexer** and **Workers** (the leader)
- All tasks run the **API Server** (stateless)
- During deployments, the new task starts as a follower, waits for the old leader to release the lock
- When the old task shuts down, the new task acquires the lock and becomes leader
- This prevents duplicate data from concurrent indexers

## Prerequisites

1. **AWS CLI** configured with the `casinoslord` profile
2. **Docker** installed and running
3. **Node.js 18+** for CDK
4. **PostgreSQL RDS** instance already created in AWS

## Quick Start

### 1. Set up AWS credentials

```bash
export AWS_PROFILE=casinoslord
```

### 2. Create the environment configuration

Copy the example file and fill in your values:

```bash
cd indexer-svm-service/infra
cp env.production.example .env.production
```

Edit `.env.production` with your actual values:

```env
# Database - Your existing AWS RDS PostgreSQL
DATABASE_URL=postgresql://username:password@your-rds-endpoint:5432/database_name

# Solana Configuration
SOLANA_RPC_URL=https://your-helius-rpc-url
SOLANA_WS_URL=wss://your-websocket-url

# Cryptarena Program ID
PROGRAM_ID=GX4gVWUtVgq6XxL8oHYy6psoN9KFdJhwnds2T3NHe5na

# Admin wallet for arena lifecycle
ADMIN_PRIVATE_KEY=your_admin_private_key_here

# Bot funder wallet
BOT_FUNDER_PRIVATE_KEY=your_bot_funder_private_key_here
```

### 3. Deploy

```bash
cd indexer-svm-service
./scripts/deploy.sh
```

### 4. After deployment - Configure RDS Security Group

The CDK will output `EcsSecurityGroupId`. Add an inbound rule to your RDS security group:
- **Type**: PostgreSQL
- **Port**: 5432
- **Source**: The ECS Security Group ID from the output

---

## Deployment Options

```bash
# Full deployment (infrastructure + Docker build + push + ECS update)
./scripts/deploy.sh

# Skip Docker build (use existing image)
./scripts/deploy.sh --skip-build

# Skip push to ECR
./scripts/deploy.sh --skip-push

# Skip infrastructure update (only build and deploy app)
./scripts/deploy.sh --skip-infra

# Only deploy infrastructure (no app)
./scripts/deploy.sh --only-infra
```

## Configuration

All configuration is done via the `infra/.env.production` file. The CDK reads this file during deployment and passes the variables to the ECS task definition.

### Required Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `SOLANA_RPC_URL` | Solana RPC endpoint |
| `SOLANA_WS_URL` | Solana WebSocket endpoint |
| `PROGRAM_ID` | Cryptarena Solana program ID |
| `ADMIN_PRIVATE_KEY` | Admin wallet for arena lifecycle |
| `BOT_FUNDER_PRIVATE_KEY` | Bot funder wallet |

### Automatically Set Variables

These are set by CDK - do NOT include in `.env.production`:

| Variable | Description |
|----------|-------------|
| `REDIS_URL` | From ElastiCache cluster |
| `PORT` | 3001 |
| `HOST` | 0.0.0.0 |
| `LOG_LEVEL` | info |
| `NODE_ENV` | production |

## Cost Optimization (Test Environment)

This deployment is configured for minimal cost:

| Resource | Configuration | ~Monthly Cost |
|----------|--------------|---------------|
| ECS Fargate | 0.5 vCPU, 1GB RAM | ~$15 |
| ALB | Single | ~$16 |
| ElastiCache | cache.t3.micro | ~$12 |
| CloudWatch Logs | 1 week retention | ~$1 |
| **Total** | | **~$44/month** |

(NAT Gateway cost avoided by using your existing VPC)

### Cost-Saving Tips

1. **Stop when not testing**:
   ```bash
   aws ecs update-service --cluster cryptarena-indexer \
     --service cryptarena-indexer --desired-count 0 --profile casinoslord
   ```

2. **Restart**:
   ```bash
   aws ecs update-service --cluster cryptarena-indexer \
     --service cryptarena-indexer --desired-count 1 --profile casinoslord
   ```

3. **Delete everything**:
   ```bash
   cd infra && cdk destroy --profile casinoslord
   ```

## Monitoring

### View Logs

```bash
# Follow logs in real-time
aws logs tail /ecs/cryptarena-indexer --follow --profile casinoslord

# Get recent logs
aws logs filter-log-events --log-group-name /ecs/cryptarena-indexer \
  --limit 100 --profile casinoslord
```

### Health Checks

```bash
# Get ALB DNS
ALB_DNS=$(aws elbv2 describe-load-balancers --names cryptarena-indexer-alb \
  --query 'LoadBalancers[0].DNSName' --output text --profile casinoslord)

# Basic health
curl http://$ALB_DNS/health

# Leader status
curl http://$ALB_DNS/health/leader

# Sync status
curl http://$ALB_DNS/health/sync

# Indexer stats
curl http://$ALB_DNS/health/indexer
```

### Exec into Container

```bash
# Get task ID
TASK_ID=$(aws ecs list-tasks --cluster cryptarena-indexer \
  --service-name cryptarena-indexer \
  --query 'taskArns[0]' --output text --profile casinoslord | cut -d'/' -f3)

# Exec into container
aws ecs execute-command --cluster cryptarena-indexer \
  --task $TASK_ID \
  --container cryptarena-indexer \
  --interactive \
  --command "/bin/sh" \
  --profile casinoslord
```

## Troubleshooting

### Task won't start

1. Check CloudWatch logs for errors
2. Verify `.env.production` has all required variables
3. Check RDS security group allows connections from ECS

### Database connection failed

1. Verify `DATABASE_URL` in `.env.production` is correct
2. Check RDS security group has inbound rule for ECS security group
3. Verify RDS is accessible from the VPC

### Redis connection failed

1. Redis is created by CDK in the same VPC
2. Check ElastiCache cluster status in AWS Console
3. Verify Redis security group allows connections from ECS

### Leader election issues

1. Check `/health/leader` endpoint
2. Verify database connectivity
3. Check logs for "Acquired leader lock" or "Could not acquire leader lock"

## Files Reference

```
indexer-svm-service/
├── infra/                        # AWS CDK infrastructure
│   ├── bin/infra.ts              # CDK app entry point
│   ├── lib/indexer-stack.ts      # Main stack definition
│   ├── .env.production           # YOUR CONFIG (create from example)
│   ├── env.production.example    # Example config file
│   ├── cdk.json                  # CDK configuration
│   └── package.json              # CDK dependencies
├── scripts/
│   └── deploy.sh                 # Main deployment script
├── src/
│   └── services/
│       └── leaderElection.ts     # Postgres advisory lock logic
├── Dockerfile                    # Container image
├── docker-entrypoint.sh          # Container startup script
└── DEPLOYMENT.md                 # This file
```
