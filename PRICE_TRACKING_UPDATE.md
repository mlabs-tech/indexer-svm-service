# Price Tracking Update

## Overview
This update adds real-time price tracking to identify slippage between the USD value a user submits and the actual market value when their transaction confirms.

## Problem Statement
When a user enters $10 worth of a token:
1. Frontend fetches price (e.g., SOL = $200)
2. User sees they'll get 0.05 SOL
3. Transaction is submitted with hardcoded $10 USD value
4. **Delay:** 5-30 seconds for transaction to confirm
5. **Issue:** SOL price might now be $201, so actual value is $10.05

Previously, the indexer only stored the hardcoded $10 value, not the actual market value at confirmation.

## Solution
The indexer now:
1. Fetches the actual token price from CoinMarketCap when processing each player entry
2. Calculates the real market value (token_amount × actual_price)
3. Stores both the submitted value and actual value for comparison
4. Logs any slippage detected

## Database Changes

### New Fields in `player_entries` table:
- `entry_price` (DECIMAL(20,6)) - Actual token price at entry confirmation time
- `actual_usd_value` (DECIMAL(20,6)) - Actual market value (token_amount × entry_price)

### Field Meanings:
- `usd_value` - User's submitted value (hardcoded at transaction creation)
- `entry_price` - Real market price from CoinMarketCap at entry time
- `actual_usd_value` - Real market value at entry time

## How to Apply

### 1. Run Database Migration
```bash
cd indexer-svm-service
npx prisma migrate dev
```

This will apply the migration in `prisma/migrations/20251206_add_actual_price_tracking/`

### 2. Generate Prisma Client
```bash
npx prisma generate
```

### 3. Restart Indexer Service
```bash
npm run dev
# or
docker-compose restart indexer
```

## Frontend Changes

The frontend queue page now shows in player tooltips:
- **Locked Value** - User's submitted amount
- **Market Value** - Actual market value at entry (if different)
- **Entry Price** - The actual token price used
- **Amount** - Token quantity

This helps users see if they got a slightly better or worse deal due to price movement.

## Example Log Output

When a player enters, you'll see logs like:
```json
{
  "assetIndex": 0,
  "submittedUsd": 10.00,
  "actualUsd": 10.05,
  "slippage": 0.05,
  "slippagePercent": "0.50%",
  "entryPrice": 201.0,
  "msg": "Price slippage detected at entry"
}
```

## Notes

- The indexer pulls prices from CoinMarketCap every 30 seconds
- It finds the closest price within 2 minutes of entry time
- If no recent price is found, it uses the latest available price
- Slippage is typically small (< 1%) but can be larger for volatile tokens

## Testing

1. Enter a queue with any token
2. Wait for transaction to confirm
3. Check indexer logs for slippage detection
4. Hover over your player slot in the queue
5. Verify both "Locked Value" and "Market Value" are shown

