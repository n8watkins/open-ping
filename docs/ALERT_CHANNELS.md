# Alert channels

OpenPing sends alerts to notification channels, which you add under **Integrations & API > Notification channels**, and to phones and browsers through Web Push.
Every channel has a **Send test** button that delivers a test alert right away and shows whether it worked.

| Channel | What you paste in | What is secret |
| --- | --- | --- |
| Slack | An incoming webhook URL | The URL |
| Microsoft Teams | A Workflows webhook URL | The URL |
| Discord | A channel webhook URL | The URL |
| Telegram | A bot token and a chat id | The bot token |
| Email | A recipient address (sent through Resend) | Nothing (needs `RESEND_API_KEY`) |
| Webhook | Any https URL, plus an optional signing secret | The URL and the secret |

Secrets are encrypted at rest under `MASTER_KEY`, are never sent back to the browser, the CLI or an MCP client, and are covered by a `MASTER_KEY` rotation (see [Security](./SECURITY.md)).
When you edit a channel, leave a secret field blank to keep the stored value.

## Which alerts each channel gets

| Event | Slack, Teams, Discord, Telegram | Email | Webhook | Web Push |
| --- | --- | --- | --- | --- |
| Down | yes | yes | yes | yes |
| Recovered | yes | yes | yes | yes |
| Missed heartbeat | yes | yes | yes | yes |
| Flapping | yes | yes | yes | yes |
| Maintenance started or ended | no | no | yes | no |
| Weekly summary | no | yes | no | no |
| Test | yes | yes | yes | yes |

A channel's own event list (`events` in the API) replaces these defaults, and a monitor can limit its alerts to chosen channels.
Repeated down, flapping and missed-heartbeat alerts for one monitor are combined into one alert per hour.

## Delivery, retries and rate limits

Alerts go through a durable outbox.
A failed delivery is retried up to 5 times, waiting 1, 2, 4 and then 8 minutes (at most an hour), and each cron run (every 12 minutes) sends what is due.
When a provider rate-limits OpenPing (HTTP 429), the next attempt waits at least as long as it asked: Slack's, Teams' and Discord's `Retry-After` header, or Telegram's `retry_after`.
The channel's row in Integrations shows the last error, for example `slack_error: no_service` or `telegram_error: Bad Request: chat not found`.

## Slack

1. Open [api.slack.com/apps](https://api.slack.com/apps), choose **Create New App**, then **From scratch**, and pick your workspace.
2. Open **Incoming Webhooks** and turn on **Activate Incoming Webhooks**.
3. Click **Add New Webhook**, choose the channel for alerts and click **Allow**.
4. Paste the webhook URL into a new Slack channel in OpenPing and click **Send test**.

OpenPing accepts only incoming-webhook URLs on Slack's own hosts: `https://hooks.slack.com/services/...` and, for GovSlack, `https://hooks.slack-gov.com/services/...`.
Workflow Builder webhooks (`/triggers/...`) take a different payload and are refused; use a generic webhook for those.

An alert is a Block Kit message in an attachment coloured red (down, missed heartbeat), amber (flapping, maintenance started) or green (recovered, maintenance ended, test).
It shows the title, the message, the HTTP status and error, the detection time in each reader's own time zone, and a **View incident** button.
Monitor names and error text are escaped, so they cannot add links or `@channel` mentions.

Sources, checked on 2026-10-28: [Sending messages using incoming webhooks](https://api.slack.com/messaging/webhooks), [Rate limits](https://api.slack.com/apis/rate-limits) (about one message a second per webhook, 429 with `Retry-After`), [Formatting text](https://api.slack.com/reference/surfaces/formatting#escaping).

## Microsoft Teams

Microsoft retired Office 365 connectors, so Teams alerts use a **Workflows** (Power Automate) webhook instead.
Old connector URLs on `webhook.office.com` are refused.

1. In Teams, open the channel, click **...** next to its name and choose **Workflows**.
2. Pick the template **Send webhook alerts to a channel** (or **Post to a channel when a webhook request is received**).
3. Name it, confirm the team and channel, and click **Add workflow**.
4. Copy the URL it shows, paste it into a new Microsoft Teams channel in OpenPing and click **Send test**.

OpenPing accepts an https URL on the standard port whose host ends in one of these, and whose path names a workflow (`/workflows/`):

- `.environment.api.powerplatform.com`, the current Power Automate trigger host, for example `https://<environment>.aa.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/<id>/triggers/manual/paths/invoke?...&sig=...`.
  Since 2 June 2026 the path can also carry a scale-unit segment (`/direct/cu/20/workflows/...`); both forms work.
- `.logic.azure.com`, for workflows that run in Azure Logic Apps (`https://prod-NN.<region>.logic.azure.com:443/workflows/<id>/triggers/manual/paths/invoke?...`).
  Power Automate flows stopped answering on `logic.azure.com` on 30 November 2025, so a Teams URL from before then must be replaced with the new one shown in the flow.

The `sig` query parameter is the credential, which is why the whole URL is stored encrypted.
Government clouds (GCC High, DoD) use other hosts and are not accepted yet.

An alert is an Adaptive Card (version 1.4) with a red, amber or green header, the message, the HTTP status, error and detection time, and a **View incident** button.
All text goes into plain text runs, which Teams never reads as Markdown.

Sources, checked on 2026-10-28: [Troubleshoot Power Automate triggers: changes to HTTP or Teams Webhook trigger flows](https://learn.microsoft.com/en-us/troubleshoot/power-platform/power-automate/flow-run-issues/triggers-troubleshoot#changes-to-http-or-teams-webhook-trigger-flows) (page dated 2026-08-07), [Microsoft Teams connector: Microsoft Teams webhook](https://learn.microsoft.com/en-us/connectors/teams/#microsoft-teams-webhook) (message envelope, Adaptive Card attachment, throttling limits).

## Telegram

1. In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot` and follow the prompts.
   It replies with the bot token, which looks like `123456789:AA...`.
2. Add the bot to your group, or as an administrator to your channel.
   For a private chat, open the bot and press **Start**.
3. Send a message there, then open `https://api.telegram.org/bot<token>/getUpdates` in your browser.
   The chat id is the number in `"chat":{"id": ...}`.
   Groups are negative and channels start with `-100`; a public channel can use its `@name` instead.
4. Paste the token and chat id into a new Telegram channel in OpenPing and click **Send test**.

The bot token is a full credential for the bot: it is encrypted at rest, never shown again, and never written into an error.
It must look exactly like a BotFather token, so it cannot change where the request goes.
OpenPing only ever calls `https://api.telegram.org/bot<token>/sendMessage`.

An alert is an HTML message (`parse_mode: HTML`) with a bold title, the message, the HTTP status, error and detection time, and a **View incident** link, with link previews off.
`<`, `>`, `&` and `"` in monitor names and errors are escaped, so they cannot add tags or links.
If a group was upgraded to a supergroup, the error shows the new chat id to use.

Sources, checked on 2026-10-28: [Bot API: sendMessage](https://core.telegram.org/bots/api#sendmessage), [HTML style](https://core.telegram.org/bots/api#html-style), [Bots FAQ: hitting limits](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this).

## Discord

Create a webhook in the Discord channel's **Integrations** settings and paste its URL.
Alerts are embeds coloured like the other chat channels.

## Webhook

Any https URL that does not point at a private, loopback or link-local address.
With a signing secret, each request carries `X-OpenPing-Timestamp` and `X-OpenPing-Signature: sha256=<HMAC-SHA256 of "<timestamp>.<body>">`.
The body is the notification payload as JSON.

## Backups

The JSON export (`/api/data/export`) does not include notification channels of any type, so it never contains a webhook URL, signing secret or bot token.
After restoring into a new install, add the channels again and re-select them on monitors that were limited to chosen channels.
A full D1 export does contain them, encrypted; see [Backup and restore](./BACKUP.md).
