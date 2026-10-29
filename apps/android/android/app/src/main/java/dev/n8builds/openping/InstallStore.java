package dev.n8builds.openping;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** The installs this app knows, and the one it opens on launch. Kept in private app storage. */
public final class InstallStore {

    public static final class Install {

        public final String origin;
        public final boolean hosted;
        public final long addedAt;
        public final long lastOpenedAt;

        Install(String origin, boolean hosted, long addedAt, long lastOpenedAt) {
            this.origin = origin;
            this.hosted = hosted;
            this.addedAt = addedAt;
            this.lastOpenedAt = lastOpenedAt;
        }

        JSONObject toJson() throws JSONException {
            return new JSONObject()
                .put("origin", origin)
                .put("hosted", hosted)
                .put("addedAt", addedAt)
                .put("lastOpenedAt", lastOpenedAt);
        }
    }

    private static final String PREFS = "openping_installs";
    private static final String KEY_INSTALLS = "installs";
    private static final String KEY_ACTIVE = "active";

    private final SharedPreferences prefs;

    public InstallStore(Context context) {
        prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public synchronized List<Install> list() {
        List<Install> installs = new ArrayList<>();
        try {
            JSONArray array = new JSONArray(prefs.getString(KEY_INSTALLS, "[]"));
            for (int i = 0; i < array.length(); i++) {
                JSONObject item = array.getJSONObject(i);
                String origin = Origins.normalize(item.optString("origin"));
                if (origin == null) continue;
                installs.add(new Install(origin, item.optBoolean("hosted"), item.optLong("addedAt"), item.optLong("lastOpenedAt")));
            }
        } catch (JSONException e) {
            // Unreadable: start over rather than crash on launch.
        }
        return installs;
    }

    public synchronized Install get(String origin) {
        for (Install install : list()) if (install.origin.equals(origin)) return install;
        return null;
    }

    /** Add an install (or keep the one there is). Returns false for an address that isn't an install. */
    public synchronized boolean add(String origin, boolean hosted) {
        String normalized = Origins.normalize(origin);
        if (normalized == null || !normalized.equals(origin)) return false;
        if (get(origin) != null) return true;
        List<Install> installs = list();
        long now = System.currentTimeMillis();
        installs.add(new Install(origin, hosted, now, now));
        save(installs);
        return true;
    }

    public synchronized void remove(String origin) {
        List<Install> kept = new ArrayList<>();
        for (Install install : list()) if (!install.origin.equals(origin)) kept.add(install);
        save(kept);
        if (origin.equals(active())) prefs.edit().remove(KEY_ACTIVE).apply();
    }

    /** Make `origin` the install the app opens on launch, and note when it was opened. */
    public synchronized void markOpened(String origin) {
        List<Install> updated = new ArrayList<>();
        long now = System.currentTimeMillis();
        for (Install install : list()) {
            updated.add(install.origin.equals(origin) ? new Install(install.origin, install.hosted, install.addedAt, now) : install);
        }
        save(updated);
        prefs.edit().putString(KEY_ACTIVE, origin).apply();
    }

    /** The install opened last, if it is still on the list. */
    public synchronized String active() {
        String origin = prefs.getString(KEY_ACTIVE, null);
        return origin != null && get(origin) != null ? origin : null;
    }

    public synchronized JSONArray toJson() {
        JSONArray array = new JSONArray();
        try {
            for (Install install : list()) array.put(install.toJson());
        } catch (JSONException e) {
            // Every value is a plain string, boolean or number.
        }
        return array;
    }

    private void save(List<Install> installs) {
        JSONArray array = new JSONArray();
        try {
            for (Install install : installs) array.put(install.toJson());
        } catch (JSONException e) {
            return;
        }
        prefs.edit().putString(KEY_INSTALLS, array.toString()).apply();
    }
}
