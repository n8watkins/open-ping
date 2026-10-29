package dev.n8builds.openping;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class PkceTest {

    @Test
    public void challengeIsTheRfc7636Example() {
        // RFC 7636, appendix B.
        assertEquals(
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
            Pkce.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        );
    }

    @Test
    public void tokensAre43Base64UrlCharactersAndDiffer() {
        String a = Pkce.randomToken();
        String b = Pkce.randomToken();
        assertTrue(a.matches("[A-Za-z0-9_-]{43}"));
        assertNotEquals(a, b);
    }
}
