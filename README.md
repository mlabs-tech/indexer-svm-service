# Cryptarena Indexer Service

A robust Solana indexer service for the Cryptarena protocol. Uses **transaction-based indexing** to guarantee no transactions are missed, with WebSocket for real-time updates.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Hybrid Indexer                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────┐         ┌─────────────────┐               │
│  │  Transaction    │         │   WebSocket     │               │
│  │  Poller         │    +    │   Listener      │               │
│  │  (Primary)      │         │   (Real-time)   │               │
│  └────────┬────────┘         └────────┬────────┘               │
│           │                           │                         │
│           │   Deduplication Layer     │                         │
│           └───────────┬───────────────┘                         │
│                       │                                         │
│                       ▼                                         │
│           ┌─────────────────────┐                              │
│           │  Transaction Parser  │                              │
│           │  + Account Decoder   │                              │
│           └──────────┬──────────┘                              │
│                      │                                          │
│                      ▼                                          │
│           ┌─────────────────────┐                              │
│           │     PostgreSQL      │                              │
│           └─────────────────────┘                              │
└─────────────────────────────────────────────────────────────────┘
```

## Features

- **Transaction-based indexing** - Uses `getSignaturesForAddress` to guarantee no missed transactions
- **Checkpoint recovery** - Stores last processed signature, resumes from checkpoint on restart
- **WebSocket real-time** - Faster UI updates for account changes
- **Deduplication** - Handles both sources without duplicates
- **REST API** - Query arenas, players, stats, and leaderboards
- **Backfill support** - Catch up on historical data

## Quick Start

### Prerequisites

- Node.js 18+
- PostgreSQL 15+

### Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment:**
   ```bash
   cp env.example .env
   # Edit .env with your settings
   ```

3. **Setup database:**
   ```bash
   npx prisma db push
   npm run db:seed
   ```

4. **Backfill historical data (optional):**
   ```bash
   npm run backfill
   ```

5. **Start the service:**
   ```bash
   npm run dev
   ```

### Using Docker

```bash
docker-compose up -d
```

## Indexing Strategy

### Why Transaction-Based?

| Method | Pros | Cons |
|--------|------|------|
| WebSocket | Real-time | Can miss updates on disconnect |
| Account Polling | Simple | Expensive, no ordering |
| **Transaction Polling** | **Never misses**, ordered | Slight latency (2s) |

### How It Works

1. **Startup**: Load last processed signature from database
2. **Poll**: Fetch new signatures via `getSignaturesForAddress`
3. **Filter**: Skip already-processed signatures (deduplication)
4. **Process**: Parse transactions, extract events, update database
5. **Checkpoint**: Save last processed signature
6. **Repeat**: Every 2 seconds

### Backfill

```bash
# Full backfill (all historical transactions)
npm run backfill

# Backfill from specific slot
npm run backfill -- --from-slot=123456789

# Only sync current account state (fast)
npm run backfill -- --accounts-only
```

## API Endpoints

### Health & Status
- `GET /health` - Basic health check
- `GET /health/db` - Database connectivity
- `GET /health/rpc` - Solana RPC connectivity
- `GET /health/sync` - Sync status (slot lag, last signature)
- `GET /health/indexer` - Detailed indexer statistics

### Arenas
- `GET /api/v1/arenas` - List arenas (paginated)
- `GET /api/v1/arenas/active` - Active/waiting arenas
- `GET /api/v1/arenas/:id` - Arena details
- `GET /api/v1/arenas/:id/players` - Arena players
- `GET /api/v1/arenas/:id/assets` - Arena assets with prices
- `GET /api/v1/arenas/:id/claims` - Reward claims

### Players
- `GET /api/v1/players/:wallet` - Player profile
- `GET /api/v1/players/:wallet/history` - Arena history
- `GET /api/v1/players/:wallet/stats` - Statistics
- `GET /api/v1/players/:wallet/claims` - Reward claims

### Stats
- `GET /api/v1/stats` - Global protocol stats
- `GET /api/v1/stats/daily` - Daily stats
- `GET /api/v1/stats/assets` - Asset performance
- `GET /api/v1/leaderboard` - Top players
- `GET /api/v1/leaderboard/weekly` - Weekly leaderboard

## Project Structure

```
indexer-svm-service/
├── src/
│   ├── index.ts                 # Entry point
│   ├── config/                  # Configuration
│   ├── db/                      # Prisma client
│   ├── solana/                  # Solana connection
│   ├── parsers/
│   │   ├── accounts.ts          # Account data decoder
│   │   └── instructions.ts      # Instruction decoder
│   ├── processors/
│   │   ├── index.ts             # Account processors
│   │   ├── transaction.ts       # Transaction processor
│   │   ├── arena.ts
│   │   ├── arenaAsset.ts
│   │   ├── playerEntry.ts
│   │   └── globalState.ts
│   ├── listeners/
│   │   ├── transactionPoller.ts # Primary indexer
│   │   ├── websocket.ts         # Real-time updates
│   │   └── poller.ts            # Legacy poller
│   ├── api/
│   │   ├── server.ts
│   │   └── routes/
│   ├── types/
│   └── utils/
├── prisma/
│   ├── schema.prisma
│   └── seed.ts
├── scripts/
│   └── backfill.ts
├── docker-compose.yml
└── Dockerfile
```

## Events Tracked

| Event Type | Description |
|------------|-------------|
| `arena_created` | New arena initialized |
| `player_joined` | Player entered arena |
| `start_price_set` | Start price recorded |
| `end_price_set` | End price recorded |
| `arena_finalized` | Winner determined |
| `claim_own_tokens` | Winner claimed own tokens |
| `claim_loser_tokens` | Winner claimed loser tokens |

## Monitoring

Check sync status:
```bash
curl http://localhost:3001/health/sync
```

Response:
```json
{
  "status": "ok",
  "currentSlot": 123456789,
  "lastProcessedSlot": 123456785,
  "lastSignature": "5xKmYvQ7...",
  "slotLag": 4,
  "transactionsIndexed": 1234,
  "indexingMethod": "transaction-based"
}
```

## License

MIT
