package dev.n8builds.openping;

import static dev.n8builds.openping.NavigationPolicy.Decision.BLOCK;
import static dev.n8builds.openping.NavigationPolicy.Decision.EXTERNAL;
import static dev.n8builds.openping.NavigationPolicy.Decision.IN_APP;
import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class NavigationPolicyTest {

    private static final String INSTALL = "https://status.example.com";
    private static final String ON_INSTALL = INSTALL + "/monitors";
    private static final String ON_SHELL = "https://localhost/#/picker";

    @Test
    public void theOpenInstallLoadsInTheApp() {
        assertEquals(IN_APP, NavigationPolicy.decide(INSTALL + "/incidents/7", ON_INSTALL, INSTALL));
        assertEquals(IN_APP, NavigationPolicy.decide("about:blank", ON_INSTALL, INSTALL));
    }

    @Test
    public void everyOtherSiteOpensInTheBrowser() {
        assertEquals(EXTERNAL, NavigationPolicy.decide("https://github.com/login/oauth/authorize", ON_INSTALL, INSTALL));
        assertEquals(EXTERNAL, NavigationPolicy.decide("https://other.example.com/", ON_INSTALL, INSTALL));
        assertEquals(EXTERNAL, NavigationPolicy.decide("http://status.example.com/", ON_INSTALL, INSTALL));
        assertEquals(EXTERNAL, NavigationPolicy.decide("https://status.example.com:8443/", ON_INSTALL, INSTALL));
        assertEquals(EXTERNAL, NavigationPolicy.decide("mailto:ops@example.com", ON_INSTALL, INSTALL));
        assertEquals(EXTERNAL, NavigationPolicy.decide("tel:+15550100", ON_INSTALL, INSTALL));
    }

    @Test
    public void anInstallCantOpenTheAppsOwnScreensOrSchemes() {
        assertEquals(BLOCK, NavigationPolicy.decide("https://localhost/#/picker", ON_INSTALL, INSTALL));
        assertEquals(BLOCK, NavigationPolicy.decide("dev.n8builds.openping:/signed-in?code=x", ON_INSTALL, INSTALL));
        assertEquals(BLOCK, NavigationPolicy.decide("intent://scan/#Intent;scheme=zxing;end", ON_INSTALL, INSTALL));
        assertEquals(BLOCK, NavigationPolicy.decide("file:///data/data/x", ON_INSTALL, INSTALL));
        assertEquals(BLOCK, NavigationPolicy.decide("javascript:alert(1)", ON_INSTALL, INSTALL));
        assertEquals(BLOCK, NavigationPolicy.decide("data:text/html,hi", ON_INSTALL, INSTALL));
        assertEquals(BLOCK, NavigationPolicy.decide(null, ON_INSTALL, INSTALL));
    }

    @Test
    public void theAppsScreensMoveAmongThemselves() {
        assertEquals(IN_APP, NavigationPolicy.decide("https://localhost/#/add", ON_SHELL, null));
        assertEquals(EXTERNAL, NavigationPolicy.decide("https://status.example.com/", ON_SHELL, null));
    }
}
