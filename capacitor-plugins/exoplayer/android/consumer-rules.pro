# Keep the Optopus ExoPlayer plugin and its public API
-keep class com.octostream.exoplayer.** { *; }

# Keep Capacitor plugin contract
-keep public class * extends com.getcapacitor.Plugin {
    public <init>();
    @com.getcapacitor.PluginMethod <methods>;
}
-keepclassmembers class * {
    @com.getcapacitor.PluginMethod *;
}

# Keep ExoPlayer/Media3 surface classes used via reflection/layouts
-keep class androidx.media3.ui.PlayerView { *; }
-keepclassmembers class androidx.media3.ui.PlayerView { *; }
