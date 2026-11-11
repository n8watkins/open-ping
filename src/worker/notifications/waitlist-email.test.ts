import { describe, expect, it } from "vitest";
import { confirmUrl, leaveUrl, renderConfirmEmail } from "./waitlist-email";

const origin = "https://openping.example";
const links = { confirm: "c0nfirm_tok-en", leave: "l3ave_tok-en" };

describe("the waitlist confirm email", () => {
  const mail = renderConfirmEmail(origin, links);

  it("links to the confirm page and carries the leave link in both parts", () => {
    expect(mail.html).toContain(`href="${confirmUrl(origin, links.confirm)}"`);
    expect(mail.html).toContain(`href="${leaveUrl(origin, links.leave)}"`);
    expect(mail.text).toContain(confirmUrl(origin, links.confirm));
    expect(mail.text).toContain(leaveUrl(origin, links.leave));
    expect(confirmUrl(origin, "a b")).toBe(`${origin}/waitlist/confirm?t=a%20b`);
  });

  it("sets the one-click unsubscribe headers (RFC 8058) to an https leave URL", () => {
    expect(mail.headers).toEqual({
      "List-Unsubscribe": `<${leaveUrl(origin, links.leave)}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });

  it("follows the reader's dark mode with the app's palette, and says when unconfirmed rows go", () => {
    expect(mail.html).toContain("prefers-color-scheme:dark");
    expect(mail.html).toContain("#0b1220");
    expect(mail.html).toContain("deleted after 7 days");
    expect(mail.text).toContain("deleted after 7 days");
  });

  it("uses no em dash", () => {
    expect(`${mail.subject}${mail.html}${mail.text}`).not.toContain("—");
  });
});
