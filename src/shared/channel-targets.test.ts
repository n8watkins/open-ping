import { describe, expect, it } from "vitest";
import {
  checkSlackWebhookUrl,
  checkTeamsWebhookUrl,
  checkTelegramBotToken,
  checkTelegramChatId,
  targetMessage,
} from "./channel-targets";

const id = () => crypto.randomUUID().replaceAll("-", "");

describe("checkSlackWebhookUrl", () => {
  it("accepts Slack and GovSlack incoming webhooks", () => {
    expect(checkSlackWebhookUrl(`https://hooks.slack.com/services/T0/B0/${id()}`)).toEqual({ ok: true });
    expect(checkSlackWebhookUrl(`https://hooks.slack-gov.com/services/T0/B0/${id()}`)).toEqual({ ok: true });
    expect(checkSlackWebhookUrl(`https://hooks.slack.com:443/services/T0/B0/${id()}`)).toEqual({ ok: true });
  });

  it.each([
    ["http://hooks.slack.com/services/T0/B0/x", "not_https"],
    ["https://hooks.slack.com.evil.example/services/T0/B0/x", "not_slack_host"],
    ["https://evilhooks.slack.com/services/T0/B0/x", "not_slack_host"],
    ["https://slack.com/services/T0/B0/x", "not_slack_host"],
    ["https://hooks.slack.com/triggers/T0/1/x", "not_slack_webhook"],
    ["https://hooks.slack.com/services/T0", "not_slack_webhook"],
    ["https://user:pw@hooks.slack.com/services/T0/B0/x", "embedded_credentials"],
    ["https://hooks.slack.com:8443/services/T0/B0/x", "bad_port"],
    ["hooks.slack.com/services/T0/B0/x", "invalid_url"],
  ])("rejects %s (%s)", (url, reason) => {
    expect(checkSlackWebhookUrl(url)).toEqual({ ok: false, reason });
  });
});

describe("checkTeamsWebhookUrl", () => {
  it("accepts current Power Platform and Logic Apps workflow URLs", () => {
    for (const url of [
      `https://abc123.aa.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/${id()}/triggers/manual/paths/invoke?api-version=1&sig=${id()}`,
      `https://abc123.environment.api.powerplatform.com/powerautomate/automations/direct/cu/20/workflows/${id()}/triggers/manual/paths/invoke?sig=${id()}`,
      `https://prod-12.westus.logic.azure.com:443/workflows/${id()}/triggers/manual/paths/invoke?api-version=2016-06-01&sig=${id()}`,
    ]) {
      expect(checkTeamsWebhookUrl(url)).toEqual({ ok: true });
    }
  });

  it.each([
    ["https://environment.api.powerplatform.com/workflows/x", "not_teams_host"],
    ["https://x.environment.api.powerplatform.com.evil.example/workflows/x", "not_teams_host"],
    ["https://evil.example/x.logic.azure.com/workflows/x", "not_teams_host"],
    ["https://outlook.office.com/webhook/x", "not_teams_host"],
    ["https://contoso.webhook.office.com/webhookb2/x", "not_teams_host"],
    ["https://x.logic.azure.com/triggers/manual", "not_teams_workflow"],
    ["http://x.logic.azure.com/workflows/x", "not_https"],
  ])("rejects %s (%s)", (url, reason) => {
    expect(checkTeamsWebhookUrl(url)).toEqual({ ok: false, reason });
  });
});

describe("Telegram config", () => {
  it("accepts a BotFather token and numeric or @ chat ids", () => {
    expect(checkTelegramBotToken(`123456789:${id()}`)).toEqual({ ok: true });
    for (const chat of ["42", "-1001234567890", "@openping_alerts"]) {
      expect(checkTelegramChatId(chat)).toEqual({ ok: true });
    }
  });

  it("rejects anything that could change the request path", () => {
    for (const token of ["", "123", `123:${id()}/../x`, `123:${id()}?a=1`, `abc:${id()}`, `123:${id()} `]) {
      expect(checkTelegramBotToken(token).ok).toBe(false);
    }
    for (const chat of ["", "chat", "@a", "12 34", "@bad-name"]) {
      expect(checkTelegramChatId(chat).ok).toBe(false);
    }
  });

  it("explains every failure in plain words", () => {
    expect(targetMessage(checkTelegramChatId("chat"))).toContain("-1001234567890");
    expect(targetMessage({ ok: true })).toBeNull();
  });
});
