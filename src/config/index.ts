import dotenv from 'dotenv';

dotenv.config();

export const config = {
  // Database
  databaseUrl: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/cryptarena',

  // Redis
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',

  // Solana
  solanaRpcUrl: process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
  solanaWsUrl: process.env.SOLANA_WS_URL || 'wss://api.devnet.solana.com',

  // Program
  programId: process.env.PROGRAM_ID || '2LsREShXRB5GMera37czrEKwe5xt9FUnKAjwpW183ce9',

  // Server
  port: parseInt(process.env.PORT || '3001', 10),
  host: process.env.HOST || '0.0.0.0',

  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',

  // Indexer settings
  pollInterval: parseInt(process.env.POLL_INTERVAL || '5000', 10),
  batchSize: parseInt(process.env.BATCH_SIZE || '100', 10),
};

export default config;

