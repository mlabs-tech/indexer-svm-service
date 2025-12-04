import { Connection, PublicKey, Commitment } from '@solana/web3.js';
import config from '../config';
import logger from '../utils/logger';

let connection: Connection | null = null;

export function getConnection(): Connection {
  if (!connection) {
    connection = new Connection(config.solanaRpcUrl, {
      commitment: 'confirmed' as Commitment,
      wsEndpoint: config.solanaWsUrl,
    });
    logger.info({ rpcUrl: config.solanaRpcUrl }, 'Solana connection initialized');
  }
  return connection;
}

export async function getSlot(): Promise<number> {
  const conn = getConnection();
  return conn.getSlot();
}

export async function getAccountInfo(pubkey: PublicKey) {
  const conn = getConnection();
  return conn.getAccountInfo(pubkey);
}

export async function getProgramAccounts(programId: PublicKey, filters?: any[]) {
  const conn = getConnection();
  return conn.getProgramAccounts(programId, { filters });
}

export default {
  getConnection,
  getSlot,
  getAccountInfo,
  getProgramAccounts,
};

