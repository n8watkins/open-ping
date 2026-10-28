/**
 * The platform's only script, served at /static/passkeys.js: the browser
 * half of passkey sign-in and of adding a passkey on the account page. It
 * turns the server's JSON options into what navigator.credentials wants and
 * the credential back into base64url JSON (the same shapes OpenPing's
 * src/client/lib/webauthn.ts sends). Without it, or without passkey support,
 * the buttons stay hidden and email and GitHub still work.
 */

export const PASSKEY_SCRIPT_PATH = "/static/passkeys.js";

export const PASSKEY_SCRIPT = `"use strict";
(function () {
  function toBytes(value) {
    var b64 = value.replace(/-/g, "+").replace(/_/g, "/");
    var bin = atob(b64 + "===".slice((b64.length + 3) % 4));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function toB64(buffer) {
    var bytes = new Uint8Array(buffer), bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  }
  function post(url, body) {
    return fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {})
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.message || "Something went wrong. Please try again.");
        return data;
      });
    });
  }
  function show(el, message) {
    if (!el) return;
    el.textContent = message;
    el.hidden = !message;
  }
  function busy(button, on) {
    button.disabled = on;
    button.setAttribute("aria-busy", on ? "true" : "false");
  }
  var supported = !!(window.PublicKeyCredential && navigator.credentials && window.fetch);

  document.querySelectorAll("[data-passkey]").forEach(function (button) {
    var error = document.getElementById(button.getAttribute("data-error") || "");
    if (!supported) return;
    var wrap = document.getElementById(button.getAttribute("data-reveal") || "");
    if (wrap) wrap.hidden = false;
    button.hidden = false;
    button.addEventListener("click", function () {
      show(error, "");
      busy(button, true);
      var mode = button.getAttribute("data-passkey");
      var next = button.getAttribute("data-next") || "";
      var flow = mode === "add"
        ? post("/account/passkeys/options").then(function (o) {
            o.challenge = toBytes(o.challenge);
            o.user.id = toBytes(o.user.id);
            o.excludeCredentials = (o.excludeCredentials || []).map(function (c) { return { type: c.type, id: toBytes(c.id) }; });
            return navigator.credentials.create({ publicKey: o });
          }).then(function (cred) {
            return post("/account/passkeys", {
              credential: {
                id: cred.id, rawId: toB64(cred.rawId), type: cred.type,
                response: {
                  clientDataJSON: toB64(cred.response.clientDataJSON),
                  attestationObject: toB64(cred.response.attestationObject),
                  transports: cred.response.getTransports ? cred.response.getTransports() : []
                }
              }
            });
          })
        : post("/sign-in/passkey/options", { next: next }).then(function (o) {
            o.challenge = toBytes(o.challenge);
            return navigator.credentials.get({ publicKey: o });
          }).then(function (cred) {
            return post("/sign-in/passkey", {
              credential: {
                id: cred.id, rawId: toB64(cred.rawId), type: cred.type,
                response: {
                  clientDataJSON: toB64(cred.response.clientDataJSON),
                  authenticatorData: toB64(cred.response.authenticatorData),
                  signature: toB64(cred.response.signature),
                  userHandle: cred.response.userHandle ? toB64(cred.response.userHandle) : null
                }
              }
            });
          });
      flow.then(function (result) {
        window.location.assign(result.redirect || "/account");
      }).catch(function (e) {
        busy(button, false);
        var cancelled = e && (e.name === "NotAllowedError" || e.name === "AbortError");
        show(error, cancelled ? "" : (e && e.message) || "That didn't work. Please try again.");
      });
    });
  });
})();
`;
