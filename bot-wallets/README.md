# Bot Wallets

These are test wallets used by the bot filler service to automatically populate waiting arenas.

## Purpose

When a waiting arena has been inactive for 1 minute (no new players joining), the bot filler service will automatically:
1. Select an available bot wallet from this directory
2. Pick a random unused token
3. Enter the arena with that bot wallet

This ensures arenas don't stay empty for too long and improves the user experience.

## Security

⚠️ **These are TEST WALLETS ONLY** - They contain no real funds and are safe to commit to version control.

The wallets are funded on-demand by the funder wallet (configured via `BOT_FUNDER_PRIVATE_KEY` env var) which airdrops 0.1 SOL when a bot wallet has insufficient balance.

## Source

These wallets are copied from `cryptarena-svm/test-wallets/player*.json` for deployment convenience.

