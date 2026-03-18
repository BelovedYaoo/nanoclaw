---
name: add-wecom-app
description: Add WeCom App as a channel for NanoClaw. Uses an enterprise WeCom custom app with webhook verification, encrypted inbound messages, and direct replies.
---

# Add WeCom App Channel

This skill adds WeCom App support to NanoClaw, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/channels/wecom-app.ts` exists. If it does, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

**Do they already have a WeCom custom app configured?** If yes, collect these values now. If no, create the app in Phase 3.

Required values:
- `WECOM_APP_TOKEN`
- `WECOM_APP_ENCODING_AES_KEY`
- `WECOM_APP_CORP_ID`
- `WECOM_APP_CORP_SECRET`
- `WECOM_APP_AGENT_ID`

Optional values:
- `WECOM_APP_RECEIVE_ID`
- `WECOM_APP_WEBHOOK_PATH`
- `WECOM_APP_PORT`
- `WECOM_APP_HOST`

## Phase 2: Apply Code Changes

### Validate code changes

```bash
npm run build
```

If the build fails, read the affected files and fix the integration before moving on.

This integration adds:
- `src/wecom-app.ts` (WeCom webhook server, signature verification, AES-CBC decryption, access token + send API)
- `src/channels/wecom-app.ts` (WeCom channel adapter with self-registration)
- `import './wecom-app.js'` appended to `src/channels/index.ts`

## Phase 3: Setup

### Create WeCom custom app (if needed)

If the user does not already have a WeCom app, tell them:

> I need you to create a WeCom custom app:
>
> 1. Open the WeCom admin console
> 2. Go to **Applications** and create a new **custom application**
> 3. Record the following values:
>    - **Corp ID**
>    - **Agent ID**
>    - **Secret**
> 4. In the app's receive message settings, configure:
>    - **Token**
>    - **EncodingAESKey**
> 5. Set the callback URL to your NanoClaw webhook endpoint, for example:
>    - `https://<your-domain>/wecom-app/webhook`
> 6. Enable the app for the users or departments that should be able to message it
>
> After that, send me the Token, EncodingAESKey, Corp ID, Corp Secret, and Agent ID.

Wait for the user to provide the values.

### Configure environment

Add to `.env`:

```bash
WECOM_APP_TOKEN=your-token
WECOM_APP_ENCODING_AES_KEY=your-encoding-aes-key
WECOM_APP_CORP_ID=wwxxxxxxxxxxxxxxxx
WECOM_APP_CORP_SECRET=your-corp-secret
WECOM_APP_AGENT_ID=1000002
WECOM_APP_RECEIVE_ID=wwxxxxxxxxxxxxxxxx
WECOM_APP_WEBHOOK_PATH=/wecom-app/webhook
WECOM_APP_PORT=8788
WECOM_APP_HOST=0.0.0.0
```

Notes:
- `WECOM_APP_RECEIVE_ID` defaults to `WECOM_APP_CORP_ID` if omitted.
- `WECOM_APP_WEBHOOK_PATH` defaults to `/wecom-app/webhook`.
- `WECOM_APP_PORT` defaults to `8788`.
- `WECOM_APP_HOST` defaults to `0.0.0.0`.
- The channel auto-enables when the required credentials are present.

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

On Linux, restart with:

```bash
systemctl --user restart nanoclaw
```

## Phase 4: Registration

### Understand JID mapping

NanoClaw maps WeCom chats like this:
- Direct chat: `wecom-app:user:<userid>`
- Group chat: `wecom-app:group:<chatid>`

Important behavior:
- Different WeCom users are recognized as different senders
- Group chats and direct chats are isolated into different NanoClaw conversations
- A single WeCom app can serve multiple users without mixing their contexts

### Register a direct chat

Use `npx tsx setup/index.ts --step register` once you know the target JID.

For a main direct chat:

```bash
npx tsx setup/index.ts --step register -- --jid "wecom-app:user:<userid>" --name "WeCom <userid>" --folder "wecom_main" --trigger "@${ASSISTANT_NAME}" --channel wecom-app --no-trigger-required --is-main
```

For a trigger-only direct chat:

```bash
npx tsx setup/index.ts --step register -- --jid "wecom-app:user:<userid>" --name "WeCom <userid>" --folder "wecom_<userid>" --trigger "@${ASSISTANT_NAME}" --channel wecom-app
```

### Register a group chat

For a main group chat:

```bash
npx tsx setup/index.ts --step register -- --jid "wecom-app:group:<chatid>" --name "WeCom Group <chatid>" --folder "wecom_group_main" --trigger "@${ASSISTANT_NAME}" --channel wecom-app --no-trigger-required --is-main
```

For an additional trigger-only group chat:

```bash
npx tsx setup/index.ts --step register -- --jid "wecom-app:group:<chatid>" --name "WeCom Group <chatid>" --folder "wecom_group_<chatid>" --trigger "@${ASSISTANT_NAME}" --channel wecom-app
```

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a message to the WeCom app:
> - For a registered main chat: any message works
> - For a trigger-only chat: include the configured trigger word
>
> The bot should respond within a few seconds.

### What to verify

- Webhook verification succeeds in WeCom admin settings
- Incoming WeCom messages appear in NanoClaw
- Replies are sent back to the same direct chat or group chat
- Two different WeCom users produce different `sender` identities
- Group chats use `wecom-app:group:<chatid>` instead of user JIDs

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Callback URL verification fails

1. Check that the public callback URL reaches NanoClaw
2. Check `WECOM_APP_TOKEN` and `WECOM_APP_ENCODING_AES_KEY`
3. Check the webhook path matches `WECOM_APP_WEBHOOK_PATH`
4. Check reverse proxy forwarding if NanoClaw is behind Nginx

### Messages arrive but the bot does not respond

1. Check the chat was registered in `registered_groups`
2. Check `WECOM_APP_CORP_SECRET` and `WECOM_APP_AGENT_ID`
3. Check the app is enabled for the sender's user scope
4. Check service logs for token fetch or send API errors

### Different users are not being distinguished

NanoClaw identifies the sender from the WeCom `userid`. If multiple people message the same app, they remain distinct senders. If you are testing in a group, the conversation key is the group `chatid`, while the sender field still reflects the individual user.

### Group replies are going to the wrong place

Check the registered JID format:
- Direct chat must use `wecom-app:user:<userid>`
- Group chat must use `wecom-app:group:<chatid>`

## After Setup

The WeCom App channel supports:
- Encrypted inbound webhook handling
- Direct chat and group chat routing
- Distinct sender identity per WeCom user
- Text replies back through the WeCom send API
- Voice recognition fallback when WeCom sends recognized text
- Basic non-text placeholders for images and events
