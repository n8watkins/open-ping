package dev.n8builds.openping;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.Base64;

/** PKCE (RFC 7636) for the browser sign-in: a verifier, its S256 challenge, and the state. */
public final class Pkce {

    private static final SecureRandom RANDOM = new SecureRandom();

    private Pkce() {}

    /** 32 random bytes as base64url: a 43-character verifier or state. */
    public static String randomToken() {
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    /** base64url(SHA-256(verifier)), without padding. */
    public static String challenge(String verifier) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII));
            return Base64.getUrlEncoder().withoutPadding().encodeToString(digest);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is always available", e);
        }
    }
}
