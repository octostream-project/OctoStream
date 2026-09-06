package com.octostream.player;

import android.content.Intent;
import android.net.Uri;
import androidx.annotation.NonNull;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "OctoPlayer")
public class OctoPlayerPlugin extends Plugin {

    @PluginMethod
    public void playExoPlayer(@NonNull PluginCall call) {
        String url = call.getString("url");
        String title = call.getString("title", "Video");

        if (url == null || url.isEmpty()) {
            call.reject("URL is required");
            return;
        }

        try {
            Intent intent = new Intent(getActivity(), ExoPlayerActivity.class);
            intent.putExtra("url", url);
            intent.putExtra("title", title);
            getActivity().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to open ExoPlayer: " + e.getMessage());
        }
    }

    @PluginMethod
    public void playVlc(@NonNull PluginCall call) {
        String url = call.getString("url");
        String title = call.getString("title", "Video");

        if (url == null || url.isEmpty()) {
            call.reject("URL is required");
            return;
        }

        try {
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(Uri.parse(url), "video/*");
            intent.setPackage("org.videolan.vlc");
            intent.putExtra("title", title);
            getActivity().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("VLC app not installed");
        }
    }
}
