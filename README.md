# Matrix Webhook Relay

Forwards Matrix messages to a webhook and posts responses back.

## Setup

### 1. Create a Matrix account for the bot

Register a new account (e.g., `@mybot:matrix.org`) or use an existing one.

### 2. Get an access token by running "login"

```bash
docker compose run --rm ghcr.io/wellcaffeinated/matrix-webhook-relay:latest login
```

Copy the `access_token` from the response.

### 3. Store the token

```bash
mkdir -p secrets
echo "YOUR_ACCESS_TOKEN" > secrets/access_token
chmod 600 secrets/access_token
```

### 4. Configure

```bash
cp docker-compose.example.yaml docker-compose.yml
```

Edit `docker-compose.yml`:
- `HOMESERVER_URL`: Your Matrix homeserver (default: matrix.org)
- `WEBHOOK_URL`: Your webhook endpoint
- `ALLOWED_ROOMS`: List of rooms your bot should accept invitations for

### 5. Run

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
