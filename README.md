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
- `TRUSTED_USER`: Matrix user ID that controls the bot (e.g., `@you:matrix.org`)

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

## Security

### Trusted User

The bot requires `TRUSTED_USER` to be set. Only messages from this user are forwarded to the webhook. All other messages are ignored.

- **Room invites**: The bot only joins rooms when invited by the trusted user
- **Messages**: Only messages from the trusted user are processed
- **DM notifications**: When the bot joins a room, it sends a DM to the trusted user confirming the join

If `TRUSTED_USER` is not set, the bot ignores all messages for security.

### Panic Mode

Send `/panic` from the trusted user to immediately lock down the bot:

```
/panic
```

When panic mode is activated:
- All Matrix messages are ignored (from all users, including the trusted user)
- The HTTP `/send` endpoint returns 503
- The bot remains connected but unresponsive

**To exit panic mode**: Restart the bot. This is intentional—panic mode is meant for emergencies where you need to immediately stop all bot activity.
