-- Add fields to track actual market prices at entry time
-- This helps identify slippage between user's submitted USD value and actual market value

-- Add entry price (actual token price at entry time) and actual USD value
ALTER TABLE player_entries 
ADD COLUMN entry_price DECIMAL(20, 6),
ADD COLUMN actual_usd_value DECIMAL(20, 6);

-- Add comment explaining the difference
COMMENT ON COLUMN player_entries.usd_value IS 'USD value submitted by user (hardcoded at transaction creation)';
COMMENT ON COLUMN player_entries.entry_price IS 'Actual token price at entry confirmation time (from CoinMarketCap)';
COMMENT ON COLUMN player_entries.actual_usd_value IS 'Actual market value at entry time (token_amount * entry_price)';

