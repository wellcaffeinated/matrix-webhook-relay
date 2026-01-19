# Matrix Webhook Relay

Forwards Matrix messages to a webhook and posts responses back.

## Setup

### 1. Create a Matrix account for the bot

Register a new account (e.g., `@mybot:matrix.org`) or use an existing one.

### 2. Get an access token

```bash
curl -XPOST \
  -d '{"type":"m.login.password", "user":"mybot", "password":"YOUR_PASSWORD"}' \
  "https://matrix.org/_matrix/client/r0/login"
```

Copy the `access_token` from the response.

### 3. Store the token

```bash
mkdir -p secrets
echo "YOUR_ACCESS_TOKEN" > secrets/matrix_token.txt
chmod 600 secrets/matrix_token.txt
```

### 4. Configure

Edit `docker-compose.yml`:
- `HOMESERVER_URL`: Your Matrix homeserver (default: matrix.org)
- `WEBHOOK_URL`: Your webhook endpoint

### 5. Create network (if not exists)

```bash
docker network create matrix-relay-network
```

### 6. Run

```bash
docker compose up -d
```

### 7. Invite the bot

From your Matrix client, invite your bot's user ID to a room or start a DM.

## Webhook Format

The bot POSTs JSON to your webhook:

```json
{
  "room_id": "!abc123:matrix.org",
  "sender": "@user:matrix.org",
  "message": "Hello world",
  "event_id": "$eventid"
}
```

The bot expects a response with one of these fields (checked in order):
- `message`
- `text`
- `response`
- `body`

Or plain text response body.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HOMESERVER_URL` | No | `https://matrix.org` | Matrix homeserver URL |
| `WEBHOOK_URL` | Yes | - | Webhook URL |
| `WEBHOOK_TIMEOUT_MS` | No | `30000` | Webhook timeout in ms |
| `ACCESS_TOKEN` | No* | - | Matrix access token |
| `ACCESS_TOKEN_FILE` | No* | `/run/secrets/matrix_token` | Path to token file |

*One of `ACCESS_TOKEN` or `ACCESS_TOKEN_FILE` is required.

## Logs

```bash
docker compose logs -f matrix-webhook-relay
```
