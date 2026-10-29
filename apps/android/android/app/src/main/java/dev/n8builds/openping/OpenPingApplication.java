package dev.n8builds.openping;

import android.app.Application;

/** Starts Firebase before anything else in the process, so an alert can arrive with the app closed. */
public class OpenPingApplication extends Application {

    @Override
    public void onCreate() {
        super.onCreate();
        if (Push.init(this)) Push.ensureChannel(this);
    }
}
