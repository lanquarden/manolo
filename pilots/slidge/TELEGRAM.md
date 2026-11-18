# Telegram Bot API over XMPP

The opt-in pilot path is `Telegram Bot API ↔ Manolo Telegram bridge ↔ authenticated XMPP IQ ↔ Manolo relay ↔ Pi Durable worker`. It uses the existing BotFather token. Slidgram's documented registration uses Telegram user accounts and MTProto app credentials, not this bot-token flow.

The bridge owns the Telegram token. The relay still owns authorizations, exact private user/chat routes, durable offsets, deduplication, and replies. Telegram user, chat, and update IDs survive the hop unchanged. The XMPP protocol in this spike is a private pair of IQ requests, not a generic XMPP messaging standard or a drop-in adapter for Slidge-WhatsApp rooms. Voice notes and Telegram groups are out of scope for this text pilot.

## Run the offline test

From the Manolo repo, with Node 24 and Docker Compose:

```sh
npm ci
bash pilots/slidge/telegram-smoke.sh
```

This uses Prosody over TLS on a randomized loopback port and a fake Telegram Bot API. It runs the actual relay, workers and bridge, rejects an unrelated XMPP client, and exercises allowed and denied Telegram DMs, original-chat replies and relay restart recovery. It removes its own Prosody instance when done and does not contact the live Telegram bot.

## Configuration for a live trial

Use a private Prosody service with TLS verified by both XMPP clients, dedicated credentials and persistent server accounts. The included fixture Compose file and its passwords are for local testing only. Set these on the respective processes from a secret store:

| Setting | Relay | `node src/telegram-bridge.mjs` |
| --- | --- | --- |
| `MANOLO_TELEGRAM_MODE` | `xmpp` | not used |
| `MANOLO_TELEGRAM_BOT_ID` | Numeric prefix of the bot token | Same ID, checked against token |
| `MANOLO_TELEGRAM_TOKEN` | Unset | Bot Father token |
| `MANOLO_XMPP_SERVICE` | `xmpps://` URL for Prosody direct TLS | Same |
| `MANOLO_XMPP_JID` | Relay account including fixed resource | Bridge account including fixed resource |
| `MANOLO_XMPP_PEER` | Exact bridge JID | Exact relay JID |
| `MANOLO_XMPP_PASSWORD` | Relay account password | Bridge account password |

Keep the XMPP accounts on the same domain and distinct. Keep the normal exact private DM route in the relay. The relay binds its existing cursor and sessions to the same numeric bot ID, so changing only the transport can retain context. **Run only one Telegram poller**: do not run the direct adapter and an XMPP bridge against the same bot concurrently. Do not enable a webhook on that bot. No cluster resources or public listener are installed by this pilot.
