package dev.n8builds.openping;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class SignInCallbackTest {

    /**
     * What Android makes of the finish page's intent URL,
     * intent:/signed-in?...#Intent;scheme=dev.n8builds.openping;package=dev.n8builds.openping;...;end
     * (Intent.parseUri puts the scheme back in front of what follows "intent:"),
     * and what the plain link is: the same URI.
     */
    private static final String CALLBACK =
        "dev.n8builds.openping:/signed-in?code=abc_DEF-123&state=st4te&origin=https%3A%2F%2Fstatus.example.com";

    @Test
    public void readsTheCallbackTheFinishPageSends() {
        SignInCallback c = SignInCallback.parse(CALLBACK);
        assertEquals("abc_DEF-123", c.code);
        assertEquals("st4te", c.state);
        assertEquals("https://status.example.com", c.origin);
        assertTrue(SignInCallback.isCallback(CALLBACK));
    }

    @Test
    public void refusesOtherShapes() {
        // "intent://signed-in" would give the scheme a host: not this callback.
        assertNull(SignInCallback.parse("dev.n8builds.openping://signed-in?code=a&state=b"));
        assertNull(SignInCallback.parse("dev.n8builds.openping:/switch?code=a&state=b"));
        assertNull(SignInCallback.parse("https://status.example.com/signed-in?code=a&state=b"));
        assertNull(SignInCallback.parse("dev.n8builds.openping:/signed-in?code=a"));
        assertNull(SignInCallback.parse("dev.n8builds.openping:/signed-in"));
        assertNull(SignInCallback.parse("not a uri"));
        assertNull(SignInCallback.parse(null));
        assertFalse(SignInCallback.isCallback("dev.n8builds.openping:/switch"));
    }

    @Test
    public void neverGuessesBetweenRepeatedParameters() {
        assertNull(SignInCallback.parse("dev.n8builds.openping:/signed-in?code=a&code=b&state=s"));
        assertNull(SignInCallback.parse("dev.n8builds.openping:/signed-in?code=a&state=s&state=t"));
        assertNull(SignInCallback.parse("dev.n8builds.openping:/signed-in?code=a&state=s&origin=x&origin=y"));
    }
}
