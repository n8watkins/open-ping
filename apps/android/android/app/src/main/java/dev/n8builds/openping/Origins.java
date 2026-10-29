package dev.n8builds.openping;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/**
 * Origins: what an install is, and whether a URL belongs to one. Plain Java
 * (java.net.URI, not android.net.Uri) so the JVM unit tests cover it.
 */
public final class Origins {

    private Origins() {}

    /**
     * The https origin of {@code value} ("https://host" or "https://host:port"),
     * or null when it is not a usable install address: not https, with a user
     * name or password, or without a dotted host. Paths, queries and fragments
     * are dropped.
     */
    public static String normalize(String value) {
        if (value == null) return null;
        URI uri;
        try {
            uri = new URI(value.trim());
        } catch (URISyntaxException e) {
            return null;
        }
        if (!"https".equalsIgnoreCase(uri.getScheme())) return null;
        if (uri.getRawUserInfo() != null) return null;
        String host = uri.getHost();
        if (host == null || host.isEmpty()) return null;
        host = host.toLowerCase(Locale.ROOT);
        if (!host.contains(".") && !host.startsWith("[")) return null;
        if (host.startsWith(".") || host.endsWith(".") || host.contains("..")) return null;
        int port = uri.getPort();
        return port == -1 || port == 443 ? "https://" + host : "https://" + host + ":" + port;
    }

    /** The origin of any http(s) URL, or null (for other schemes too). */
    public static String of(String url) {
        if (url == null) return null;
        URI uri;
        try {
            uri = new URI(url);
        } catch (URISyntaxException e) {
            return null;
        }
        String scheme = uri.getScheme();
        String host = uri.getHost();
        if (scheme == null || host == null) return null;
        scheme = scheme.toLowerCase(Locale.ROOT);
        if (!scheme.equals("https") && !scheme.equals("http")) return null;
        int port = uri.getPort();
        int defaultPort = scheme.equals("https") ? 443 : 80;
        String base = scheme + "://" + host.toLowerCase(Locale.ROOT);
        return port == -1 || port == defaultPort ? base : base + ":" + port;
    }

    /** True when {@code url} is on {@code origin} (exactly: scheme, host and port). */
    public static boolean isOn(String url, String origin) {
        String own = of(url);
        return own != null && origin != null && own.equals(origin);
    }
}
