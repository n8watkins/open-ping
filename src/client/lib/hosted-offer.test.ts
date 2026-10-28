import { describe, expect, it } from "vitest";
import { hostedOffer } from "./hosted-offer";

describe("hostedOffer", () => {
  it("is the waitlist while the server reports no sign-up page", () => {
    expect(hostedOffer(null)).toEqual({ open: false });
    expect(hostedOffer({})).toEqual({ open: false });
    expect(hostedOffer({ hostedSignupUrl: "" })).toEqual({ open: false });
  });

  it("stays the waitlist for a sign-up page that isn't https", () => {
    expect(hostedOffer({ hostedSignupUrl: "http://app.example.com/sign-up" })).toEqual({ open: false });
    expect(hostedOffer({ hostedSignupUrl: "javascript:alert(1)" })).toEqual({ open: false });
  });

  it("opens the trial with the sign-up, sign-in and host of the platform", () => {
    expect(hostedOffer({ hostedSignupUrl: "https://app.example.com/sign-up" })).toEqual({
      open: true,
      signupUrl: "https://app.example.com/sign-up",
      signInUrl: "https://app.example.com/sign-in",
      host: "app.example.com",
    });
  });
});
