package dev.n8builds.openping;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class OriginsTest {

    @Test
    public void normalizeKeepsOnlyAnHttpsOrigin() {
        assertEquals("https://status.example.com", Origins.normalize("https://Status.Example.com/login?x=1#y"));
        assertEquals("https://status.example.com", Origins.normalize("https://status.example.com:443"));
        assertEquals("https://status.example.com:8443", Origins.normalize("https://status.example.com:8443/"));
    }

    @Test
    public void normalizeRefusesWhatIsNotAnInstall() {
        assertNull(Origins.normalize("http://status.example.com"));
        assertNull(Origins.normalize("https://user:pw@status.example.com"));
        assertNull(Origins.normalize("https://localhost"));
        assertNull(Origins.normalize("https://example..com"));
        assertNull(Origins.normalize("javascript:alert(1)"));
        assertNull(Origins.normalize("not a url"));
        assertNull(Origins.normalize(null));
    }

    @Test
    public void isOnComparesSchemeHostAndPort() {
        assertTrue(Origins.isOn("https://status.example.com/incidents/1", "https://status.example.com"));
        assertTrue(Origins.isOn("https://STATUS.example.com:443/", "https://status.example.com"));
        assertFalse(Origins.isOn("http://status.example.com/", "https://status.example.com"));
        assertFalse(Origins.isOn("https://status.example.com.evil.test/", "https://status.example.com"));
        assertFalse(Origins.isOn("https://status.example.com:8443/", "https://status.example.com"));
        assertFalse(Origins.isOn("mailto:a@example.com", "https://status.example.com"));
    }
}
