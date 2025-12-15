#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { IndexerStack } from '../lib/indexer-stack';

const app = new cdk.App();

// Get configuration from context or environment
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
};

new IndexerStack(app, 'CryptarenaIndexerStack', {
  env,
  description: 'Cryptarena Indexer Service - ECS Fargate with ElastiCache Redis',
  
  // Stack configuration - override via cdk.json context or CLI
  stackName: 'cryptarena-indexer',
});

app.synth();

