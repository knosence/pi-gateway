# Pi-Gateway

Hermes-style messaging gateway for [pi-coding-agent](https://github.com/badlogic/pi-mono) — multi-platform session management, security, and background tasks.

## Installation

```bash
pi install npm:@0xkobold/pi-gateway
```

Or as part of the meta-extension:

```bash
pi install npm:@0xkobold/pi-kobold
```

## Features

- **Per-Chat Sessions** — Unique session ID per platform/channel with reset policies
- **Reset Policies** — Daily (hour-based) and idle (minutes-based) session resets
- **Session Persistence** — Sessions survive restarts via SQLite (sql.js)
- **Background Tasks** — Isolated sessions for long-running commands
- **Security** — Per-platform user allowlists and DM pairing flow
- **Rate Limiting** — Configurable per-identifier rate limiting
- **Multi-Platform Adapters** — Discord, Telegram, Slack, WhatsApp, Twitch, WebSocket

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                    Pi-Gateway                         │
├──────────────┬──────────────┬────────────────────────┤
│  Sessions    │  Security    │  Background Tasks      │
│  ──────────  │  ──────────  │  ──────────────────   │
│  • Per-chat  │  • Allowlist │  • Isolated sessions   │
│  • Reset     │  • Pairing   │  • Progress tracking   │
│  • Persist   │  • Rate limit│  • Result delivery     │
├──────────────┴──────────────┴────────────────────────┤
│              Platform Adapters                        │
│  Discord · Telegram · Slack · WhatsApp · Twitch      │
├──────────────────────────────────────────────────────┤
│              SQLite via sql.js                        │
└──────────────────────────────────────────────────────┘
```

## Commands

| Command | Description |
|---------|-------------|
| `/gateway start [port]` | Start the gateway |
| `/gateway stop` | Stop the gateway |
| `/gateway status` | Show status |
| `/gateway restart` | Restart the gateway |
| `/gateway pair <code>` | Approve a pairing code |
| `/gateway allow <platform> <userId>` | Add user to allowlist |
| `/gateway sessions` | List active sessions |
| `/gateway tasks` | List background tasks |
| `/gateway config` | Show configuration |

## Tools

| Tool | Description |
|------|-------------|
| `gateway_status` | Check gateway status |
| `gateway_sessions` | List active sessions |
| `gateway_background_tasks` | List and manage background tasks |
| `gateway_pairing` | Generate, list, or approve pairing codes |

## Programmatic API

Pi-gateway now exports a programmatic API so it can be started from outside a pi session:

```typescript
import { startGateway, stopGateway, isGatewayRunning, getStatus } from '@0xkobold/pi-gateway/api';

// Check if already running
const running = await isGatewayRunning(3847);

// Start the gateway
const status = await startGateway({ port: 3847, host: '0.0.0.0' });

// Get status
const current = getStatus();

// Stop
await stopGateway();
```

| Function | Description |
|----------|-------------|
| `startGateway(opts?)` | Start HTTP/WS server, adapters, and cron |
| `stopGateway()` | Stop all adapters, close server, kill RPC process |
| `isGatewayRunning(port?)` | Check if a gateway is already running on a port |
| `getStatus()` | Get current status (running, adapters, clients, sessions) |
| `getConfig()` | Get current gateway config |
| `isRunning()` | Check if gateway is running (sync) |
| `getAdapter(platform)` | Get a platform adapter by name |
| `getAdapters()` | Get all active adapters |
| `sendMessage(platform, channelId, content)` | Send a message through a platform adapter |
| `broadcast(event, data)` | Broadcast to all connected WebSocket clients |

### Start Options

```typescript
interface StartGatewayOptions {
  port?: number;       // Override config port
  host?: string;      // Override config host
  noAgent?: boolean;  // Don't spawn pi RPC process (when pi is already running)
}
```

## Session Reset Policies

- **idle** — Reset after N minutes of inactivity (default: 1440 = 24h)
- **daily** — Reset at a specific hour each day (default: 4:00)
- **both** — Reset on either condition

## Security

### Allowlist Mode

By default, all users are allowed (`allowAll: true`). To restrict access:

1. Set `allowAll: false` in config
2. Use pairing codes or `/gateway allow` to grant access

### Pairing Flow

1. User sends a message on a platform
2. Agent generates a pairing code via `gateway_pairing` (generate)
3. Admin approves code via `/gateway pair <code>`
4. User is added to the allowlist

## Configuration

Stored at `~/.0xkobold/gateway/config.json`:

```json
{
  "port": 3847,
  "host": "localhost",
  "tokens": [],
  "corsOrigins": ["*"],
  "enableWebSocket": true,
  "enableHttp": true,
  "security": {
    "allowAll": true,
    "requirePairing": false
  },
  "sessions": {
    "resetPolicy": "idle",
    "dailyHour": 4,
    "idleMinutes": 1440
  },
  "platforms": {
    "discord": {
      "enabled": false,
      "botToken": ""
    }
  }
}
```

## Local Storage

Data is stored in SQLite via [sql.js](https://github.com/nicolo-ribaudo/nicolo-nicolo/tree/main/nicolo) (WebAssembly) for cross-runtime compatibility (Node.js and Bun):

- `~/.0xkobold/gateway-sessions.db` — Session data
- `~/.0xkobold/gateway-security.db` — Allowlist, pairing codes, rate limits
- `~/.0xkobold/gateway-background-tasks.db` — Background task records

## Local Development

```bash
git clone https://github.com/0xKobold/pi-gateway
cd pi-gateway
npm install
npm run build
pi install ./
```

## License

MIT