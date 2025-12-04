import { PublicKey, AccountInfo, Context } from '@solana/web3.js';
import { getConnection } from '../solana/connection';
import config from '../config';
import logger from '../utils/logger';
import { identifyAccountType } from '../parsers/accounts';
import { processAccountUpdate } from '../processors';

const PROGRAM_ID = new PublicKey(config.programId);

let subscriptionId: number | null = null;

/**
 * Subscribe to all program account changes via WebSocket
 */
export async function startWebSocketListener(): Promise<void> {
  const connection = getConnection();

  logger.info({ programId: PROGRAM_ID.toString() }, 'Starting WebSocket listener');

  subscriptionId = connection.onProgramAccountChange(
    PROGRAM_ID,
    async (accountInfo: { accountId: PublicKey; accountInfo: AccountInfo<Buffer> }, context: Context) => {
      try {
        const { accountId, accountInfo: info } = accountInfo;
        const accountType = identifyAccountType(info.data);

        if (accountType) {
          logger.debug(
            { 
              account: accountId.toString(), 
              type: accountType, 
              slot: context.slot 
            },
            'Account update received'
          );

          await processAccountUpdate(accountId, info.data, accountType, context.slot);
        }
      } catch (error) {
        logger.error({ error }, 'Error processing account update');
      }
    },
    'confirmed'
  );

  logger.info({ subscriptionId }, 'WebSocket subscription active');
}

/**
 * Stop the WebSocket listener
 */
export async function stopWebSocketListener(): Promise<void> {
  if (subscriptionId !== null) {
    const connection = getConnection();
    await connection.removeProgramAccountChangeListener(subscriptionId);
    logger.info({ subscriptionId }, 'WebSocket subscription removed');
    subscriptionId = null;
  }
}

export default {
  startWebSocketListener,
  stopWebSocketListener,
};

