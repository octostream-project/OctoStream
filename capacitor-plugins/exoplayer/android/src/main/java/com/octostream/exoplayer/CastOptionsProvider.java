package com.octostream.exoplayer;

import com.google.android.gms.cast.framework.OptionsProvider;
import com.google.android.gms.cast.framework.CastOptions;
import com.google.android.gms.cast.framework.SessionProvider;
import android.content.Context;
import java.util.List;

/**
 * Required by CastContext: declares the Cast options (receiver app, resume, etc).
 * Registered in AndroidManifest.xml via metadata.
 */
public class CastOptionsProvider implements OptionsProvider {
    @Override
    public CastOptions getCastOptions(Context context) {
        return new CastOptions.Builder()
                .build();
    }

    @Override
    public List<SessionProvider> getAdditionalSessionProviders(Context context) {
        return null;
    }
}
