package com.octostream.exoplayer;

import com.octostream.exoplayer.R;

import android.app.Dialog;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.media.AudioManager;
import android.media.audiofx.LoudnessEnhancer;
import android.net.Uri;
import android.os.Handler;
import android.text.TextUtils;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.GestureDetector;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.animation.Animation;
import android.view.animation.AnimationUtils;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.SeekBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackParameters;
import androidx.media3.common.Player;
import androidx.media3.common.TrackSelectionOverride;
import androidx.media3.common.TrackSelectionParameters;
import androidx.media3.common.Tracks;
import androidx.media3.common.Format;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.datasource.HttpDataSource;
import androidx.media3.datasource.cronet.CronetDataSource;
import androidx.media3.datasource.okhttp.OkHttpDataSource;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.dash.DashMediaSource;
import androidx.media3.exoplayer.drm.DefaultDrmSessionManager;
import androidx.media3.exoplayer.drm.DrmSessionManager;
import androidx.media3.exoplayer.drm.FrameworkMediaDrm;
import androidx.media3.exoplayer.drm.HttpMediaDrmCallback;
import androidx.media3.exoplayer.hls.HlsMediaSource;
import androidx.media3.exoplayer.source.MediaSource;
import androidx.media3.exoplayer.source.MergingMediaSource;
import androidx.media3.exoplayer.source.ProgressiveMediaSource;
import androidx.media3.exoplayer.source.SingleSampleMediaSource;
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector;
import androidx.media3.ui.AspectRatioFrameLayout;
import androidx.media3.ui.PlayerView;

import org.chromium.net.CronetEngine;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import com.google.android.gms.cast.framework.CastButtonFactory;
import com.google.android.gms.cast.framework.CastContext;
import com.google.android.gms.cast.framework.CastSession;
import com.google.android.gms.cast.framework.SessionManager;
import com.google.android.gms.cast.framework.SessionManagerListener;
import com.google.android.gms.cast.framework.media.RemoteMediaClient;
import com.google.android.gms.cast.MediaMetadata;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.CookieManager;
import java.net.CookiePolicy;
import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import okhttp3.Call;
import okhttp3.Dns;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okio.BufferedSink;

@androidx.annotation.OptIn(markerClass = androidx.media3.common.util.UnstableApi.class)
@CapacitorPlugin(name = "ExoPlayer", permissions = {
        // Descubrimiento WiFi Direct (Miracast): NEARBY_WIFI_DEVICES solo
        // existe en API 33+; en versiones anteriores hace falta ubicación.
        @Permission(alias = "wfdScan33", strings = {
                android.Manifest.permission.NEARBY_WIFI_DEVICES }),
        @Permission(alias = "wfdScanLegacy", strings = {
                android.Manifest.permission.ACCESS_FINE_LOCATION,
                android.Manifest.permission.ACCESS_COARSE_LOCATION })
})
public class ExoPlayerPlugin extends Plugin {

    private static final String TAG = "ExoPlayerPlugin";
    private static final int ACCENT_COLOR = 0xFF7B5BF5; // morado estilo Stremio
    private ExoPlayer player = null;
    private PlayerView playerView = null;
    private Dialog dialog = null;

    // Mini-player PiP: un segundo ExoPlayer ligero en una vista flotante
    // (decorView cuando el player está cerrado, rootLayout cuando está
    // abierto). Regla de audio: el mini siempre suena; el principal queda
    // muteado mientras haya PiP activo.
    private ExoPlayer pipPlayer = null;
    private FrameLayout pipLayout = null;
    private PlayerView pipView = null;
    private String pipUrl = null;
    private String pipType = "hls";
    private String pipTitle = "";
    private Map<String, String> pipHeaders = new HashMap<>();
    private boolean pipDirect = false;
    private float mainVolBeforePip = 1f;
    // Stream principal actual (para swap/minimizar a PiP).
    private Map<String, String> currentHeaders = new HashMap<>();
    private String currentStreamType = "hls";
    private boolean currentDirect = false;
    // True for a short window after closePlayer() so the dialog's
    // dispatchKeyEvent can swallow the leaked ACTION_UP/ACTION_DOWN of the
    // same Back press that closed the dialog. Without this, the leaked key
    // reaches the Capacitor BridgeActivity and fires backButton, which races
    // with the native 'closed' event and can reopen the channel.
    private boolean suppressBackUntilOpen = false;
    // Salir del player exige dos pulsaciones de Back seguidas (evita salidas
    // accidentales con el mando). La primera muestra un aviso; la segunda,
    // dentro de la ventana, cierra.
    private long backExitPressedAt = 0;
    private long lastBackHandledAt = 0;
    private static final long BACK_EXIT_WINDOW_MS = 3000;
    // dispatchKeyEvent y onBackPressed disparan ambos para una misma pulsación
    // (predictive back en Android 13+): sin este debounce la 2ª invocación
    // cumpliría la condición de doble-Back y cerraría en una sola pulsación.
    private static final long BACK_DEBOUNCE_MS = 400;
    private LoudnessEnhancer loudnessEnhancer = null;
    private ImageButton boostButton = null;
    private SeekBar boostSeek = null;
    private LinearLayout volumePopup = null;
    private LinearLayout boostPopup = null;
    private TextView boostValueTv = null;
    // Percentage (100% = no boost, up to 300%), mapped continuously to the
    // vertical amplifier slider instead of a fixed 3-option menu.
    private int boostPercent = 100;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private WebView resolverWebView = null;
    private Dialog embedDialog = null;
    private String embedReferer = null;
    private String embedCookies = null;
    private View embedOverlay = null;
    // Cursor virtual para mando a distancia (D-pad): Android TV no tiene ratón
    // y el WebView del embed necesita clicks reales (captcha en iframe
    // cross-origin no responde a element.click() por JS).
    private View embedCursor = null;
    private float embedCursorX = 0f, embedCursorY = 0f;

    // Headless WebView resolver ("FlareSolverr ligero"): carga el embed en un
    // WebView invisible enganchado al decorView, deja correr el challenge JS de
    // Cloudflare/captcha y devuelve la URL de vídeo interceptada a JS.
    private WebView headlessWebView = null;
    private boolean headlessBusy = false;
    private Runnable headlessTimeout = null;
    private Dialog overlayDialog = null;
    private Runnable positionUpdateRunnable = null;
    private long pendingSeekMs = 0;
    // Next episode popup (Netflix-style): shown 30s before end with countdown
    private View nextEpPopupView = null;
    private Runnable nextEpCountdownRunnable = null;
    private int nextEpCountdown = 0;
    private boolean nextEpShown = false;
    // When true, closePlayer() will NOT emit a "closed" event. Used by
    // openPlayer() so the JS side doesn't unmount the VideoPlayer when
    // switching episodes (closePlayer + openPlayer = seamless transition).
    private boolean suppressClosedEvent = false;
    private String nextEpTitle = "";
    private String nextEpSeriesName = "";
    private int nextEpSeason = 0;
    private int nextEpEpisode = 0;
    private String nextEpPosterUrl = "";
    private boolean nextEpAutoPlay = true;
    // Check de buffering programado en mainHandler: ExoPlayer exige el hilo
    // main (applicationLooper) — antes corría en un ScheduledExecutorService
    // donde getPlaybackState()/closePlayer() lanzaban IllegalStateException
    // y el executor tragaba la excepción sin log (los stalls nunca disparaban
    // ni error ni reintento).
    private Runnable bufferingCheckRunnable = null;
    // Reintento automático ante stalls de buffering (directos que se quedan
    // cargando de noche por congestión del ISP / playlist HLS colgada).
    // Se re-asigna el MediaSource (fuerza recarga de la playlist) antes de
    // rendirse con error. lastMediaSource se guarda en cada setMediaSource.
    private int bufferingRetries = 0;
    private int behindLiveRetries = 0;
    private int sourceErrorRetries = 0;
    // true si lastMediaSource está enrutado por el proxy WARP local — permite
    // al retry de IO error distinguir "el proxy está caído" de un fallo normal
    // de red y reconstruir en directo en vez de repetir el mismo factory roto.
    private boolean lastSourceUsedWarp = false;
    private MediaSource lastMediaSource = null;

    // Cliente OkHttp compartido para peticiones puntuales (búsqueda de
    // subtítulos, etc.). Cada `new OkHttpClient()` crea su propio dispatcher
    // (pool de hilos) y connection pool — reutilizar evita fugas de hilos.
    private OkHttpClient sharedHttpClient = null;
    private synchronized OkHttpClient sharedOkHttpClient() {
        if (sharedHttpClient == null) sharedHttpClient = new OkHttpClient();
        return sharedHttpClient;
    }

    // --- Live TV zapping state ---
    private JSONArray liveChannels = null;   // channel names for display
    private int channelIndex = -1;
    private String currentChannelName = "";   // título/nombre del canal en reproducción
    private String currentUrl = "";
    private String epgNow = null;
    private String epgNext = null;
    // Explicit playback mode: live, vod, or youtube.
    private String playerMode = "vod";
    private long epgNowStart = 0;  // epoch s — barra de progreso del programa
    private long epgNowEnd = 0;
    // Debounce del evento channelZap: al zapping rápido, el overlay se
    // actualiza al instante pero el evento a JS (que dispara switchChannel)
    // se retrasa ~400ms tras la última tecla. Así solo hay UN switchChannel
    // por ráfaga, evitando audio colgado y desincronización canal/player.
    private Runnable zapDebounceRunnable = null;
    private int pendingZapIndex = -1;
    private LinearLayout channelListPanel = null;
    private LinearLayout channelListContainer = null;

    // --- Lista de episodios de la temporada (series VOD) ---
    private JSONArray episodeList = null;      // [{name, season, episode, watched}]
    private int episodeIndex = -1;
    // Torrents/P2P: la fuente local puede tardar mucho en producir bytes
    // (espera de piezas). longBuffering amplía timeout y reintentos.
    private boolean longBuffering = false;
    // fastStart (YouTube/CDN adaptativo rápido): reduce el buffer exigido
    // para el primer frame y tras rebuffer.
    private boolean fastStart = false;
    private String streamLoadingText = "Cargando enlace…";
    private LinearLayout episodeListPanel = null;
    private LinearLayout episodeListContainer = null;
    private ImageButton octoEpisodesBtn = null;

    // Aceleración del seek con D-pad: pulsaciones repetidas en la misma
    // dirección aumentan el salto (10s → 15s → 30s → 60s → 90s → 120s).
    private long lastSeekAtMs = 0;
    private int seekStreak = 0;
    private int lastSeekDir = 0;

    // Scrub pendiente en la barra de progreso: ←/→ con el foco en el seek
    // mueven un destino visible (posición + delta) sin saltar el vídeo; se
    // confirma con OK, al perder el foco o tras ~1,2s sin pulsar.
    private boolean scrubActive = false;
    private long scrubBaseMs = 0;
    private long scrubTargetMs = 0;
    private int scrubStreak = 0;
    private int scrubDir = 0;
    private long scrubLastAtMs = 0;
    private long quickSeekAccumMs = 0; // delta acumulado de seeks instantáneos
    private TextView octoSeekDelta = null;
    private final Runnable commitScrubRunnable = this::commitScrub;
    private final Runnable clearSeekDeltaRunnable = () -> {
        if (octoSeekDelta != null) octoSeekDelta.setText("");
    };

    // --- Controles propios (sin PlayerControlView de Media3) ---
    private LinearLayout controlsOverlay = null;
    private SeekBar octoSeek = null;
    private TextView octoPosition = null;
    private TextView octoDuration = null;
    private TextView octoLiveBadge = null;
    private ImageButton octoPlayBtn = null;
    private ImageButton octoStopBtn = null;
    private ImageButton octoChannelsBtn = null;
    private LinearLayout octoInfoRow = null;
    private android.widget.ImageView octoLogo = null;

    private TextView octoNowTv = null;
    private TextView octoNextTv = null;
    private android.widget.ProgressBar octoProg = null;
    private TextView octoEpgStartTv = null;
    private TextView octoEpgEndTv = null;
    private ImageButton octoCastBtn = null;
    private ImageButton octoPipBtn = null;
    private CastContext castContext = null;
    private SessionManagerListener<CastSession> castSessionListener = null;
    private String currentLogoUrl = null;
    private String channelLogoFallback = null;
    // Desfase de subtítulos en microsegundos (misma semántica que el
    // subDelay del reproductor web): positivo = aparecen después (retraso),
    // negativo = aparecen antes (adelanto). Se aplica en
    // OffsetSubtitleDecoder/OffsetSubtitleBuffer, no en el renderer.
    // volatile: se lee desde el hilo de render y se escribe en el UI thread.
    private volatile long subtitleOffsetUs = 0;
    // IMDB/temporada/episodio del contenido actual: permite buscar subtítulos
    // online en el addon de Stremio (opensubtitles-v3, sin API key) desde el
    // menú CC nativo.
    private String mediaImdbId = "";
    private int mediaSeason = 0;
    private int mediaEpisode = 0;
    // Subtítulo externo (side-loaded) aplicado al MediaItem actual.
    private String externalSubUrl = null;
    private String externalSubLang = "es";
    private boolean pendingSelectExternalSub = false;
    // Subtítulos del proveedor (p.ej. YouTube TTML/VTT): se cargan
    // side-loaded vía MergingMediaSource junto al source principal.
    private List<MediaItem.SubtitleConfiguration> providerSubConfigs = null;
    // Contexto guardado para reconstruir el MediaSource al aplicar/quitar
    // un subtítulo externo sin cerrar el player.
    private DataSource.Factory lastDataSourceFactory = null;
    private String lastStreamType = "hls";
    private DrmSessionManager lastDrmSessionManager = null;
    private String lastLicenseUrl = null;
    // Factory que envuelve los decoders de subtítulos por defecto para
    // aplicar subtitleOffsetUs a los tiempos de los cues. Al desplazar en el
    // decoder sirve en ambas direcciones y para todos los MediaSource
    // (HLS, DASH, MP4 y pistas side-loaded).
    private final androidx.media3.exoplayer.text.SubtitleDecoderFactory subtitleOffsetDecoderFactory =
            new androidx.media3.exoplayer.text.SubtitleDecoderFactory() {
                @Override
                public boolean supportsFormat(Format format) {
                    return androidx.media3.exoplayer.text.SubtitleDecoderFactory.DEFAULT
                            .supportsFormat(format);
                }

                @Override
                public androidx.media3.extractor.text.SubtitleDecoder createDecoder(Format format) {
                    return new OffsetSubtitleDecoder(
                            androidx.media3.exoplayer.text.SubtitleDecoderFactory.DEFAULT
                                    .createDecoder(format));
                }
            };
    private static final java.util.Map<String, android.graphics.Bitmap> logoCache =
            java.util.Collections.synchronizedMap(new java.util.LinkedHashMap<String, android.graphics.Bitmap>(32, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(java.util.Map.Entry<String, android.graphics.Bitmap> eldest) {
                    return size() > 32;
                }
            });
    private boolean controlsSeeking = false;
    private final Runnable hideControlsRunnable = new Runnable() {
        @Override public void run() {
            if (controlsSeeking) {
                mainHandler.postDelayed(this, 4000);
                return;
            }
            hideControls();
        }
    };
    private final Runnable controlsTickRunnable = new Runnable() {
        @Override public void run() {
            updateControlsUi();
            if (isControlsVisible()) mainHandler.postDelayed(this, 500);
        }
    };

    // --- Volume / speed controls ---
    private SeekBar volumeSeek = null;
    private TextView speedLabel = null;
    private float currentSpeed = 1f;

    // --- Top bar estilo Stremio (atrás + título + info) ---
    private LinearLayout topBar = null;
    private TextView playerTitleView = null;
    private TextView playerSubtitleView = null;
    private TextView clockView = null;
    private final java.text.SimpleDateFormat clockFormat =
            new java.text.SimpleDateFormat("HH:mm", java.util.Locale.getDefault());

    // Apply focus scale animation to a view (grows when D-pad focuses it)
    private void applyFocusScale(View view) {
        if (view == null) return;
        view.setOnFocusChangeListener((v, hasFocus) -> {
            // Sin animación de escala — fillAfter=true con scale 1.4 causaba
            // que los iconos se desplazaran visualmente. Solo cambio de color.
            boolean isPlay = v.getId() == R.id.octo_play;
            if (!isPlay && v instanceof ImageButton) {
                ((ImageButton) v).setColorFilter(hasFocus ? ACCENT_COLOR : Color.WHITE);
            } else if (!isPlay && v instanceof TextView) {
                ((TextView) v).setTextColor(hasFocus ? ACCENT_COLOR : Color.WHITE);
            }
            // Escala suave sin fillAfter (no afecta el layout)
            if (hasFocus) {
                v.animate().scaleX(1.2f).scaleY(1.2f).setDuration(100).start();
            } else {
                v.animate().scaleX(1f).scaleY(1f).setDuration(100).start();
            }
        });
    }

    // Los sliders de volumen/amplificador se abren con OK (click) sobre el
    // icono, no al enfocar. No se usa applyFocusScaleWithSeek.

    // Apply focus scale to all focusable children of a view group.
    // Excluye los SeekBars de volumen/amplificador (tienen su propio foco).
    private void applyFocusScaleToAll(ViewGroup group) {
        if (group == null) return;
        for (int i = 0; i < group.getChildCount(); i++) {
            View child = group.getChildAt(i);
            int id = child.getId();
            if (id == R.id.octo_volume_seek || id == R.id.octo_boost_seek) continue;
            if (child.isFocusable()) {
                applyFocusScale(child);
            }
            if (child instanceof ViewGroup) {
                applyFocusScaleToAll((ViewGroup) child);
            }
        }
    }

    /**
     * Show an embed page in a visible WebView.
     * The user can interact with the page (solve captchas, click play).
     * When a direct video URL (.mp4/.m3u8) is detected, the WebView closes
     * and playback switches to ExoPlayer automatically.
     * Notifies JS via 'playbackState' events:
     *   { state: 'embed_resolved', url, streamType } - video URL found, switching to ExoPlayer
     *   { state: 'embed_closed' } - user closed the WebView
     */
    @PluginMethod
    public void playEmbed(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("url is required");
            return;
        }
        Uri parsedEmbed = Uri.parse(url);
        String embedScheme = parsedEmbed.getScheme();
        if (embedScheme == null || !(embedScheme.equalsIgnoreCase("http") || embedScheme.equalsIgnoreCase("https"))) {
            call.reject("invalid url scheme: only http/https are allowed");
            return;
        }
        String embedTitle = call.getString("title", "");
        String embedRefererArg = call.getString("referer");
        final boolean playbackMode = call.getBoolean("playback", false);
        Long wu = call.getLong("waitUntil", 0L);
        final long waitUntilMs = wu != null ? wu : 0L;

        // Try native HTTP resolution first for Voe, Vidmoly, Doodstream and Waaw
        // (AniWorld extractors: direct HTTP bypasses the embed player page)
        if (!playbackMode && (isVoeUrl(url) || isWaawUrl(url) || isVidmolyUrl(url) || isDoodstreamUrl(url))) {
            new Thread(() -> {
                try {
                    String directUrl = isVoeUrl(url) ? resolveVoeNative(url)
                            : isVidmolyUrl(url) ? resolveVidmolyNative(url)
                            : isDoodstreamUrl(url) ? resolveDoodstreamNative(url)
                            : resolveWaawNative(url);
                    if (directUrl != null && !directUrl.isEmpty() && isVideoUrl(directUrl)) {
                        Log.d(TAG, "Native resolve success: " + hostOf(directUrl));
                        String st = getStreamType(directUrl);
                        // Close any existing embed dialog and start playback —
                        // same contract as checkVideoUrl: resolve the call AND
                        // open ExoPlayer, otherwise JS would just sit on a
                        // black screen.
                        JSObject notify = new JSObject();
                        notify.put("state", "embed_resolved");
                        notify.put("url", directUrl);
                        notify.put("streamType", st);
                        notifyListeners("playbackState", notify);
                        JSObject result = new JSObject();
                        result.put("status", "resolved");
                        result.put("url", directUrl);
                        result.put("streamType", st);
                        call.resolve(result);
                        mainHandler.post(() -> {
                            try { if (embedDialog != null) embedDialog.dismiss(); } catch (Exception ignored) {}
                            embedDialog = null;
                            cleanupResolver();
                            JSObject headers = new JSObject();
                            headers.put("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
                            if (embedRefererArg != null && embedRefererArg.startsWith("http")) {
                                String origin = embedRefererArg;
                                try {
                                    java.net.URL u = new java.net.URL(embedRefererArg);
                                    origin = u.getProtocol() + "://" + u.getHost();
                                } catch (Exception ignored) {}
                                headers.put("Referer", origin + "/");
                                headers.put("Origin", origin);
                            }
                            openPlayer(directUrl, st, false, null, headers, new JSObject(), embedTitle, "vod", null, -1, null, null, 0, 0, null, "", 0, 0, null, -1);
                        });
                        return;
                    }
                    Log.d(TAG, "Native resolve failed, falling back to WebView");
                } catch (Exception e) {
                    Log.e(TAG, "Native resolve error: " + e.getMessage());
                }
                // Fall back to WebView — use last working mirror, not dead voe.sx
                String wvUrl = (lastVoeMirrorUrl != null && !lastVoeMirrorUrl.isEmpty())
                    ? lastVoeMirrorUrl : url;
                mainHandler.post(() -> {
                    try {
                        showEmbedWebView(call, wvUrl, embedTitle, embedRefererArg, false, waitUntilMs);
                    } catch (Exception e) {
                        Log.e(TAG, "Error showing embed WebView", e);
                        call.reject("Failed to show embed: " + e.getMessage());
                    }
                });
            }).start();
            return;
        }

        mainHandler.post(() -> {
            try {
                showEmbedWebView(call, url, embedTitle, embedRefererArg, playbackMode, waitUntilMs);
            } catch (Exception e) {
                Log.e(TAG, "Error showing embed WebView", e);
                call.reject("Failed to show embed: " + e.getMessage());
            }
        });
    }

    /**
     * Headless embed resolver ("FlareSolverr ligero").
     * Loads the embed URL in an INVISIBLE WebView attached to the decorView,
     * lets anti-bot JS (Cloudflare, ALTCHA, fingerprint) run, auto-clicks the
     * play button, and intercepts the media URL from network requests.
     * Resolves with { status:'resolved', url, streamType, referer, cookies }
     * or { status:'failed' } after the timeout. Serialized — one at a time.
     */
    @PluginMethod
    public void resolveEmbed(PluginCall call) {
        final String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("url is required");
            return;
        }
        Uri parsedRes = Uri.parse(url);
        String resScheme = parsedRes.getScheme();
        if (resScheme == null || !(resScheme.equalsIgnoreCase("http") || resScheme.equalsIgnoreCase("https"))) {
            call.reject("invalid url scheme: only http/https are allowed");
            return;
        }
        final int timeoutMs = Math.max(5000, call.getInt("timeout", 20000));
        final String referer = call.getString("referer");
        mainHandler.post(() -> {
            if (headlessBusy) {
                call.resolve(new JSObject().put("status", "busy"));
                return;
            }
            startHeadlessResolve(call, url, timeoutMs, referer);
        });
    }

    /**
     * Reproduce un media URL resuelto de un embed cuyo CDN solo lo sirve a la
     * propia página del proveedor (p. ej. tiestep). Levanta el relay local
     * (WebView oculto en el origen del referer + servidor loopback) y abre
     * ExoPlayer contra http://127.0.0.1/relay?u=... — cada petición de
     * playlist/segmento se reenvía a un fetch() dentro del WebView.
     * Resuelve { status:'playing' } o { status:'failed' } si el relay no arranca.
     */
    @PluginMethod
    public void playRelay(PluginCall call) {
        final String url = call.getString("url");
        final String referer = call.getString("referer");
        final String title = call.getString("title", "");
        final String mode = call.getString("mode", "live");
        if (url == null || url.isEmpty()) {
            call.reject("url is required");
            return;
        }
        Uri parsedRelay = Uri.parse(url);
        String relayScheme = parsedRelay.getScheme();
        if (relayScheme == null || !(relayScheme.equalsIgnoreCase("http") || relayScheme.equalsIgnoreCase("https"))) {
            call.reject("invalid url scheme: only http/https are allowed");
            return;
        }
        String origin = originOf(referer != null && referer.startsWith("http") ? referer : url);
        if (origin == null) {
            call.resolve(new JSObject().put("status", "failed"));
            return;
        }
        final String originF = origin;
        mainHandler.post(() -> {
            final boolean[] done = {false};
            final Runnable timeout = () -> {
                if (done[0]) return;
                done[0] = true;
                call.resolve(new JSObject().put("status", "failed"));
            };
            mainHandler.postDelayed(timeout, 12000);
            startEmbedRelay(originF, () -> {
                if (done[0]) return;
                done[0] = true;
                mainHandler.removeCallbacks(timeout);
                String relayUrl = relayUrlFor(url);
                if (relayUrl == null) {
                    call.resolve(new JSObject().put("status", "failed"));
                    return;
                }
                relayKeepAlive = true;
                try {
                    openPlayer(relayUrl, "hls", false, null, new JSObject(), new JSObject(),
                            title, mode, null, -1, null, null, 0, 0, null, "", 0, 0, null, -1);
                } finally {
                    relayKeepAlive = false;
                }
                call.resolve(new JSObject().put("status", "playing"));
            });
        });
    }

    private void startHeadlessResolve(PluginCall call, String url, int timeoutMs, String referer) {
        headlessBusy = true;
        Context context = getContext();
        final boolean[] done = {false};
        final String[] refererRef = {referer};

        try {
            headlessWebView = new WebView(context);
            // Casi invisible pero renderizando: alpha 0.01 + tamaño real para
            // que el JS anti-bot vea un viewport y un compositor normales.
            headlessWebView.setAlpha(0.01f);
            FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT);
            ViewGroup decor = (ViewGroup) getActivity().getWindow().getDecorView().getRootView();
            decor.addView(headlessWebView, lp);

            WebSettings s = headlessWebView.getSettings();
            s.setJavaScriptEnabled(true);
            s.setDomStorageEnabled(true);
            // Contenido de terceros: sin acceso a archivos ni providers locales.
            s.setAllowFileAccess(false);
            s.setAllowContentAccess(false);
            s.setMediaPlaybackRequiresUserGesture(false);
            s.setUserAgentString("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
            s.setLoadWithOverviewMode(true);
            s.setUseWideViewPort(true);
            android.webkit.CookieManager.getInstance().setAcceptCookie(true);
            android.webkit.CookieManager.getInstance().setAcceptThirdPartyCookies(headlessWebView, true);

            final String[] lastPageUrl = {url};
            final Runnable[] finishRef = new Runnable[1];
            finishRef[0] = () -> {
                if (done[0]) return;
                done[0] = true;
                cleanupHeadless();
                call.resolve(new JSObject().put("status", "failed"));
            };
            final Runnable finishFn = finishRef[0];

            // ID del embed (último segmento del path, sin extensión) — los
            // mirrors rotan de dominio pero conservan el ID (voe.sx→johnfullwonder,
            // powvideo→powwideo, vidhidepro→vidhidefast).
            String embedId = "";
            try {
                String path = android.net.Uri.parse(url).getLastPathSegment();
                if (path != null) embedId = path.replaceFirst("\\.html?$", "");
            } catch (Exception ignored) {}
            final String embedIdF = embedId;

            // El Referer que el CDN espera es el de la página que pidió el
            // stream (el iframe del player, p.ej. tiestep.top/e/…), no la
            // página top — se captura del header de la propia petición.
            final String[] videoReferer = {null};
            final java.util.Map<String, String> videoHeaders = new java.util.HashMap<>();
            java.util.function.Consumer<String> found = u -> {
                if (done[0] || u == null || !isVideoUrl(u)) return;
                done[0] = true;
                Log.d(TAG, "Headless resolved: " + hostOf(u));
                String cookies = null;
                try { cookies = android.webkit.CookieManager.getInstance().getCookie(u); } catch (Exception ignored) {}
                String ref = videoReferer[0] != null ? videoReferer[0] : lastPageUrl[0];
                JSObject out = new JSObject()
                    .put("status", "resolved")
                    .put("url", u)
                    .put("streamType", getStreamType(u))
                    .put("referer", ref);
                // Headers originales de la petición (Cookie/UA/Origin) — los
                // CDN firmados los exigen de vuelta en ExoPlayer.
                if (!videoHeaders.isEmpty()) {
                    JSObject h = new JSObject();
                    for (java.util.Map.Entry<String, String> e : videoHeaders.entrySet()) {
                        String k = e.getKey();
                        if (k != null && e.getValue() != null) h.put(k, e.getValue());
                    }
                    out.put("requestHeaders", h);
                }
                if (cookies != null && !cookies.isEmpty()) out.put("cookies", cookies);
                // shouldInterceptRequest corre fuera del main thread — el
                // destroy del WebView debe hacerse en el hilo principal.
                mainHandler.post(() -> {
                    cleanupHeadless();
                    call.resolve(out);
                });
            };

            headlessWebView.addJavascriptInterface(new Object() {
                @android.webkit.JavascriptInterface
                public void onVideoFound(String u) {
                    mainHandler.post(() -> found.accept(u));
                }
            }, "AndroidVideoResolver");

            headlessWebView.setWebViewClient(new WebViewClient() {
                @Override
                public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                    String u = req.getUrl().toString();
                    if (isVideoUrl(u)) { found.accept(u); return true; }
                    // Bloquea popups/navegación a dominios ajenos (anuncios)
                    String host = req.getUrl().getHost();
                    String cur = null;
                    try { cur = android.net.Uri.parse(lastPageUrl[0]).getHost(); } catch (Exception ignored) {}
                    if (host != null && cur != null && !host.equalsIgnoreCase(cur)) {
                        // Ads primero: los trackers llevan el ID del embed
                        // como parámetro y se colaban por el bypass de mirror.
                        if (isAdRequest(u)) {
                            Log.d(TAG, "Headless blocked ad nav: " + hostOf(u));
                            return true;
                        }
                        boolean challenge = host.contains("recaptcha") || host.contains("hcaptcha")
                            || host.contains("altcha") || host.contains("cloudflare")
                            || host.contains("challenges.cloudflare") || host.contains("datadome");
                        // Rotación de mirrors: permitir si conserva el ID del embed
                        boolean sameEmbed = embedIdF.length() >= 4 && u.contains(embedIdF);
                        if (!challenge && !sameEmbed) {
                            Log.d(TAG, "Headless blocked nav: " + hostOf(u));
                            return true;
                        }
                        Log.d(TAG, "Headless allow mirror/challenge nav: " + hostOf(u));
                    }
                    // Anti-iframe buster: players como tiestep.top hacen
                    // `if (window==top) location="/"` para escapar del embed.
                    // Como top page esa fuga mata el player — bloquear la nav
                    // a la raíz del propio host mantiene la página en /e/<id>.
                    try {
                        android.net.Uri pu = android.net.Uri.parse(u);
                        String p = pu.getPath();
                        if ((p == null || p.equals("/") || p.isEmpty())
                            && !u.equals(lastPageUrl[0])) {
                            Log.d(TAG, "Headless blocked root escape: " + hostOf(u));
                            return true;
                        }
                    } catch (Exception ignored) {}
                    return false;
                }
                @Override
                public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                    String u = request.getUrl().toString();
                    if (isVideoUrl(u)) {
                        try {
                            java.util.Map<String, String> hh = request.getRequestHeaders();
                            if (hh != null) for (String k : new String[]{"User-Agent", "Referer", "Origin", "Cookie"}) {
                                String v = hh.get(k);
                                if (v == null) v = hh.get(k.toLowerCase());
                                if (v != null) videoHeaders.put(k, v);
                            }
                            videoReferer[0] = videoHeaders.get("Referer");
                        } catch (Exception ignored) {}
                        found.accept(u);
                        // Respuesta vacía: el token del m3u8 puede ser de un
                        // solo uso — si el WebView lo consume, ExoPlayer
                        // recibiría 403 al pedir la misma URL.
                        return new WebResourceResponse("text/plain", "utf-8",
                            new java.io.ByteArrayInputStream(new byte[0]));
                    }
                    // Bloqueo uBlock: anuncios/trackers no se cargan en el
                    // headless — acelera la resolución y evita popunders.
                    if (isAdRequest(u)) return emptyAdResponse();
                    // Hosts con WAF que rechazan el fingerprint del WebView
                    // (403 al instante) pero aceptan el stack HTTP nativo —
                    // se sirven por proxy (p.ej. tiestep.top de DaddyLive).
                    if (isProxyEmbedHost(u)) {
                        WebResourceResponse proxied = proxyEmbedGet(u, refererRef[0], request.getRequestHeaders());
                        if (proxied != null) return proxied;
                    }
                    // DEBUG: log non-asset requests to trace player traffic
                    if (!u.matches(".*\\.(js|css|png|jpe?g|svg|woff2?|ico|gif|webp)(\\?.*)?$"))
                        Log.d(TAG, "HL req: " + hostOf(u));
                    return null;
                }
                @Override
                public void onPageStarted(WebView view, String pageUrl, android.graphics.Bitmap favicon) {
                    Log.d(TAG, "Headless page started: " + hostOf(pageUrl));
                }
                @Override
                public void onReceivedError(WebView view, WebResourceRequest req, android.webkit.WebResourceError error) {
                    if (req.isForMainFrame()) {
                        Log.d(TAG, "Headless page error: " + hostOf(req.getUrl() != null ? req.getUrl().toString() : null) + " code=" + error.getErrorCode() + " " + error.getDescription());
                    }
                }
                @Override
                public void onPageFinished(WebView view, String pageUrl) {
                    Log.d(TAG, "Headless page finished: " + hostOf(pageUrl));
                    lastPageUrl[0] = pageUrl;
                    injectHeadlessAutoplay(view);
                    // Si la página es un captcha no hay nada que resolver en
                    // headless — terminar ya para que el caller abra el
                    // WebView visible al instante en vez de esperar el timeout.
                    Runnable captchaCheck = () -> {
                        if (done[0] || headlessWebView == null) return;
                        view.evaluateJavascript(
                            "(function(){return document.querySelector('iframe[src*=captcha],iframe[src*=turnstile],"
                            + "iframe[src*=recaptcha],iframe[src*=hcaptcha],iframe[src*=challenges.cloudflare],"
                            + "iframe[src*=datadome],.g-recaptcha,.h-captcha,.cf-turnstile,#challenge-stage,"
                            + "form[action*=verify],form[action*=check]')?1:0})()",
                            v -> {
                                if ("1".equals(v) && !done[0]) {
                                    done[0] = true;
                                    Log.d(TAG, "Headless captcha detected: " + hostOf(pageUrl));
                                    cleanupHeadless();
                                    call.resolve(new JSObject().put("status", "captcha"));
                                }
                            });
                    };
                    captchaCheck.run();
                    mainHandler.postDelayed(captchaCheck, 2000);
                }
            });
            headlessWebView.setWebChromeClient(new android.webkit.WebChromeClient() {
                @Override
                public boolean onConsoleMessage(android.webkit.ConsoleMessage msg) {
                    String m = msg.message() != null ? msg.message() : "";
                    if (m.contains("altcha") || m.contains("Altcha") || m.contains("error") || m.contains("Error"))
                        Log.d(TAG, "HeadlessConsole: " + m.substring(0, Math.min(m.length(), 200)));
                    return true;
                }
            });

            headlessTimeout = finishFn;
            mainHandler.postDelayed(finishFn, timeoutMs);
            if (referer != null && referer.startsWith("http")) {
                java.util.Map<String, String> hdrs = new java.util.HashMap<>();
                hdrs.put("Referer", referer);
                headlessWebView.loadUrl(url, hdrs);
            } else {
                headlessWebView.loadUrl(url);
            }
        } catch (Exception e) {
            Log.e(TAG, "Headless resolver error", e);
            cleanupHeadless();
            call.resolve(new JSObject().put("status", "failed"));
        }
    }

    // Hosts de embed cuyo WAF (nginx/cloudflare) rechaza el fingerprint del
    // WebView — la petición nativa (HttpURLConnection) sí pasa. Rotan de
    // dominio; se mantienen los conocidos de la cadena DaddyLive.
    private static final String[] EMBED_PROXY_HOSTS = {
        "tiestep.top",
    };

    // Parche para el anti-bot "Sandbox not allowed" de players tipo tiestep:
    // crean un <object data="data:application/pdf;base64,..."> y si onerror
    // salta (el WebView no renderiza PDF) bloquean el vídeo. Se intercepta la
    // carga del objeto para que nunca falle y se declara pdfViewerEnabled.
    private static final String SANDBOX_PATCH_JS =
        "<script>(function(){"
        + "try{Object.defineProperty(navigator,'pdfViewerEnabled',{get:function(){return true}});}catch(e){}"
        + "var oc=document.createElement.bind(document);"
        + "document.createElement=function(t){"
        + "  var el=oc(t);"
        + "  var tag=String(t).toLowerCase();"
        + "  if(tag==='object'||tag==='embed'){"
        + "    var sa=el.setAttribute.bind(el);"
        + "    el.setAttribute=function(n,v){"
        + "      if(n==='data'||n==='src'){"
        + "        setTimeout(function(){if(el.onload){try{el.onload()}catch(_){}}},0);"
        + "        return;"
        + "      }"
        + "      sa(n,v);"
        + "    };"
        + "    try{Object.defineProperty(el,'data',{configurable:true,"
        + "      set:function(){setTimeout(function(){if(el.onload){try{el.onload()}catch(_){}}},0);},"
        + "      get:function(){return ''}});}catch(e){}"
        + "  }"
        + "  return el;"
        + "};"
        // El player arranca muteado por la política de autoplay y muestra
        // "CLICK TO UNMUTE" — desmutear programáticamente y ocultar el overlay.
        + "var __mu=function(){var v=document.querySelector('video');"
        + "if(v){try{v.muted=false;v.volume=1;}catch(e){}}"
        + "var us=document.querySelectorAll('[class*=unmute],[id*=unmute],[class*=mute-overlay]');"
        + "for(var i=0;i<us.length;i++)us[i].style.display='none';};"
        + "setInterval(__mu,1200);setTimeout(__mu,300);"
        + "})();</script>";

    private boolean isProxyEmbedHost(String u) {
        try {
            String h = android.net.Uri.parse(u).getHost();
            if (h == null) return false;
            h = h.toLowerCase();
            for (String p : EMBED_PROXY_HOSTS) {
                if (h.equals(p) || h.endsWith("." + p)) return true;
            }
        } catch (Exception ignored) {}
        return false;
    }

    // GET síncrono vía stack nativo para servirlo al WebView. Corre dentro de
    // shouldInterceptRequest (hilo de red de WebView — bloquear está OK).
    private WebResourceResponse proxyEmbedGet(String u, String fallbackReferer, java.util.Map<String, String> reqHeaders) {
        java.net.HttpURLConnection conn = null;
        try {
            if (!u.startsWith("http://") && !u.startsWith("https://")) return null;
            conn = (java.net.HttpURLConnection) new java.net.URL(u).openConnection();
            conn.setConnectTimeout(12000);
            conn.setReadTimeout(12000);
            conn.setInstanceFollowRedirects(true);
            String ua = reqHeaders != null ? reqHeaders.get("User-Agent") : null;
            conn.setRequestProperty("User-Agent", ua != null ? ua
                : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
            conn.setRequestProperty("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
            String ref = reqHeaders != null ? reqHeaders.get("Referer") : null;
            if (ref == null || ref.isEmpty()) ref = fallbackReferer;
            if (ref != null && ref.startsWith("http")) conn.setRequestProperty("Referer", ref);
            int code = conn.getResponseCode();
            if (code < 200 || code >= 400) {
                Log.d(TAG, "ProxyEmbed " + hostOf(u) + " -> " + code);
                conn.disconnect();
                return null; // deja que el WebView lo intente normal
            }
            String mime = conn.getContentType();
            String encoding = "utf-8";
            if (mime != null) {
                int ci = mime.indexOf("charset=");
                if (ci >= 0) encoding = mime.substring(ci + 8).trim();
                mime = mime.split(";")[0].trim();
            }
            if (mime == null || mime.isEmpty()) {
                String p = android.net.Uri.parse(u).getPath();
                mime = p != null && p.endsWith(".js") ? "application/javascript"
                     : p != null && p.endsWith(".css") ? "text/css" : "text/html";
            }
            java.io.InputStream body = conn.getInputStream();
            // HTML: inyectar el parche anti-PDF-check. Players como tiestep
            // crean un <object data="data:application/pdf;base64,..."> y si
            // dispara onerror (WebView no renderiza PDF) bloquean el vídeo
            // con "Sandbox not allowed". El iframe es cross-origin, así que
            // el parche va dentro del propio HTML servido.
            if (mime.toLowerCase().contains("text/html")) {
                try {
                    java.util.Scanner sc = new java.util.Scanner(body, encoding).useDelimiter("\\A");
                    String html = sc.hasNext() ? sc.next() : "";
                    conn.disconnect();
                    conn = null;
                    String inject = SANDBOX_PATCH_JS;
                    int hi = html.indexOf("<head");
                    if (hi >= 0) {
                        int gt = html.indexOf('>', hi);
                        if (gt >= 0) html = html.substring(0, gt + 1) + inject + html.substring(gt + 1);
                        else html = inject + html;
                    } else {
                        html = inject + html;
                    }
                    body = new java.io.ByteArrayInputStream(html.getBytes(encoding));
                } catch (Exception e) {
                    Log.d(TAG, "ProxyEmbed html patch fail: " + e.getMessage());
                }
            }
            java.util.Map<String, String> respHeaders = new java.util.HashMap<>();
            respHeaders.put("Access-Control-Allow-Origin", "*");
            Log.d(TAG, "ProxyEmbed served " + hostOf(u) + " (" + mime + ")");
            return new WebResourceResponse(mime, encoding, code, "OK", respHeaders, body);
        } catch (Exception e) {
            Log.d(TAG, "ProxyEmbed fail " + hostOf(u) + ": " + e.getMessage());
            if (conn != null) conn.disconnect();
            return null;
        }
    }

    // Inyecta clicks automáticos en botones de play, detectores de <video> y un
    // solver ALTCHA (proof-of-work PBKDF2 — se auto-resuelve sin usuario).
    private void injectHeadlessAutoplay(WebView view) {
        view.evaluateJavascript(
            "(function(){" +
            "if(window.__hl)return;window.__hl=1;" +
            "function h2b(h){var a=new Uint8Array(h.length/2);for(var i=0;i<a.length;i++)a[i]=parseInt(h.substr(i*2,2),16);return a;}" +
            "function b2h(b){return Array.prototype.map.call(b,function(x){return ('0'+x.toString(16)).slice(-2);}).join('');}" +
            // Solver ALTCHA: fetch challenge, PBKDF2(nonce+counter) hasta que la
            // clave derive con keyPrefix, payload b64 en input[altcha], submit.
            "window.__solveAltcha=function(w){" +
            "  var chal=w.getAttribute('challenge');var form=w.closest('form');" +
            "  if(!chal||!form)return;" +
            "  fetch(chal,{credentials:'include'}).then(function(r){return r.json();}).then(function(c){" +
            "    var p=c.parameters;var nonce=h2b(p.nonce),salt=h2b(p.salt);" +
            "    var pbytes=(p.keyPrefix.length%2===0)?h2b(p.keyPrefix):null;" +
            "    var counter=0,t0=performance.now();" +
            "    function done(n,hex){" +
            "      var took=Math.round(performance.now()-t0);" +
            "      var pl=btoa(JSON.stringify({challenge:{parameters:p,signature:c.signature},solution:{counter:n,derivedKey:hex,time:took}}));" +
            "      var inp=form.querySelector('input[name=altcha]');" +
            "      if(!inp){inp=document.createElement('input');inp.type='hidden';inp.name='altcha';form.appendChild(inp);}" +
            "      inp.value=pl;form.submit();" +
            "    }" +
            "    function next(){" +
            "      var pw=new Uint8Array(nonce.length+4);pw.set(nonce);" +
            "      new DataView(pw.buffer).setUint32(nonce.length,counter,false);" +
            "      crypto.subtle.importKey('raw',pw,{name:'PBKDF2'},false,['deriveBits']).then(function(k){" +
            "        return crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:salt,iterations:p.cost},k,p.keyLength*8);" +
            "      }).then(function(bits){" +
            "        var dk=new Uint8Array(bits);var ok=true;" +
            "        if(pbytes){for(var i=0;i<pbytes.length;i++){if(dk[i]!==pbytes[i]){ok=false;break;}}}" +
            "        else{ok=b2h(dk).indexOf(p.keyPrefix)===0;}" +
            "        if(ok){done(counter,b2h(dk));}else{counter++;if(counter<500000)next();}" +
            "      }).catch(function(){});" +
            "    }" +
            "    next();" +
            "  }).catch(function(){});" +
            "};" +
            "function tick(){" +
            "  var v=document.querySelector('video');" +
            "  var vsrc=v&&(v.currentSrc||v.src);" +
            "  if(vsrc&&vsrc.indexOf('blob:')!==0){" +
            // Report src of a playing video element as a last resort
            "    if(window.AndroidVideoResolver)window.AndroidVideoResolver.onVideoFound(vsrc);" +
            "  }" +
            // jwplayer (VOE y otros): leer la URL del playlist directamente y
            // forzar play — con autostart:false nunca llega petición de red.
            "  try{if(window.jwplayer){var jp=jwplayer();" +
            "    var pl=jp.getPlaylist&&jp.getPlaylist();" +
            "    if(pl&&pl[0]){var jf=pl[0].file||(pl[0].sources&&pl[0].sources[0]&&pl[0].sources[0].file);" +
            "      if(jf&&window.AndroidVideoResolver){" +
            "        try{jf=new URL(jf,location.href).href;}catch(e){}" +
            "        window.AndroidVideoResolver.onVideoFound(jf);}}" +
            "    if(jp.getState&&jp.getState()!=='playing'){jp.play(true);}" +
            "  }}catch(e){}" +
            // ALTCHA gate (VOE): try the widget's checkbox first, fall back to
            // solving the PoW ourselves if the shadow DOM is closed.
            "  var aw=document.querySelector('altcha-widget');" +
            "  if(aw){try{" +
            "    var sr=aw.shadowRoot;" +
            "    var cb=sr?sr.querySelector('input[type=checkbox],input,button,[role=checkbox]'):null;" +
            "    if(cb){if(!cb.checked&&!cb.disabled){cb.click();window.__altchaBusy=1;}}" +
            "    else if(!window.__altchaBusy){window.__altchaBusy=1;window.__solveAltcha(aw);}" +
            "  }catch(e){if(!window.__altchaBusy){window.__altchaBusy=1;window.__solveAltcha(aw);}}}" +
            "  var sels=['#play','.play','button.play','.jw-icon-playback','.vjs-big-play-button'," +
            "    '[id*=playbtn]','[class*=playbtn]','button[class*=play]','a[class*=play]'," +
            "    'button','input[type=submit]','.plyr__control--overlaid'];" +
            "  for(var i=0;i<sels.length;i++){" +
            "    var els=document.querySelectorAll(sels[i]);" +
            "    for(var j=0;j<els.length;j++){" +
            "      var b=els[j];var r=b.getBoundingClientRect();" +
            "      if(r.width>0&&r.height>0){try{b.click();}catch(e){}}" +
            "    }" +
            "  }" +
            "}" +
            "tick();setInterval(tick,1500);" +
            "})();", null);
    }

    private void cleanupHeadless() {
        if (headlessTimeout != null) {
            mainHandler.removeCallbacks(headlessTimeout);
            headlessTimeout = null;
        }
        if (headlessWebView != null) {
            try {
                headlessWebView.stopLoading();
                ViewGroup parent = (ViewGroup) headlessWebView.getParent();
                if (parent != null) parent.removeView(headlessWebView);
                headlessWebView.destroy();
            } catch (Exception ignored) {}
            headlessWebView = null;
        }
        headlessBusy = false;
    }

    private boolean isVoeUrl(String url) {
        if (url == null) return false;
        String l = url.toLowerCase();
        return l.contains("voe.sx") || l.contains("voe-unblock") || l.contains("voeunblock")
            || l.contains("/e/") && (l.contains("johnfullwonder") || l.contains("voe"));
    }

    private boolean isWaawUrl(String url) {
        // WAAW domain is dead (waaw.to → 127.0.0.1, waaw.tv → waaw.to)
        // Don't try native resolution or WebView - just fail fast.
        return false;
    }

    private boolean isVidmolyUrl(String url) {
        if (url == null) return false;
        String l = url.toLowerCase();
        return l.contains("vidmoly.me") || l.contains("vidmoly.to")
            || l.contains("vidmoly.net") || l.contains("vidmoly.biz");
    }

    private boolean isDoodstreamUrl(String url) {
        if (url == null) return false;
        String l = url.toLowerCase();
        return l.contains("dood.") || l.contains("doodstream.") || l.contains("doodsearch.");
    }

    // Vidmoly (AniWorld vidmoly.py): GET embed page con Referer vidmoly.biz,
    // extrae file: "...m3u8" de los <script> del player.
    private String resolveVidmolyNative(String embedUrl) {
        try {
            String html = httpGetText(embedUrl, "https://vidmoly.biz");
            if (html == null || html.isEmpty()) return null;
            // file: "..." dentro de bloques <script>
            java.util.regex.Matcher m = java.util.regex.Pattern.compile(
                "file\\s*:\\s*[\"']([^\"']+\\.m3u8[^\"']*)[\"']").matcher(html);
            while (m.find()) {
                String u = m.group(1);
                if (u.startsWith("http")) return u;
            }
            // Fallback: cualquier m3u8/mp4 en la página
            m = java.util.regex.Pattern.compile(
                "(https?://[^\"'\\s<>]+\\.(?:m3u8|mp4)[^\"'\\s<>]*)").matcher(html);
            if (m.find()) return m.group(1);
        } catch (Exception e) {
            Log.e(TAG, "Vidmoly native resolve error: " + e.getMessage());
        }
        return null;
    }

    // Doodstream (AniWorld doodstream.py): handshake con pass_md5.
    // 1) GET embed → extrae /pass_md5/... y token=xxx
    // 2) GET pass_md5 → devuelve la base URL del vídeo
    // 3) directUrl = base + random10 + "?token=" + token + "&expiry=" + ts
    private String resolveDoodstreamNative(String embedUrl) {
        try {
            String html = httpGetText(embedUrl, embedUrl);
            if (html == null || html.isEmpty()) return null;

            // Seguir redirect JS si lo hay
            java.util.regex.Matcher rm = java.util.regex.Pattern.compile(
                "window\\.location\\.href\\s*=\\s*['\"]([^'\"]+)['\"]").matcher(html);
            if (rm.find()) {
                String redir = rm.group(1);
                if (!redir.startsWith("http")) {
                    redir = new java.net.URL(new java.net.URL(embedUrl), redir).toString();
                }
                html = httpGetText(redir, redir);
                if (html == null) return null;
                embedUrl = redir;
            }

            String passMd5 = null;
            java.util.regex.Matcher pm = java.util.regex.Pattern.compile(
                "\\$\\.get\\(['\"]([^'\"]*pass_md5[^'\"]*)['\"]").matcher(html);
            if (pm.find()) passMd5 = pm.group(1);
            if (passMd5 == null) {
                pm = java.util.regex.Pattern.compile(
                    "(https?://[^'\"]*pass_md5[^'\"]+)").matcher(html);
                if (pm.find()) passMd5 = pm.group(1);
            }
            if (passMd5 == null) return null;
            if (!passMd5.startsWith("http")) {
                passMd5 = new java.net.URL(new java.net.URL(embedUrl), passMd5).toString();
            }

            java.util.regex.Matcher tm = java.util.regex.Pattern.compile(
                "token=([a-zA-Z0-9]+)").matcher(html);
            if (!tm.find()) return null;
            String token = tm.group(1);

            String base = httpGetText(passMd5, embedUrl);
            if (base == null || base.trim().isEmpty()) return null;

            String chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
            StringBuilder rnd = new StringBuilder();
            java.security.SecureRandom sr = new java.security.SecureRandom();
            for (int i = 0; i < 10; i++) rnd.append(chars.charAt(sr.nextInt(chars.length())));

            return base.trim() + rnd + "?token=" + token + "&expiry=" + (System.currentTimeMillis() / 1000);
        } catch (Exception e) {
            Log.e(TAG, "Doodstream native resolve error: " + e.getMessage());
        }
        return null;
    }

    // GET sencillo que devuelve el cuerpo como texto (para resolvers de embeds).
    private String httpGetText(String urlStr, String referer) {
        java.net.HttpURLConnection conn = null;
        try {
            conn = (java.net.HttpURLConnection) new java.net.URL(urlStr).openConnection();
            conn.setRequestMethod("GET");
            conn.setInstanceFollowRedirects(true);
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(15000);
            conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
            conn.setRequestProperty("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
            if (referer != null) conn.setRequestProperty("Referer", referer);
            if (conn.getResponseCode() != 200) return null;
            java.io.InputStream is = conn.getInputStream();
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
            is.close();
            return bos.toString("UTF-8");
        } catch (Exception e) {
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private String resolveWaawNative(String embedUrl) {
        Log.d(TAG, "resolveWaawNative start: " + hostOf(embedUrl));
        java.util.Map<String, java.util.List<String>> cookieMap = new java.util.HashMap<>();
        try {
            // Replace waaw.to with waaw.tv (waaw.to resolves to 127.0.0.1)
            String fetchUrl = embedUrl.replaceAll("(?i)waaw\\.to", "waaw.tv");
            if (!fetchUrl.equals(embedUrl)) {
                Log.d(TAG, "Waaw: rewrote waaw.to -> waaw.tv: " + hostOf(fetchUrl));
            }

            java.net.HttpURLConnection conn = null;
            int code;
            int redirectCount = 0;

            do {
                java.net.URL url = new java.net.URL(fetchUrl);
                conn = (java.net.HttpURLConnection) url.openConnection();
                conn.setRequestMethod("GET");
                conn.setInstanceFollowRedirects(false);
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(15000);
                conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
                conn.setRequestProperty("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8");
                conn.setRequestProperty("Accept-Language", "en-US,en;q=0.5");
                // Send collected cookies for this domain
                String host = url.getHost().toLowerCase();
                String cookies = getCookiesForHost(cookieMap, host);
                if (cookies != null && !cookies.isEmpty()) {
                    conn.setRequestProperty("Cookie", cookies);
                    Log.d(TAG, "Waaw sending cookies for " + host + " (" + (cookies != null ? cookies.length() : 0) + " chars)");
                }

                code = conn.getResponseCode();
                Log.d(TAG, "Waaw HTTP " + code + " for " + hostOf(fetchUrl));

                // Collect Set-Cookie headers
                java.util.Map<String, java.util.List<String>> headerFields = conn.getHeaderFields();
                if (headerFields != null && headerFields.containsKey("Set-Cookie")) {
                    for (String cookie : headerFields.get("Set-Cookie")) {
                        parseSetCookie(cookie, cookieMap);
                    }
                }

                if (code >= 300 && code < 400) {
                    String location = conn.getHeaderField("Location");
                    conn.disconnect();
                    if (location == null || location.isEmpty()) return null;
                    if (!location.startsWith("http")) {
                        location = new java.net.URL(url, location).toString();
                    }
                    // Replace waaw.to with waaw.tv in redirect
                    location = location.replaceAll("(?i)waaw\\.to", "waaw.tv");
                    Log.d(TAG, "Waaw following redirect: " + hostOf(location));
                    fetchUrl = location;
                    redirectCount++;
                } else {
                    break;
                }
            } while (code >= 300 && code < 400 && redirectCount < 5);

            if (code != 200) {
                if (conn != null) conn.disconnect();
                return null;
            }

            java.io.InputStream is = conn.getInputStream();
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
            is.close();
            conn.disconnect();

            String html = new String(bos.toByteArray(), "UTF-8");
            Log.d(TAG, "Waaw HTML len=" + html.length());

            // Extract video URL
            String source = extractWaawSourceFromHtml(html);
            if (source != null && !isBaitUrl(source)) {
                Log.d(TAG, "Waaw source found: " + hostOf(source));
                return source;
            }

            return null;
        } catch (Exception e) {
            Log.e(TAG, "Waaw native resolve error: " + e.getMessage());
            return null;
        }
    }

    private void parseSetCookie(String setCookie, java.util.Map<String, java.util.List<String>> cookieMap) {
        if (setCookie == null || setCookie.isEmpty()) return;
        // Extract name=value; ignore attributes
        int semi = setCookie.indexOf(';');
        String nv = semi > 0 ? setCookie.substring(0, semi).trim() : setCookie.trim();
        if (!nv.contains("=")) return;
        int eq = nv.indexOf('=');
        String name = nv.substring(0, eq).trim();
        String value = nv.substring(eq + 1).trim();
        // Extract domain from attributes
        String domain = "";
        java.util.regex.Matcher dm = java.util.regex.Pattern.compile("[Dd]omain\\s*=\\s*([^;]+)").matcher(setCookie);
        if (dm.find()) {
            domain = dm.group(1).trim();
        }
        // Store cookie for domain (default to .waaw.tv if empty)
        if (domain.isEmpty()) domain = ".waaw.tv";
        domain = domain.toLowerCase();
        java.util.List<String> list = cookieMap.computeIfAbsent(domain, k -> new java.util.ArrayList<>());
        list.add(name + "=" + value);
        Log.d(TAG, "Waaw cookie stored: " + name + " for " + domain);
    }

    private String getCookiesForHost(java.util.Map<String, java.util.List<String>> cookieMap, String host) {
        java.util.Set<String> names = new java.util.HashSet<>();
        java.util.List<String> result = new java.util.ArrayList<>();
        for (java.util.Map.Entry<String, java.util.List<String>> e : cookieMap.entrySet()) {
            String domain = e.getKey();
            boolean matches = domain.startsWith(".")
                ? host.endsWith(domain) || ("." + host).endsWith(domain)
                : host.equals(domain);
            if (matches) {
                for (String cookie : e.getValue()) {
                    String name = cookie.split("=", 2)[0];
                    if (!names.contains(name)) {
                        names.add(name);
                        result.add(cookie);
                    }
                }
            }
        }
        return result.isEmpty() ? null : String.join("; ", result);
    }

    private String extractWaawSourceFromHtml(String html) {
        // Method 1: video/source tags
        java.util.regex.Matcher videoM = java.util.regex.Pattern.compile(
            "<(?:video|source)[^>]+src=[\"']([^\"']+)[\"']").matcher(html);
        if (videoM.find() && videoM.group(1).matches(".*\\.(m3u8|mp4).*")) return videoM.group(1);

        // Method 2: sources array in JS
        java.util.regex.Matcher sourcesM = java.util.regex.Pattern.compile(
            "sources\\s*:\\s*\\[([^\\]]+)\\]").matcher(html);
        if (sourcesM.find()) {
            java.util.regex.Matcher urlM = java.util.regex.Pattern.compile(
                "[\"'](https?://[^\"']+)[\"']").matcher(sourcesM.group(1));
            while (urlM.find()) {
                if (urlM.group(1).matches(".*\\.(m3u8|mp4).*")) return urlM.group(1);
            }
        }

        // Method 3: "file": "..." pattern
        java.util.regex.Matcher fileM = java.util.regex.Pattern.compile(
            "[\"']file[\"']\\s*:\\s*[\"']([^\"']+)[\"']").matcher(html);
        if (fileM.find() && fileM.group(1).startsWith("http")) return fileM.group(1);

        // Method 4: direct MP4 URL
        java.util.regex.Matcher mp4M = java.util.regex.Pattern.compile(
            "(https?://[^\"'\\s<>]+\\.mp4[^\"'\\s<>]*)").matcher(html);
        if (mp4M.find()) return mp4M.group(1);

        // Method 5: direct M3U8 URL
        java.util.regex.Matcher m3u8M = java.util.regex.Pattern.compile(
            "(https?://[^\"'\\s<>]+\\.m3u8[^\"'\\s<>]*)").matcher(html);
        if (m3u8M.find()) return m3u8M.group(1);

        return null;
    }

    private boolean isBaitUrl(String url) {
        if (url == null) return false;
        String l = url.toLowerCase();
        return l.contains("test-videos") || l.contains("big_buck_bunny") || l.contains("buckbunny")
            || l.contains("sample-videos") || l.contains("example.com") || l.contains("testvideo");
    }

    private String lastVoeMirrorUrl = null; // last working mirror for WebView fallback

    private String resolveVoeNative(String embedUrl) {
        Log.d(TAG, "resolveVoeNative start: " + hostOf(embedUrl));
        lastVoeMirrorUrl = null;
        // If the URL is voe.sx (dead), try mirrors with the same video ID
        if (embedUrl.contains("voe.sx")) {
            String vid = extractVoeVideoId(embedUrl);
            if (vid != null) {
                String[] mirrors = {
                    "https://morencius.com/embed/" + vid,
                    "https://eugenemakedraw.com/embed/" + vid,
                    "https://jilliandescribecompany.com/embed/" + vid,
                    "https://chrisalthough.com/embed/" + vid,
                };
                for (String mirror : mirrors) {
                    String result = resolveVoeUrl(mirror);
                    if (result != null) return result;
                }
            }
        }
        if (lastVoeMirrorUrl == null) lastVoeMirrorUrl = embedUrl;
        return resolveVoeUrl(embedUrl);
    }

    private String extractVoeVideoId(String url) {
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("/(?:e|embed)/([^/?]+)").matcher(url);
        return m.find() ? m.group(1) : null;
    }

    private String resolveVoeUrl(String embedUrl) {
        try {
            java.net.URL url = new java.net.URL(embedUrl);
            java.net.HttpURLConnection conn = (java.net.HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setInstanceFollowRedirects(true);
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(15000);
            conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
            conn.setRequestProperty("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8");
            conn.setRequestProperty("Accept-Language", "en-US,en;q=0.9");
            conn.setRequestProperty("Sec-Fetch-Dest", "document");
            conn.setRequestProperty("Sec-Fetch-Mode", "navigate");
            conn.setRequestProperty("Sec-Fetch-Site", "none");
            conn.setRequestProperty("Upgrade-Insecure-Requests", "1");

            int code = conn.getResponseCode();
            Log.d(TAG, "Voe native HTTP " + code + " for " + hostOf(embedUrl));
            if (code != 200) {
                conn.disconnect();
                return null;
            }
            // Remember this URL responded — it's the best WebView fallback candidate
            lastVoeMirrorUrl = embedUrl;

            java.io.InputStream is = conn.getInputStream();
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
            is.close();
            conn.disconnect();

            String html = new String(bos.toByteArray(), "UTF-8");
            String finalUrl = conn.getURL().toString();
            Log.d(TAG, "Voe native HTML len=" + html.length() + " finalUrl=" + hostOf(finalUrl));

            // Follow JS redirects (voe-dl approach)
            java.util.regex.Pattern[] redirectPatterns = {
                java.util.regex.Pattern.compile("window\\.location\\.href\\s*=\\s*['\"]([^'\"]+)['\"]"),
                java.util.regex.Pattern.compile("window\\.location\\s*=\\s*['\"]([^'\"]+)['\"]"),
                java.util.regex.Pattern.compile("location\\.href\\s*=\\s*['\"]([^'\"]+)['\"]"),
                java.util.regex.Pattern.compile("window\\.location\\.replace\\(['\"]([^'\"]+)['\"]\\)"),
            };
            for (java.util.regex.Pattern p : redirectPatterns) {
                java.util.regex.Matcher m = p.matcher(html);
                if (m.find()) {
                    String redirect = m.group(1);
                    if (!redirect.startsWith("http")) {
                        java.net.URL baseUrl = new java.net.URL(finalUrl);
                        redirect = new java.net.URL(baseUrl, redirect).toString();
                    }
                    if (!redirect.equals(embedUrl) && !redirect.equals(finalUrl)) {
                        Log.d(TAG, "Voe native following redirect: " + hostOf(redirect));
                        return resolveVoeUrl(redirect);
                    }
                }
            }

            // Extract source using voe-dl methods
            String source = extractVoeSourceFromHtmlNative(html, finalUrl);
            if (source != null && !isBaitUrl(source)) {
                Log.d(TAG, "Voe native source found: " + hostOf(source));
                return source;
            }
            if (source != null) {
                Log.d(TAG, "Voe native source was bait, skipping: " + hostOf(source));
            }

            // Follow iframe (voe-dl iframe_fallback)
            java.util.regex.Matcher ifrM = java.util.regex.Pattern.compile("<iframe[^>]+src=[\"']([^\"']+)[\"']").matcher(html);
            if (ifrM.find()) {
                String ifrSrc = ifrM.group(1);
                if (!ifrSrc.startsWith("http")) {
                    java.net.URL baseUrl = new java.net.URL(finalUrl);
                    ifrSrc = new java.net.URL(baseUrl, ifrSrc).toString();
                }
                Log.d(TAG, "Voe native following iframe: " + hostOf(ifrSrc));
                return resolveVoeUrl(ifrSrc);
            }

            return null;
        } catch (Exception e) {
            Log.e(TAG, "Voe native resolve error: " + e.getMessage());
            return null;
        }
    }

    private String extractVoeSourceFromHtmlNative(String html, String baseUrl) {
        // Detect ALTCHA challenge page — can't extract source without JS execution
        if (html.contains("altcha-widget") || html.contains("altcha")
            || html.contains("Confirm you") || html.contains("human to start")) {
            Log.d(TAG, "Voe native: ALTCHA challenge page detected, skipping extraction");
            return null;
        }
        // Detect 503/error pages
        if (html.contains("503 Service Temporarily") || html.contains("502 Bad Gateway")
            || html.contains("504 Gateway Time-out")) {
            Log.d(TAG, "Voe native: error page detected, skipping extraction");
            return null;
        }
        // Method 1: JSON script with obfuscated content (voe-dl method8)
        java.util.regex.Matcher jsonM = java.util.regex.Pattern.compile(
            "<script[^>]*type=[\"']application/json[\"'][^>]*>([\\s\\S]*?)</script>").matcher(html);
        while (jsonM.find()) {
            String raw = jsonM.group(1).trim();
            if (raw.startsWith("[\"")) {
                // Try to decode using voe decode algorithm
                try {
                    String inner = raw.substring(2, raw.length() - 2);
                    String decoded = voeDecodeNative(inner);
                    if (decoded != null) {
                        java.util.regex.Matcher srcM = java.util.regex.Pattern.compile(
                            "\"source\"\\s*:\\s*\"([^\"]+)\"").matcher(decoded);
                        if (srcM.find()) return srcM.group(1);
                        java.util.regex.Matcher hlsM = java.util.regex.Pattern.compile(
                            "\"hls\"\\s*:\\s*\"([^\"]+)\"").matcher(decoded);
                        if (hlsM.find()) return hlsM.group(1);
                        java.util.regex.Matcher fileM = java.util.regex.Pattern.compile(
                            "\"file\"\\s*:\\s*\"([^\"]+)\"").matcher(decoded);
                        if (fileM.find()) return fileM.group(1);
                    }
                } catch (Exception ignored) {}
            }
        }

        // Method 2: var a168c (voe-dl method6)
        java.util.regex.Matcher a168cM = java.util.regex.Pattern.compile("var\\s+a168c\\s*=\\s*['\"]([^'\"]+)['\"]").matcher(html);
        if (a168cM.find()) {
            try {
                String decoded = voeDecodeNative(a168cM.group(1));
                if (decoded != null) {
                    java.util.regex.Matcher srcM = java.util.regex.Pattern.compile(
                        "\"source\"\\s*:\\s*\"([^\"]+)\"").matcher(decoded);
                    if (srcM.find()) return srcM.group(1);
                }
            } catch (Exception ignored) {}
        }

        // Method 3: HLS field
        java.util.regex.Matcher hlsM = java.util.regex.Pattern.compile(
            "hls[^a-zA-Z]*['\"]([^'\"]+\\.m3u8[^'\"]*)['\"]").matcher(html);
        if (hlsM.find()) return hlsM.group(1);

        // Method 4: mp4/hls direct patterns
        java.util.regex.Matcher mp4M = java.util.regex.Pattern.compile(
            "(?:mp4|hls)['\"]?\\s*:\\s*['\"]([^'\"]+)").matcher(html);
        if (mp4M.find() && mp4M.group(1).startsWith("http")) return mp4M.group(1);

        // Method 5: packed JS (eval(p,a,c,k,e,d)) — VOE/vidhide mirrors ship
        // sources inside packed JS instead of plain HTML.
        java.util.List<String> unpacked = unpackPackedScripts(html);
        for (String js : unpacked) {
            java.util.regex.Matcher hlsJs = java.util.regex.Pattern.compile(
                "https?://[^\\s\"'\\\\]+?\\.m3u8[^\\s\"'\\\\]*").matcher(js);
            if (hlsJs.find()) return hlsJs.group();
            java.util.regex.Matcher mp4Js = java.util.regex.Pattern.compile(
                "https?://[^\\s\"'\\\\]+?\\.mp4[^\\s\"'\\\\]*").matcher(js);
            if (mp4Js.find()) return mp4Js.group();
            java.util.regex.Matcher txtJs = java.util.regex.Pattern.compile(
                "https?://[^\\s\"'\\\\]+?master\\.txt[^\\s\"'\\\\]*").matcher(js);
            if (txtJs.find()) return txtJs.group();
        }

        // Method 6: any m3u8 URL
        java.util.regex.Matcher m3u8M = java.util.regex.Pattern.compile(
            "(https?://[^'\"\\s]+\\.m3u8[^'\"\\s]*)").matcher(html);
        if (m3u8M.find()) return m3u8M.group(1);

        // Method 7: any mp4 URL
        java.util.regex.Matcher mp4UrlM = java.util.regex.Pattern.compile(
            "(https?://[^'\"\\s]+\\.mp4[^'\"\\s]*)").matcher(html);
        if (mp4UrlM.find()) return mp4UrlM.group(1);

        // Method 8: video/source tags
        java.util.regex.Matcher videoSrcM = java.util.regex.Pattern.compile(
            "<(?:video|source)[^>]+src=[\"']([^\"']+)[\"']").matcher(html);
        if (videoSrcM.find() && videoSrcM.group(1).matches(".*\\.(m3u8|mp4).*")) return videoSrcM.group(1);

        return null;
    }

    // Unpack Dean Edwards p.a.c.k.e.r eval blocks (base-36).
    // VOE/vidhide mirrors embed video sources inside eval-packed JS.
    private java.util.List<String> unpackPackedScripts(String html) {
        java.util.List<String> results = new java.util.ArrayList<>();
        if (html == null) return results;
        java.util.regex.Pattern blockRe = java.util.regex.Pattern.compile(
            "eval\\(function\\(p,a,c,k,e,d\\)");
        java.util.regex.Matcher blockM = blockRe.matcher(html);
        while (blockM.find()) {
            int start = blockM.start();
            int end = html.indexOf("</script>", start);
            String block = end > start ? html.substring(start, end) : html.substring(start);
            java.util.regex.Matcher args = java.util.regex.Pattern.compile(
                "\\}\\('([\\s\\S]*)',\\s*(\\d+),\\s*(\\d+),\\s*'([\\s\\S]*?)'\\.split\\('\\|'\\)")
                .matcher(block);
            if (!args.find()) continue;
            String payload = args.group(1);
            int radix = Integer.parseInt(args.group(2));
            int count = Integer.parseInt(args.group(3));
            String[] keys = args.group(4).split("\\|");
            if (radix != 36 || count != keys.length) continue;
            // Build word→replacement map (base-36 index → key)
            String chars = "0123456789abcdefghijklmnopqrstuvwxyz";
            java.util.Map<String, String> dict = new java.util.HashMap<>();
            for (int i = count - 1; i >= 0; i--) {
                if (keys[i].isEmpty()) continue;
                int n2 = i;
                StringBuilder sb = new StringBuilder();
                do { sb.insert(0, chars.charAt(n2 % 36)); n2 /= 36; } while (n2 > 0);
                dict.put(sb.toString(), keys[i]);
            }
            StringBuilder unpacked = new StringBuilder();
            java.util.regex.Matcher wordM = java.util.regex.Pattern.compile("\\b\\w+\\b").matcher(payload);
            while (wordM.find()) {
                String w = wordM.group();
                wordM.appendReplacement(unpacked,
                    java.util.regex.Matcher.quoteReplacement(dict.getOrDefault(w, w)));
            }
            wordM.appendTail(unpacked);
            results.add(unpacked.toString());
        }
        return results;
    }

    private String voeDecodeNative(String encoded) {
        try {
            // ROT13
            StringBuilder rot13 = new StringBuilder();
            for (char c : encoded.toCharArray()) {
                if (c >= 'A' && c <= 'Z') rot13.append((char) ((c - 'A' + 13) % 26 + 'A'));
                else if (c >= 'a' && c <= 'z') rot13.append((char) ((c - 'a' + 13) % 26 + 'a'));
                else rot13.append(c);
            }
            String s1 = rot13.toString();

            // Remove junk patterns
            for (String pat : new String[]{"@$", "^^", "~@", "%?", "*~", "!!", "#&"}) {
                s1 = s1.replace(pat, "");
            }

            // Base64 decode (standard, not URL-safe)
            String s2 = s1;
            while (s2.length() % 4 != 0) s2 += "=";
            byte[] s3 = android.util.Base64.decode(s2, android.util.Base64.DEFAULT);
            String s3Str = new String(s3, "UTF-8");

            // Shift back by 3
            StringBuilder s4 = new StringBuilder();
            for (char c : s3Str.toCharArray()) s4.append((char) (c - 3));
            String s4Str = s4.toString();

            // Reverse
            String s5 = new StringBuilder(s4Str).reverse().toString();

            // Base64 decode again
            while (s5.length() % 4 != 0) s5 += "=";
            byte[] s6 = android.util.Base64.decode(s5, android.util.Base64.DEFAULT);
            return new String(s6, "UTF-8");
        } catch (Exception e) {
            return null;
        }
    }

    private void showEmbedWebView(PluginCall call, String url, String embedTitle, String embedRefererArg, boolean playbackMode, long waitUntilMs) {
        Log.d(TAG, "showEmbedWebView host=" + hostOf(url) + " playback=" + playbackMode);
        Context context = getContext();
        final boolean[] resolved = {false};
        // En modo playback el vídeo se reproduce DENTRO del WebView (el CDN
        // solo sirve a documentos del propio proveedor) — no se extrae URL.
        final boolean[] mediaStarted = {false};
        // En modo playback la página del proveedor nunca se muestra al
        // usuario: o el vídeo arranca (media) o el embed cierra por timeout.
        // Única excepción: un captcha/challenge que requiera interacción.
        final boolean[] challengeRevealed = {false};
        // Página de cuenta atrás pre-emisión (FCTV): el contador SÍ es
        // contenido legítimo — se revela y el embed espera al vídeo hasta
        // waitUntilMs en vez de cerrar por timeout.
        final boolean[] countdownSeen = {false};
        // Detector combinado: captcha → 'captcha'; cuenta atrás → 'countdown'.
        final String detectJs =
            "(function(){var c=document.querySelector('iframe[src*=captcha],"
            + "iframe[src*=turnstile],iframe[src*=recaptcha],iframe[src*=hcaptcha],"
            + "iframe[src*=altcha],.g-recaptcha,.h-captcha,.cf-turnstile,"
            + "#challenge-stage,altcha-widget,[class*=captcha],[id*=captcha],"
            + "[class*=challenge],[id*=challenge]');if(c)return 'captcha';"
            + "var cd=document.querySelector('[class*=countdown],[id*=countdown],"
            + "[class*=timer],[id*=timer],[class*=clock],[id*=clock],[class*=cuenta],"
            + "[id*=cuenta],[class*=t-minus],[id*=t-minus],[data-countdown],[data-timer]');"
            + "if(cd)return 'countdown';"
            + "var b=document.body?document.body.innerText||'':'';"
            + "var els=document.querySelectorAll('div,span,p,time');"
            + "var timer=false;"
            + "for(var i=0;i<els.length;i++){var tx=els[i].innerText||'';"
            + "if(/^\\s*\\d{1,3}:\\d{2}(:\\d{2})?\\s*$/.test(tx)){timer=true;break;}}"
            + "if(timer&&/empieza|comienza|comenzar|starts|begin|directo|live|qued|pronto|soon|previo|previa/i.test(b))return 'countdown';"
            + "return 'none';})()";
        final boolean[] pageLoaded = {false};
        // ID del embed (último segmento del path) — los proveedores rotan de
        // dominio pero conservan el ID (powvideo→powwideo, voe.sx→johnfullwonder).
        // Sirve para permitir la navegación top al mirror en vez de bloquearla.
        String embedId = "";
        try {
            String path = android.net.Uri.parse(url).getLastPathSegment();
            if (path != null) embedId = path.replaceFirst("\\.html?$", "");
        } catch (Exception ignored) {}
        final String embedIdF = embedId;

        // Clean up any previous embed WebView
        cleanupResolver();
        if (embedDialog != null) {
            try { embedDialog.dismiss(); } catch (Exception ignored) {}
            embedDialog = null;
        }

        // Create a dialog that shows only the captcha area (not full screen)
        embedDialog = new Dialog(context, android.R.style.Theme_Black_NoTitleBar_Fullscreen) {
            @Override
            public boolean dispatchKeyEvent(KeyEvent e) {
                // D-pad → cursor virtual: sin esto el WebView no es usable
                // en Android TV (no hay ratón ni puntero táctil).
                if (embedCursor != null && resolverWebView != null) {
                    int kc = e.getKeyCode();
                    int dx = 0, dy = 0;
                    if (kc == KeyEvent.KEYCODE_DPAD_LEFT) dx = -1;
                    else if (kc == KeyEvent.KEYCODE_DPAD_RIGHT) dx = 1;
                    else if (kc == KeyEvent.KEYCODE_DPAD_UP) dy = -1;
                    else if (kc == KeyEvent.KEYCODE_DPAD_DOWN) dy = 1;
                    if (dx != 0 || dy != 0) {
                        if (e.getAction() == KeyEvent.ACTION_DOWN) {
                            embedCursorMove(dx, dy, e.getRepeatCount());
                        }
                        return true;
                    }
                    if (kc == KeyEvent.KEYCODE_DPAD_CENTER
                        || kc == KeyEvent.KEYCODE_ENTER
                        || kc == KeyEvent.KEYCODE_NUMPAD_ENTER) {
                        if (e.getAction() == KeyEvent.ACTION_UP) embedCursorClick();
                        return true;
                    }
                }
                return super.dispatchKeyEvent(e);
            }

            @Override
            public boolean onKeyDown(int keyCode, KeyEvent event) {
                if (keyCode == KeyEvent.KEYCODE_BACK || keyCode == KeyEvent.KEYCODE_ESCAPE) {
                    if (!resolved[0]) {
                        resolved[0] = true;
                        notifyState("embed_closed", null);
                        call.resolve(new JSObject().put("status", "closed"));
                    }
                    cleanupResolver();
                    dismiss();
                    return true;
                }
                return super.onKeyDown(keyCode, event);
            }
        };
        embedDialog.setCancelable(true);
        embedDialog.setOnDismissListener(d -> {
            if (!resolved[0]) {
                resolved[0] = true;
                notifyState("embed_closed", null);
                call.resolve(new JSObject().put("status", "closed"));
                cleanupResolver();
            }
        });

        FrameLayout container = new FrameLayout(context);
        container.setBackgroundColor(0xFF000000);
        container.setLayoutParams(new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));

        // WebView is full-screen and VISIBLE so anti-bot JS (ALTCHA, Cloudflare)
        // sees a real visible viewport and runs its challenge automatically.
        // A black overlay on top hides the page from the user.
        resolverWebView = new WebView(context);
        FrameLayout.LayoutParams webParams = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        );
        webParams.gravity = Gravity.CENTER;
        resolverWebView.setLayoutParams(webParams);
        resolverWebView.setVisibility(View.VISIBLE);

        WebSettings settings = resolverWebView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        // Contenido de terceros: sin acceso a archivos ni providers locales.
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        // Use a desktop Chrome User-Agent to avoid anti-bot detection
        settings.setUserAgentString("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        // Enable cookies for anti-bot persistence
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        android.webkit.CookieManager.getInstance().setAcceptCookie(true);
        android.webkit.CookieManager.getInstance().setAcceptThirdPartyCookies(resolverWebView, true);

        // En móvil/tablet la página del embed sale diminuta (está hecha para
        // escritorio): pinch-zoom táctil y la zona del captcha se agranda por
        // CSS al revelar la página. En TV no aplica (se usa el cursor D-pad).
        boolean embedIsTv = false;
        try {
            android.app.UiModeManager um =
                (android.app.UiModeManager) context.getSystemService(Context.UI_MODE_SERVICE);
            embedIsTv = um != null
                && um.getCurrentModeType() == android.content.res.Configuration.UI_MODE_TYPE_TELEVISION;
        } catch (Exception ignored) {}
        final boolean isTvEmbed = embedIsTv;
        if (!isTvEmbed) {
            settings.setSupportZoom(true);
            settings.setBuiltInZoomControls(true);
            settings.setDisplayZoomControls(false);
        }

        // JS bridge - called from injected JavaScript when a video URL is found
        class VideoResolverInterface {
            @android.webkit.JavascriptInterface
            public void onVideoFound(String videoUrl) {
                if (videoUrl != null && !videoUrl.isEmpty() && !resolved[0]) {
                    if (isVideoUrl(videoUrl)) {
                        resolved[0] = true;
                        Log.d(TAG, "Embed resolved (JS bridge): " + hostOf(videoUrl));
                        String st = getStreamType(videoUrl);
                        // Extract cookies from the WebView for the video URL's domain
                        try {
                            embedCookies = android.webkit.CookieManager.getInstance().getCookie(videoUrl);
                            if (embedCookies != null && !embedCookies.isEmpty()) {
                                Log.d(TAG, "Embed cookies extracted (" + embedCookies.length() + " chars)");
                            }
                        } catch (Exception ignored) {}
                        JSObject notify = new JSObject();
                        notify.put("state", "embed_resolved");
                        notify.put("url", videoUrl);
                        notify.put("streamType", st);
                        notifyListeners("playbackState", notify);
                        JSObject result = new JSObject();
                        result.put("status", "resolved");
                        result.put("url", videoUrl);
                        result.put("streamType", st);
                        call.resolve(result);
                        mainHandler.post(() -> {
                            if (embedDialog != null) {
                                try { embedDialog.dismiss(); } catch (Exception ignored) {}
                                embedDialog = null;
                            }
                            String ref = embedReferer;
                            String cookies = embedCookies;
                            cleanupResolver();
                            JSObject headers = new JSObject();
                            headers.put("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
                            if (ref != null && !ref.isEmpty()) {
                                String origin = ref;
                                try {
                                    java.net.URL u = new java.net.URL(ref);
                                    origin = u.getProtocol() + "://" + u.getHost();
                                } catch (Exception ignored) {}
                                headers.put("Referer", origin + "/");
                                headers.put("Origin", origin);
                            }
                            // Pass cookies from WebView to ExoPlayer
                            if (cookies != null && !cookies.isEmpty()) {
                                headers.put("Cookie", cookies);
                            }
                            openPlayer(videoUrl, st, false, null, headers, new JSObject(), embedTitle, "vod", null, -1, null, null, 0, 0, null, "", 0, 0, null, -1);
                        });
                    }
                }
            }

            // Modo playback: el helper inyectado avisa cuando un <video> de
            // la página realmente reproduce (cubre MSE/blob cuyas peticiones
            // de segmentos no llevan extensión reconocible).
            @android.webkit.JavascriptInterface
            public void onPlaybackStarted() {
                markEmbedPlaying(mediaStarted);
            }
        }

        resolverWebView.addJavascriptInterface(new VideoResolverInterface(), "AndroidVideoResolver");

        resolverWebView.setWebViewClient(new WebViewClient() {
            private boolean isAllowedTopUrl(String u) {
                if (u == null) return false;
                if (isVideoUrl(u)) return true;
                String host = null;
                try {
                    host = android.net.Uri.parse(u).getHost();
                } catch (Exception ignored) {}
                if (host == null) return false;
                String h = host.toLowerCase();
                // Popunders: navegación top a dominios de anuncios — nunca.
                // Va ANTES del bypass por ID: los trackers de ads suelen
                // llevar el ID del embed como parámetro y se colaban.
                if (isAdRequest(u)) {
                    Log.d(TAG, "Blocked top nav to ad host: " + host);
                    return false;
                }
                // Rotación de mirrors: el proveedor cambia de dominio pero
                // conserva el ID del embed (powvideo.org→powwideo.org). Sin
                // esto la redirección se bloqueaba y la página quedaba negra.
                // Exige ID ≥4 chars y host distinto del actual.
                if (!playbackMode && embedIdF.length() >= 4 && u.contains(embedIdF)) {
                    try {
                        String curH = resolverWebView.getUrl() != null
                            ? android.net.Uri.parse(resolverWebView.getUrl()).getHost() : null;
                        if (curH == null || !curH.equalsIgnoreCase(h)) return true;
                    } catch (Exception ignored) {}
                }
                // Challenges anti-bot interactivos — el usuario debe poder
                // verlos y resolverlos (captcha, Cloudflare Turnstile…).
                if (h.contains("cloudflare") || h.contains("datadome")
                    || h.contains("recaptcha") || h.contains("hcaptcha")
                    || h.contains("altcha")) return true;
                // Allow known Voe/protection domains
                if (h.contains("voe.sx")
                    || h.contains("johnfullwonder.com")
                    || h.contains("voe-unblock")
                    || h.contains("voeunblock")
                    || h.contains("morencius.com")
                    || h.contains("eugenemakedraw")
                    || h.contains("waaw.tv")
                    || h.contains("waaw.to")
                    || h.contains("wolfstream")
                    || h.contains("google.com")
                    || h.contains("gstatic.com")
                    || h.contains("googleapis.com")) return true;
                // Allow same-domain as current embed page
                try {
                    String curHost = android.net.Uri.parse(resolverWebView.getUrl()).getHost();
                    if (curHost != null && curHost.toLowerCase().equals(h)) return true;
                } catch (Exception ignored) {}
                // Allow Voe mirror domains (long unusual domain names that Voe uses)
                // Mirrors de dominio largo: solo en modo resolver — en
                // playback los dominios de ads también son largos y aleatorios.
                if (!playbackMode && h.length() > 15 && !h.contains("facebook") && !h.contains("twitter")
                    && !h.contains("instagram") && !h.contains("ads")
                    && !h.contains("analytics") && !h.contains("tracker")) return true;
                return false;
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                Log.d(TAG, "Embed page started: " + hostOf(url));
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String u) {
                if (!playbackMode && isVideoUrl(u) && !resolved[0]) {
                    new VideoResolverInterface().onVideoFound(u);
                    return true;
                }
                if (playbackMode) {
                    if (isPlaybackNavBlocked(u, view.getUrl())) {
                        Log.d(TAG, "Playback blocked nav (ad/popunder): " + hostOf(u));
                        return true;
                    }
                    return false;
                }
                if (!isAllowedTopUrl(u)) {
                    Log.d(TAG, "Blocked top navigation: " + hostOf(u));
                    return true;
                }
                return false;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String u = request.getUrl().toString();
                if (!playbackMode && isVideoUrl(u) && !resolved[0]) {
                    new VideoResolverInterface().onVideoFound(u);
                    return true;
                }
                if (playbackMode) {
                    if (isPlaybackNavBlocked(u, view.getUrl())) {
                        Log.d(TAG, "Playback blocked nav (ad/popunder): " + hostOf(u));
                        return true;
                    }
                    return false;
                }
                if (!isAllowedTopUrl(u)) {
                    Log.d(TAG, "Blocked top navigation: " + hostOf(u));
                    return true;
                }
                return false;
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, String u) {
                // Bloqueo uBlock: anuncios/trackers fuera (respuesta vacía).
                if (isAdRequest(u)) return emptyAdResponse();
                // La propia URL del embed nunca es media (p.ej. /e/<id>/001.mp4).
                if (u.equals(url)) return null;
                if (playbackMode) {
                    if (isMediaRequest(u)) markEmbedPlaying(mediaStarted);
                    return null;
                }
                checkVideoUrl(u, resolved, call, embedTitle);
                return null;
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                String u = request.getUrl().toString();
                // Bloqueo uBlock: anuncios/trackers fuera (respuesta vacía).
                if (isAdRequest(u)) return emptyAdResponse();
                if (playbackMode) {
                    // Hosts con WAF anti-WebView se sirven por proxy nativo
                    // (mismo mecanismo que el resolver headless) — incluye el
                    // documento principal del embed.
                    if (isProxyEmbedHost(u)) {
                        WebResourceResponse p = proxyEmbedGet(u, embedRefererArg, request.getRequestHeaders());
                        if (p != null) return p;
                    }
                    // La petición de media la hace el propio player de la
                    // página — se deja pasar y marca que el vídeo arrancó.
                    // La URL del main frame no cuenta: streamtape usa
                    // /e/<id>/001.mp4 como página del embed y se marcaría
                    // playback con una página HTML.
                    if (!request.isForMainFrame() && isMediaRequest(u)) markEmbedPlaying(mediaStarted);
                    return null;
                }
                // Igual en modo resolver: el main frame nunca es media.
                if (request.isForMainFrame()) return null;
                // Log all requests to understand provider patterns
                if (u.contains("/stream/") || u.contains(".m3u8") || u.contains(".mp4")
                    || u.contains("/hls/") || u.contains("/dash/") || u.contains("master")) {
                    Log.d(TAG, "Intercept candidate: " + hostOf(u));
                }
                checkVideoUrl(u, resolved, call, embedTitle);
                return null;
            }

            @Override
            public void onPageFinished(WebView view, String pageUrl) {
                Log.d(TAG, "Embed page finished: " + hostOf(pageUrl));
                pageLoaded[0] = true;
                embedReferer = pageUrl;
                // Detect error pages (503, 404, file deleted) and close immediately
                view.evaluateJavascript(
                    "(function(){var t=document.body?document.body.innerText||'':'';" +
                    "var title=document.title||'';" +
                    // Check for 503/404/error pages
                    "if(/503|Service Temporarily|404|Not Found|Server Error|Bad Gateway/i.test(title)&&t.length<500)" +
                    "  return 'error:'+title;" +
                    // Check for file deleted
                    "if(/no longer available|has been deleted|expired or has been|file not found|not available/i.test(t)&&t.length<500)" +
                    "  return 'deleted';" +
                    "return 'ok';})()",
                    result -> {
                        if (resolved[0]) return;
                        String r = result != null ? result.replace("\"", "") : "ok";
                        if (r.startsWith("error:")) {
                            Log.d(TAG, "Embed error page: " + r + " for " + hostOf(pageUrl));
                            resolved[0] = true;
                            notifyState("embed_error", r.substring(6));
                            call.resolve(new JSObject().put("status", "error").put("message", r.substring(6)));
                            mainHandler.post(() -> {
                                if (embedDialog != null) { try { embedDialog.dismiss(); } catch (Exception ignored) {} embedDialog = null; }
                                cleanupResolver();
                            });
                            return;
                        }
                        if (r.equals("deleted")) {
                            Log.d(TAG, "Embed page says file deleted: " + hostOf(pageUrl));
                            resolved[0] = true;
                            notifyState("embed_deleted", null);
                            call.resolve(new JSObject().put("status", "deleted"));
                            mainHandler.post(() -> {
                                if (embedDialog != null) { try { embedDialog.dismiss(); } catch (Exception ignored) {} embedDialog = null; }
                                cleanupResolver();
                            });
                            return;
                        }
                        if (playbackMode) injectPlaybackHelper(view);
                        else injectVideoDetector(view);
                        injectAdBlocker(view);
                    });
                // Re-inject after delays for dynamic content
                mainHandler.postDelayed(() -> {
                    if (!resolved[0] && resolverWebView != null) {
                        if (playbackMode) injectPlaybackHelper(resolverWebView);
                        else injectVideoDetector(resolverWebView);
                        injectAdBlocker(resolverWebView);
                    }
                }, 2000);
                mainHandler.postDelayed(() -> {
                    if (!resolved[0] && resolverWebView != null) {
                        if (playbackMode) injectPlaybackHelper(resolverWebView);
                        else injectVideoDetector(resolverWebView);
                        injectAdBlocker(resolverWebView);
                    }
                }, 5000);
            }
        });

        resolverWebView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onConsoleMessage(String message, int lineNumber, String sourceID) {
                String m = message != null ? message : "";
                Log.d(TAG, "WebViewConsole: " + m.substring(0, Math.min(m.length(), 200)) + " (" + hostOf(sourceID) + ":" + lineNumber + ")");
            }
            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage consoleMessage) {
                String m = consoleMessage.message() != null ? consoleMessage.message() : "";
                Log.d(TAG, "WebViewConsole: " + m.substring(0, Math.min(m.length(), 200)) + " (" + hostOf(consoleMessage.sourceId()) + ":" + consoleMessage.lineNumber() + ")");
                return true;
            }
        });
        resolverWebView.setInitialScale(100);

        // Branded OctoStream loading overlay on top of the WebView (logo +
        // spinner + text) — hides the page rendering/ads while resolving.
        // Instance field: markEmbedPlaying() lo retira al arrancar el vídeo.
        embedOverlay = buildLoadingOverlay("Resolviendo vídeo…");

        // Add a close button (top-right)
        ImageButton closeBtn = new ImageButton(context);
        closeBtn.setImageResource(android.R.drawable.ic_menu_close_clear_cancel);
        closeBtn.setBackgroundColor(0x88000000);
        closeBtn.setPadding(24, 24, 24, 24);
        int scale = (int) (context.getResources().getDisplayMetrics().density * 48);
        FrameLayout.LayoutParams closeParams = new FrameLayout.LayoutParams(scale, scale);
        closeParams.gravity = Gravity.TOP | Gravity.END;
        closeParams.setMargins(16, 16, 16, 16);
        closeBtn.setLayoutParams(closeParams);
        closeBtn.setOnClickListener(v -> {
            if (!resolved[0]) {
                resolved[0] = true;
                notifyState("embed_closed", null);
                call.resolve(new JSObject().put("status", "closed"));
            }
            if (embedDialog != null) {
                try { embedDialog.dismiss(); } catch (Exception ignored) {}
                embedDialog = null;
            }
            cleanupResolver();
        });

        // A los 18s sin resolver/arrancar media la página se revela sola:
        // el WebView visible es el fallback de reproducción y el usuario
        // interactúa con el cursor del mando (captcha, play…).
        final Runnable revealPage = () -> {
            // Remove the black overlay so user can see and interact with the page
            if (embedOverlay != null && embedOverlay.getParent() instanceof ViewGroup) {
                ((ViewGroup) embedOverlay.getParent()).removeView(embedOverlay);
                embedOverlay = null;
            }
            // El #resolver-overlay negro inyectado tapa la página real: al
            // revelar se elimina para que el usuario vea la página completa
            // (captcha en su sitio, botón de play, iframe del player…).
            // En móvil además se agrandan captcha/botones (~1.7×) porque la
            // página del proveedor está pensada para pantallas de escritorio.
            String revealJs =
                "javascript:(function(){var o=document.getElementById('resolver-overlay');"
                + "if(o)o.remove();"
                + (isTvEmbed ? "" :
                    "var c=document.querySelectorAll('iframe[src*=captcha],iframe[src*=turnstile],"
                    + ".g-recaptcha,.h-captcha,.cf-turnstile,#challenge-stage,altcha-widget,"
                    + "[class*=captcha],[id*=captcha]');"
                    + "for(var i=0;i<c.length;i++){c[i].style.transform='scale(1.7)';"
                    + "c[i].style.transformOrigin='center top';}"
                    + "var b=document.querySelectorAll('button,input[type=submit],[class*=play],[id*=play]');"
                    + "for(var j=0;j<b.length;j++){b[j].style.transform='scale(1.4)';}")
                + "})()";
            try {
                resolverWebView.evaluateJavascript(revealJs, null);
            } catch (Exception ignored) {}
            closeBtn.bringToFront();
            resolverWebView.invalidate();
        };
        // Sondeo cada 7s hasta el timeout: la página del proveedor NO se
        // revela salvo captcha (interacción manual) o cuenta atrás pre-
        // emisión (FCTV — el contador es el contenido esperado). Sin vídeo,
        // captcha ni contador, el embed se queda oculto y cierra por timeout.
        final Runnable[] detect = new Runnable[1];
        detect[0] = () -> {
            if (resolved[0] || mediaStarted[0] || challengeRevealed[0]
                || countdownSeen[0] || embedOverlay == null || resolverWebView == null) return;
            resolverWebView.evaluateJavascript(detectJs, r -> {
                if (resolved[0] || mediaStarted[0]) return;
                if (r != null && r.contains("captcha")) {
                    Log.d(TAG, "Embed: captcha detected — revealing page");
                    challengeRevealed[0] = true;
                    revealPage.run();
                } else if (r != null && r.contains("countdown")) {
                    Log.d(TAG, "Embed: pre-match countdown — revealing and waiting");
                    countdownSeen[0] = true;
                    revealPage.run();
                } else {
                    mainHandler.postDelayed(detect[0], 7000);
                }
            });
        };
        mainHandler.postDelayed(detect[0], 7000);
        // Cursor virtual para D-pad: anillo visible que se mueve con las
        // flechas del mando; OK envía un toque real en su posición.
        final float density = context.getResources().getDisplayMetrics().density;
        final int cursorSize = (int) (density * 30);
        embedCursor = new View(context);
        android.graphics.drawable.GradientDrawable cursorBg = new android.graphics.drawable.GradientDrawable();
        cursorBg.setShape(android.graphics.drawable.GradientDrawable.OVAL);
        cursorBg.setColor(0x552196F3);
        cursorBg.setStroke((int) (density * 3), 0xFFFFFFFF);
        embedCursor.setBackground(cursorBg);
        // En móvil hay pantalla táctil — el cursor D-pad no se muestra.
        if (!isTvEmbed) embedCursor.setVisibility(View.GONE);
        FrameLayout.LayoutParams cursorLp = new FrameLayout.LayoutParams(cursorSize, cursorSize);
        container.addView(resolverWebView);
        container.addView(embedOverlay);  // Branded overlay hides the page
        container.addView(closeBtn);
        container.addView(embedCursor, cursorLp);
        embedDialog.setContentView(container);
        // Mantener la pantalla encendida: sin el flag el salvapantallas de
        // Android TV salta encima del vídeo/captcha del embed.
        embedDialog.getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        embedDialog.show();
        // Posición inicial al centro (cuando el WebView ya tiene medidas).
        resolverWebView.getViewTreeObserver().addOnGlobalLayoutListener(
            new android.view.ViewTreeObserver.OnGlobalLayoutListener() {
                @Override
                public void onGlobalLayout() {
                    if (resolverWebView == null || embedCursor == null) return;
                    resolverWebView.getViewTreeObserver().removeOnGlobalLayoutListener(this);
                    embedCursorX = resolverWebView.getWidth() / 2f;
                    embedCursorY = resolverWebView.getHeight() / 2f;
                    embedCursor.setTranslationX(embedCursorX - embedCursor.getWidth() / 2f);
                    embedCursor.setTranslationY(embedCursorY - embedCursor.getHeight() / 2f);
                }
            });

        final Runnable closeWithTimeout = () -> {
            if (resolved[0] || mediaStarted[0]) return;
            Log.d(TAG, "Embed timeout — no media started, closing");
            resolved[0] = true;
            notifyState("embed_timeout", null);
            call.resolve(new JSObject().put("status", "timeout"));
            if (embedDialog != null) {
                try { embedDialog.dismiss(); } catch (Exception ignored) {}
                embedDialog = null;
            }
            cleanupResolver();
        };
        // 30s sin resolver ni arrancar media = sin vídeo — se cierra, la
        // página del proveedor no se muestra nunca. Excepciones: captcha
        // revelado (+60s para resolverlo a mano) y cuenta atrás pre-emisión
        // (FCTV): se mantiene el embed abierto hasta waitUntilMs, y cuando el
        // contador desaparece hay ~10 min de gracia para que arranque el
        // vídeo.
        mainHandler.postDelayed(() -> {
            if (resolved[0] || mediaStarted[0]) return;
            if (challengeRevealed[0]) {
                mainHandler.postDelayed(closeWithTimeout, 60000);
            } else if (countdownSeen[0]) {
                final long deadline = waitUntilMs > 0
                    ? waitUntilMs : System.currentTimeMillis() + 4L * 3600 * 1000;
                final int[] misses = {0};
                final Runnable[] watch = new Runnable[1];
                watch[0] = () -> {
                    if (resolved[0] || mediaStarted[0]) return;
                    if (System.currentTimeMillis() > deadline
                        || resolverWebView == null) {
                        closeWithTimeout.run();
                        return;
                    }
                    resolverWebView.evaluateJavascript(detectJs, r -> {
                        if (resolved[0] || mediaStarted[0]) return;
                        // 'none' = el contador/challenge ya no está — cuenta
                        // como fallo; 10 fallos (~10 min) sin vídeo → cerrar.
                        if (r != null && !r.contains("none")) {
                            misses[0] = 0;
                        } else if (++misses[0] >= 10) {
                            closeWithTimeout.run();
                            return;
                        }
                        mainHandler.postDelayed(watch[0], 60000);
                    });
                };
                mainHandler.postDelayed(watch[0], 30000);
            } else {
                closeWithTimeout.run();
            }
        }, 30000);

        if (embedRefererArg != null && embedRefererArg.startsWith("http")) {
            java.util.Map<String, String> hdrs = new java.util.HashMap<>();
            hdrs.put("Referer", embedRefererArg);
            resolverWebView.loadUrl(url, hdrs);
        } else {
            resolverWebView.loadUrl(url);
        }
    }

    // Anti-iframe: players como tiestep.top hacen `if (window==top)
    // location="/"` para escapar del embed. Como top page esa fuga mata el
    // player — bloquear la navegación a la raíz del propio host lo mantiene.
    private boolean isRootEscape(String u, String currentUrl) {
        try {
            android.net.Uri pu = android.net.Uri.parse(u);
            String p = pu.getPath();
            return (p == null || p.equals("/") || p.isEmpty())
                && !u.equals(currentUrl);
        } catch (Exception ignored) { return false; }
    }

    // En modo playback el vídeo ya corre dentro de la página del embed — no
    // existe navegación top legítima. Solo se permite recargar el MISMO
    // documento (mismo host + mismo path) y los challenges anti-bot; todo lo
    // demás es un popunder de ads (los players DLive/tiestep navegan la
    // página entera a trackers y se cargan la reproducción).
    private boolean isPlaybackNavBlocked(String u, String currentUrl) {
        if (u == null) return true;
        try {
            android.net.Uri nu = android.net.Uri.parse(u);
            String scheme = nu.getScheme();
            if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) return true;
            String uh = nu.getHost();
            if (uh == null) return true;
            String h = uh.toLowerCase(java.util.Locale.ROOT);
            // Challenges anti-bot: el usuario debe poder resolverlos.
            if (h.contains("cloudflare") || h.contains("recaptcha")
                || h.contains("hcaptcha") || h.contains("altcha")
                || h.contains("datadome") || h.contains("challenges.")) return false;
            android.net.Uri cu = currentUrl != null ? android.net.Uri.parse(currentUrl) : null;
            String ch = cu != null ? cu.getHost() : null;
            if (ch == null || !ch.equalsIgnoreCase(uh)) return true;
            // Mismo host: solo el mismo path (recarga con nueva query/token).
            String np = nu.getPath();
            String cp = cu.getPath();
            return np == null || cp == null || !np.equals(cp);
        } catch (Exception ignored) { return true; }
    }

    // Peticiones de media que indican que el player embebido arrancó:
    // manifiestos (.m3u8/.mpd), segmentos (.ts/.m4s/.key) o vídeo directo.
    private boolean isMediaRequest(String u) {
        if (u == null) return false;
        String path = u;
        int q = path.indexOf('?');
        if (q >= 0) path = path.substring(0, q);
        String lp = path.toLowerCase();
        if (isVideoUrl(u)) return true;
        return lp.endsWith(".ts") || lp.endsWith(".m4s") || lp.endsWith(".m4v")
            || lp.endsWith(".m4a") || lp.endsWith(".mpd") || lp.endsWith(".key")
            || lp.endsWith(".aac") || lp.endsWith(".cmfv") || lp.endsWith(".cmfa");
    }

    // ─── Bloqueo de anuncios/trackers (estilo uBlock) ───
    // Dominios de redes publicitarias y tracking habituales en estos embeds.
    private static final java.util.Set<String> AD_HOSTS = new java.util.HashSet<>(java.util.Arrays.asList(
        "doubleclick.net", "googlesyndication.com", "google-analytics.com",
        "adservice.google.com", "adnxs.com", "adsrvr.org", "adform.net",
        "popads.net", "popcash.net", "popmyads.com", "propellerads.com",
        "adsterra.com", "adsterratoolkit.com", "exoclick.com", "juicyads.com",
        "trafficjunky.net", "tsyndicate.com", "hilltopads.net", "adcash.com",
        "admaven.com", "ad-maven.com", "onclickads.net", "onclicksuper.com",
        "directrev.com", "outbrain.com", "taboola.com", "zedo.com",
        "rubiconproject.com", "pubmatic.com", "openx.net", "criteo.com",
        "criteo.net", "scorecardresearch.com", "quantserve.com", "quantcount.com",
        "magsrv.com", "runad.co", "betweendigital.com", "bidswitch.net",
        "smartadserver.com", "advertising.com", "advertising.net",
        "plugrush.com", "whos.amung.us", "histats.com", "hotjar.com",
        "clarity.ms", "yadro.ru", "mc.yandex.ru", "top100.rambler.ru",
        "advane.net", "a-ads.com", "ad-media.io", "adsco.re",
        "trafficstars.com", "ero-advertising.com", "adxpansion.com",
        "trafficfactory.biz", "cdn4ads.com", "adcolony.com",
        "inmobi.com", "moloco.com", "applovin.com", "unityads.unity3d.com",
        "profitableratecpmnetwork.com", "xadsmart.com", "adexchangerapid.com",
        "protrafficinspector.com", "usrpubtrk.com", "luugy.com",
        "chatango.com", "st.chatango.com"
    ));

    // Patrones de URL típicos de anuncios/popunders independientemente del host.
    private static final java.util.regex.Pattern AD_PATH = java.util.regex.Pattern.compile(
        "(?:^|[/.-])(popads|popunder|popcash|onclick|adserver|adserver\\.|[/]ads[/]|ad\\.php|banner_ads|advert(?:isement)?[/._-])",
        java.util.regex.Pattern.CASE_INSENSITIVE);

    // Lista empaquetada (assets/ad_hosts.txt): ~3.5k dominios de ads/trackers
    // (base Peter Lowe — la misma fuente que usa uBlock Origin — más los hosts
    // de ads vistos en los embeds de DLive/tiestep). Se carga una vez.
    private static volatile java.util.Set<String> assetAdHosts = null;

    private java.util.Set<String> adHosts() {
        java.util.Set<String> s = assetAdHosts;
        if (s == null) {
            synchronized (ExoPlayerPlugin.class) {
                s = assetAdHosts;
                if (s == null) {
                    s = new java.util.HashSet<>(AD_HOSTS);
                    try {
                        java.io.BufferedReader r = new java.io.BufferedReader(
                            new java.io.InputStreamReader(
                                getContext().getAssets().open("ad_hosts.txt")));
                        String line;
                        while ((line = r.readLine()) != null) {
                            line = line.trim().toLowerCase(java.util.Locale.ROOT);
                            if (!line.isEmpty() && !line.startsWith("#")) s.add(line);
                        }
                        r.close();
                    } catch (Exception ignored) {}
                    assetAdHosts = s;
                }
            }
        }
        return s;
    }

    private boolean isAdRequest(String u) {
        if (u == null) return false;
        try {
            android.net.Uri uri = android.net.Uri.parse(u);
            String host = uri.getHost();
            if (host == null) return false;
            java.util.Set<String> hosts = adHosts();
            String h = host.toLowerCase(java.util.Locale.ROOT);
            if (h.startsWith("www.")) h = h.substring(4);
            if (hosts.contains(h)) return true;
            // Sufijos de dominio (subdominios de redes de ads)
            int dot = h.indexOf('.');
            while (dot > 0 && dot < h.length() - 1) {
                h = h.substring(dot + 1);
                if (hosts.contains(h)) return true;
                dot = h.indexOf('.');
            }
            if (AD_PATH.matcher(u).find()) return true;
        } catch (Exception ignored) {}
        return false;
    }

    private WebResourceResponse emptyAdResponse() {
        return new WebResourceResponse("text/plain", "utf-8",
            new java.io.ByteArrayInputStream(new byte[0]));
    }

    // Filtro cosmético + popup-killer inyectado en la página del embed:
    // neutraliza window.open/alert/confirm y elimina iframes y overlays de
    // anuncios. No toca <video> ni sus contenedores.
    private void injectAdBlocker(WebView view) {
        try {
            view.evaluateJavascript(
                "(function(){"
                + "try{window.open=function(){return null};"
                + "window.alert=function(){};window.confirm=function(){return true};"
                + "window.print=function(){};}catch(e){}"
                + "var AD=/popads|popcash|popunder|doubleclick|googlesyndication|adservice|adnxs|exoclick|juicyads|trafficjunky|tsyndicate|hilltopads|adsterra|admaven|onclick|outbrain|taboola|zedo|magsrv|runad|smartadserver|plugrush|adsco|propeller/i;"
                + "var kill=function(n){try{n.remove()}catch(e){}};"
                + "document.querySelectorAll('iframe').forEach(function(f){if(AD.test(f.src||''))kill(f)});"
                + "document.querySelectorAll('a[href]').forEach(function(a){var h=a.href||'';if(AD.test(h)&&!a.querySelector('video'))kill(a)});"
                + "document.querySelectorAll('.adsbygoogle,[id*=popunder],[class*=popunder],[id^=ad-],[class*=ad-banner],[data-ad],[id*=ad_overlay]').forEach(function(n){if(!n.querySelector('video')&&n.tagName!=='VIDEO')kill(n)});"
                + "if(!window.__octoAdBlock){window.__octoAdBlock=1;"
                + "new MutationObserver(function(ms){ms.forEach(function(m){m.addedNodes.forEach(function(n){"
                + "if(n.nodeType!==1)return;"
                + "if(n.tagName==='IFRAME'&&AD.test(n.src||''))kill(n);"
                + "if(n.matches&&n.matches('.adsbygoogle,[id*=popunder],[class*=popunder],[data-ad]')&&!n.querySelector('video'))kill(n);"
                + "})})}).observe(document.documentElement,{childList:true,subtree:true});}"
                + "return 1})()",
                null);
        } catch (Exception ignored) {}
    }

    // D-pad → movimiento del cursor virtual; al llegar al borde hace scroll
    // de la página en vez de salir de la pantalla.
    private void embedCursorMove(int dx, int dy, int repeat) {
        if (resolverWebView == null || embedCursor == null) return;
        float density = resolverWebView.getResources().getDisplayMetrics().density;
        int w = resolverWebView.getWidth(), h = resolverWebView.getHeight();
        // Paso por eje proporcional a la dimensión (~7%) + aceleración al
        // mantener pulsado hasta ~25% del eje. Atravesar la pantalla cuesta
        // ~14 pulsaciones cortas o ~4-5 manteniendo la tecla.
        float axis = dx != 0 ? w : h;
        float step = axis * 0.07f * (1f + repeat * 0.4f);
        float maxStep = axis * 0.25f;
        if (step > maxStep) step = maxStep;
        if (step < density * 45) step = density * 45;
        float nx = embedCursorX + dx * step;
        float ny = embedCursorY + dy * step;
        if (ny < 0) { resolverWebView.scrollBy(0, -(int) step); ny = 0; }
        else if (ny > h) { resolverWebView.scrollBy(0, (int) step); ny = h; }
        if (nx < 0) { resolverWebView.scrollBy(-(int) step, 0); nx = 0; }
        else if (nx > w) { resolverWebView.scrollBy((int) step, 0); nx = w; }
        embedCursorX = nx;
        embedCursorY = ny;
        embedCursor.setTranslationX(nx - embedCursor.getWidth() / 2f);
        embedCursor.setTranslationY(ny - embedCursor.getHeight() / 2f);
    }

    // OK del mando → toque real en la posición del cursor. Dispatch de
    // MotionEvent (no element.click()) porque los captchas viven en iframes
    // cross-origin que el JS de la página no puede tocar.
    private void embedCursorClick() {
        if (resolverWebView == null || embedCursor == null) return;
        long t = android.os.SystemClock.uptimeMillis();
        MotionEvent down = MotionEvent.obtain(t, t, MotionEvent.ACTION_DOWN, embedCursorX, embedCursorY, 0);
        MotionEvent up = MotionEvent.obtain(t, t + 60, MotionEvent.ACTION_UP, embedCursorX, embedCursorY, 0);
        resolverWebView.dispatchTouchEvent(down);
        resolverWebView.dispatchTouchEvent(up);
        down.recycle();
        up.recycle();
    }

    // Modo playback: la primera petición de media significa que el player
    // embebido arrancó — quitar el overlay de marca y avisar al JS.
    private void markEmbedPlaying(boolean[] mediaStarted) {
        if (mediaStarted[0]) return;
        mediaStarted[0] = true;
        mainHandler.post(() -> {
            Log.d(TAG, "Embed playback started in WebView");
            if (embedOverlay != null && embedOverlay.getParent() instanceof ViewGroup) {
                try { ((ViewGroup) embedOverlay.getParent()).removeView(embedOverlay); } catch (Exception ignored) {}
                embedOverlay = null;
            }
            notifyState("embed_webview_playing", null);
        });
    }

    // ─── Relay local: fetch con origen del embed → HTTP para ExoPlayer ───
    // Ciertos CDN (tiestep) solo sirven el m3u8/segmentos a peticiones cuyo
    // origen es la propia página del embed y con stack TLS de Chromium. El
    // relay carga un documento stub en ese origen dentro de un WebView oculto
    // y sirve los bytes a ExoPlayer vía http://127.0.0.1:puerto/relay?u=<b64>.
    private WebView relayWebView = null;
    private java.net.ServerSocket relayServer = null;
    private Thread relayAcceptThread = null;
    private int relayPort = 0;
    private volatile boolean relayReady = false;
    // Token por sesión del relay: sin él cualquier página embebida (o proceso
    // local) podría usar /relay?u= de proxy abierto hacia hosts de la LAN.
    private volatile String relayToken = null;
    // openPlayer() llama internamente a closePlayer() → stopEmbedRelay(); este
    // flag protege el relay durante ese openPlayer que precisamente lo usa.
    private boolean relayKeepAlive = false;
    private final java.util.Map<String, java.io.OutputStream> relaySinks =
            new java.util.concurrent.ConcurrentHashMap<>();
    private final java.util.Set<String> relayBegun =
            java.util.concurrent.ConcurrentHashMap.newKeySet();

    private void stopEmbedRelay() {
        if (relayKeepAlive) return;
        relayReady = false;
        relayToken = null;
        relaySinks.clear();
        relayBegun.clear();
        if (relayServer != null) {
            try { relayServer.close(); } catch (Exception ignored) {}
            relayServer = null;
        }
        relayAcceptThread = null;
        if (relayWebView != null) {
            final WebView wv = relayWebView;
            relayWebView = null;
            mainHandler.post(() -> {
                try {
                    wv.stopLoading();
                    ViewGroup p = (ViewGroup) wv.getParent();
                    if (p != null) p.removeView(wv);
                    wv.destroy();
                } catch (Exception ignored) {}
            });
        }
    }

    private void startEmbedRelay(String originUrl, Runnable onReady) {
        stopEmbedRelay();
        try {
            relayServer = new java.net.ServerSocket(0, 50,
                    java.net.InetAddress.getByName("127.0.0.1"));
            relayPort = relayServer.getLocalPort();
            relayToken = java.util.UUID.randomUUID().toString();
        } catch (Exception e) {
            Log.e(TAG, "startEmbedRelay bind failed: " + e);
            return;
        }
        final java.net.ServerSocket srv = relayServer;
        relayAcceptThread = new Thread(() -> {
            try {
                while (!srv.isClosed()) {
                    final java.net.Socket sock = srv.accept();
                    new Thread(() -> handleRelaySocket(sock), "relay-io").start();
                }
            } catch (Exception ignored) {}
        }, "embed-relay");
        relayAcceptThread.start();

        Context context = getContext();
        relayWebView = new WebView(context);
        relayWebView.setAlpha(0.01f);
        ViewGroup decor = (ViewGroup) getActivity().getWindow().getDecorView().getRootView();
        decor.addView(relayWebView, new FrameLayout.LayoutParams(1, 1));
        WebSettings s = relayWebView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUserAgentString("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        relayWebView.addJavascriptInterface(new Object() {
            @android.webkit.JavascriptInterface
            public void relayData(String reqId, String b64, String mime) {
                java.io.OutputStream out = relaySinks.remove(reqId);
                if (out == null) { Log.w(TAG, "relayData: unknown reqId"); return; }
                try {
                    byte[] bytes = android.util.Base64.decode(b64, android.util.Base64.DEFAULT);
                    Log.d(TAG, "relayData: " + bytes.length + "B mime=" + mime);
                    String hdr = "HTTP/1.1 200 OK\r\nContent-Type: "
                            + (mime != null && !mime.isEmpty() ? mime : "application/octet-stream")
                            + "\r\nContent-Length: " + bytes.length + "\r\nConnection: close\r\n\r\n";
                    out.write(hdr.getBytes("ISO-8859-1"));
                    out.write(bytes);
                    out.flush();
                    out.close();
                } catch (Exception e) {
                    Log.e(TAG, "relayData write error: " + e);
                    try { out.close(); } catch (Exception ignored) {}
                }
            }
            // Entrega por streaming: el fetch del WebView va mandando chunks
            // según llegan (getReader) en vez de esperar al segmento entero.
            // Sin esto, un .ts de ~3MB tardaba >10s en verse (fetch + base64
            // completo en JS) y ExoPlayer abortaba el socket → reset storm.
            @android.webkit.JavascriptInterface
            public void relayBegin(String reqId, String mime, String clen) {
                java.io.OutputStream out = relaySinks.get(reqId);
                if (out == null) { Log.w(TAG, "relayBegin: unknown reqId"); return; }
                relayBegun.add(reqId);
                try {
                    String hdr = "HTTP/1.1 200 OK\r\nContent-Type: "
                            + (mime != null && !mime.isEmpty() ? mime : "application/octet-stream")
                            + (clen != null && !clen.isEmpty()
                                    ? "\r\nContent-Length: " + clen : "")
                            + "\r\nConnection: close\r\n\r\n";
                    out.write(hdr.getBytes("ISO-8859-1"));
                    out.flush();
                } catch (Exception e) {
                    relayBegun.remove(reqId);
                    relaySinks.remove(reqId);
                    try { out.close(); } catch (Exception ignored) {}
                    throw new RuntimeException("relayBegin write: " + e);
                }
            }
            @android.webkit.JavascriptInterface
            public void relayChunk(String reqId, String b64) {
                java.io.OutputStream out = relaySinks.get(reqId);
                if (out == null) throw new RuntimeException("relayChunk: closed");
                try {
                    byte[] bytes = android.util.Base64.decode(b64, android.util.Base64.DEFAULT);
                    out.write(bytes);
                    out.flush();
                } catch (Exception e) {
                    relayBegun.remove(reqId);
                    relaySinks.remove(reqId);
                    try { out.close(); } catch (Exception ignored) {}
                    throw new RuntimeException("relayChunk write: " + e);
                }
            }
            @android.webkit.JavascriptInterface
            public void relayEnd(String reqId) {
                relayBegun.remove(reqId);
                java.io.OutputStream out = relaySinks.remove(reqId);
                if (out == null) return;
                try { out.close(); } catch (Exception ignored) {}
            }
            @android.webkit.JavascriptInterface
            public void relayFail(String reqId, String msg) {
                Log.w(TAG, "relayFail: " + msg);
                boolean begun = relayBegun.remove(reqId);
                java.io.OutputStream out = relaySinks.remove(reqId);
                if (out == null) return;
                try {
                    if (!begun) {
                        byte[] e = "relay fetch failed".getBytes("utf-8");
                        out.write(("HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\n"
                                + "Content-Length: " + e.length + "\r\nConnection: close\r\n\r\n")
                                .getBytes("ISO-8859-1"));
                        out.write(e);
                        out.flush();
                    }
                    out.close();
                } catch (Exception ignored) {}
            }
        }, "AndroidRelay");

        relayWebView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                return true; // el documento stub nunca navega
            }
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                if (r.isForMainFrame()) {
                    String stub = "<html><body>relay</body></html>";
                    return new WebResourceResponse("text/html", "utf-8",
                            new java.io.ByteArrayInputStream(stub.getBytes()));
                }
                return null;
            }
            @Override
            public void onPageFinished(WebView v, String url) {
                relayReady = true;
                if (onReady != null) onReady.run();
            }
        });
        relayWebView.loadUrl(originUrl);
    }

    private void handleRelaySocket(java.net.Socket sock) {
        try {
            sock.setSoTimeout(45000);
            // Drenar la petición completa (request line + headers hasta la línea
            // vacía). Cerrar el socket con bytes sin leer provoca un TCP RST que
            // el cliente ve como "Connection reset" a mitad del cuerpo.
            java.io.InputStream in = sock.getInputStream();
            StringBuilder sb = new StringBuilder();
            int c;
            int matched = 0; // estado para detectar "\r\n\r\n"
            while ((c = in.read()) >= 0) {
                if (sb.length() < 8192) sb.append((char) c);
                if (c == '\r' || c == '\n') {
                    matched++;
                    if (matched >= 4) break;
                } else {
                    matched = 0;
                }
            }
            java.util.regex.Matcher m = java.util.regex.Pattern
                    .compile("GET /relay\\?u=([^\\s&]+)")
                    .matcher(sb.toString());
            if (!m.find()) { sock.close(); return; }
            // Token obligatorio: peticiones sin él (páginas ajenas que hayan
            // visto el puerto) se cierran antes de hacer fetch alguno.
            java.util.regex.Matcher km = java.util.regex.Pattern
                    .compile("[?&]k=([^\\s&]+)")
                    .matcher(sb.toString());
            String tok = relayToken;
            if (tok == null || !km.find() || !tok.equals(km.group(1))) {
                sock.close();
                return;
            }
            String b64url = java.net.URLDecoder.decode(m.group(1), "utf-8");
            String target = new String(android.util.Base64.decode(b64url,
                    android.util.Base64.URL_SAFE | android.util.Base64.NO_WRAP
                            | android.util.Base64.NO_PADDING), "utf-8");
            if (!target.startsWith("http://") && !target.startsWith("https://")) {
                sock.close();
                return;
            }
            Log.d(TAG, "relay req: " + hostOf(target) + (target.contains(".m3u8") ? " playlist" : " seg"));
            final String reqId = java.util.UUID.randomUUID().toString();
            relaySinks.put(reqId, sock.getOutputStream());
            final String reqIdF = reqId;
            final String targetF = target;
            mainHandler.post(() -> {
                WebView wv = relayWebView;
                if (wv == null) { relaySinks.remove(reqIdF); return; }
                // fetch dentro del origen del embed. Si la respuesta parece un
                // playlist se reescriben las URIs a este relay; si viene en
                // base64 (algunos CDN ofuscan el playlist) se decodifica.
                String js = "(function(){var T=" + org.json.JSONObject.quote(targetF)
                        + ",P=" + relayPort + ",K=" + org.json.JSONObject.quote(relayToken != null ? relayToken : "")
                        + ",R='" + reqIdF + "';"
                        + "fetch(T).then(function(r){var ct=r.headers.get('content-type')||'';"
                        + "var isList=/mpegurl|m3u8/i.test(ct)||/\\.m3u8(\\?|$)/i.test(T);"
                        + "if(isList){return r.text().then(function(t){"
                        + "if(t.indexOf('#EXT')<0){try{t=atob(t.replace(/\\s/g,''))}catch(e){}}"
                        + "var lines=t.split(/\\r?\\n/).map(function(l){"
                        + "var mm=l.match(/URI=\"([^\"]+)\"/);"
                        + "if(mm){l=l.replace(mm[1],'http://127.0.0.1:'+P+'/relay?u='+btoa(new URL(mm[1],T).href).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'')+'&k='+K);}"
                        + "else if(l.length&&l.charAt(0)!=='#'){l='http://127.0.0.1:'+P+'/relay?u='+btoa(new URL(l,T).href).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'')+'&k='+K;}"
                        + "return l;});"
                        + "AndroidRelay.relayData(R,btoa(lines.join('\\n')),'application/vnd.apple.mpegurl');"
                        + "});}"
                        + "var cl=r.headers.get('content-length')||'';"
                        + "if(r.body&&r.body.getReader){var rd=r.body.getReader();"
                        + "AndroidRelay.relayBegin(R,ct||'video/mp2t',cl);"
                        + "var pump=function(){rd.read().then(function(x){"
                        + "if(x.done){AndroidRelay.relayEnd(R);return;}"
                        + "var u8=x.value,bin='';"
                        + "for(var i=0;i<u8.length;i+=8192){bin+=String.fromCharCode.apply(null,u8.subarray(i,i+8192));}"
                        + "AndroidRelay.relayChunk(R,btoa(bin));pump();"
                        + "}).catch(function(e){try{rd.cancel()}catch(_){}AndroidRelay.relayFail(R,''+e);});};pump();return;}"
                        + "return r.arrayBuffer().then(function(b){var u8=new Uint8Array(b),bin='';"
                        + "for(var i=0;i<u8.length;i+=32768){bin+=String.fromCharCode.apply(null,u8.subarray(i,i+32768));}"
                        + "AndroidRelay.relayData(R,btoa(bin),ct||'video/mp2t');});"
                        + "}).catch(function(e){AndroidRelay.relayFail(R,''+e);});})()";
                wv.evaluateJavascript(js, null);
            });
        } catch (Exception e) {
            try { sock.close(); } catch (Exception ignored) {}
        }
    }

    private String relayUrlFor(String mediaUrl) {
        if (relayPort <= 0) return null;
        String b64 = android.util.Base64.encodeToString(mediaUrl.getBytes(),
                android.util.Base64.URL_SAFE | android.util.Base64.NO_WRAP
                        | android.util.Base64.NO_PADDING);
        return "http://127.0.0.1:" + relayPort + "/relay?u=" + b64 + "&k=" + relayToken;
    }

    private static String originOf(String url) {
        try {
            android.net.Uri u = android.net.Uri.parse(url);
            if (u == null || u.getHost() == null) return null;
            return u.getScheme() + "://" + u.getHost() + "/__relay__";
        } catch (Exception e) {
            return null;
        }
    }

    private static boolean isLoopbackUrl(String url) {
        if (url == null) return false;
        return url.startsWith("http://127.0.0.1") || url.startsWith("https://127.0.0.1")
                || url.startsWith("http://localhost") || url.startsWith("https://localhost");
    }

    // Modo playback: expandir el iframe del player a pantalla completa y
    // sacar a pantalla completa cualquier <video> del documento principal.
    // El player embebido queda dentro de un iframe cross-origin — no se puede
    // tocar su DOM, pero llenando el iframe el vídeo ocupa toda la pantalla.
    private void injectPlaybackHelper(WebView view) {
        String js = "javascript:(function(){"
            + "if(window.__pvInit)return;window.__pvInit=1;"
            + "var st=document.createElement('style');st.textContent='"
            + "body{background:#000!important;margin:0!important;padding:0!important}"
            + "iframe[src*=ad],iframe[src*=pop],iframe[src*=banner],iframe[src*=click],"
            + "iframe[src*=traffic],iframe[src*=sponsor],iframe[src*=promo],"
            + "iframe[src*=exoclick],iframe[src*=juicyads],iframe[src*=doubleclick],"
            + "iframe[src*=googlesyndication],ins.adsbygoogle{display:none!important}';"
            + "(document.head||document.documentElement).appendChild(st);"
            + "function expand(){"
            + "  var v=document.querySelector('video');"
            + "  if(v){v.style.cssText='position:fixed!important;top:0!important;left:0!important;"
            + "width:100vw!important;height:100vh!important;z-index:2147483647!important;"
            + "background:#000!important;object-fit:contain!important';"
            + "    try{var pr=v.play();if(pr&&pr.catch)pr.catch(function(){});}catch(e){}"
            + "    if(v.currentTime>0||(!v.paused&&v.readyState>=3)){"
            + "      try{AndroidVideoResolver.onPlaybackStarted()}catch(e){}}}"
            + "  var best=null,ba=0,fs=document.querySelectorAll('iframe');"
            + "  for(var i=0;i<fs.length;i++){var f=fs[i],s=f.src||'';"
            + "    if(!/^https?:/.test(s))continue;"
            + "    if(/ads?|banner|pop|click|traffic|sponsor|promo|doubleclick|googlesyndication|exoclick|juicyads/i.test(s))continue;"
            + "    var r=f.getBoundingClientRect(),a=r.width*r.height;if(a>ba){ba=a;best=f}}"
            + "  if(best){best.style.cssText='position:fixed!important;top:0!important;left:0!important;"
            + "width:100vw!important;height:100vh!important;z-index:2147483646!important;"
            + "border:0!important;background:#000!important';}"
            + "}"
            + "expand();setInterval(expand,1500);"
            + "})();";
        view.evaluateJavascript(js, null);
    }

    private void checkVideoUrl(String url, boolean[] resolved, PluginCall call, String title) {
        if (url == null || url.isEmpty() || resolved[0]) return;
        if (!isVideoUrl(url)) return;
        resolved[0] = true;
        Log.d(TAG, "Embed resolved (intercept): " + hostOf(url));
        String st = getStreamType(url);
        // Extract cookies from the WebView for the video URL's domain
        try {
            embedCookies = android.webkit.CookieManager.getInstance().getCookie(url);
            if (embedCookies != null && !embedCookies.isEmpty()) {
                Log.d(TAG, "Embed cookies extracted: " + embedCookies.length() + " chars");
            }
        } catch (Exception ignored) {}
        JSObject notify = new JSObject();
        notify.put("state", "embed_resolved");
        notify.put("url", url);
        notify.put("streamType", st);
        notifyListeners("playbackState", notify);
        JSObject result = new JSObject();
        result.put("status", "resolved");
        result.put("url", url);
        result.put("streamType", st);
        call.resolve(result);
        mainHandler.post(() -> {
            if (embedDialog != null) {
                try { embedDialog.dismiss(); } catch (Exception ignored) {}
                embedDialog = null;
            }
            String ref = embedReferer;
            String cookies = embedCookies;
            cleanupResolver();
            JSObject headers = new JSObject();
            headers.put("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
            if (ref != null && !ref.isEmpty()) {
                String origin = ref;
                try {
                    java.net.URL u = new java.net.URL(ref);
                    origin = u.getProtocol() + "://" + u.getHost();
                } catch (Exception ignored) {}
                headers.put("Referer", origin + "/");
                headers.put("Origin", origin);
            }
            // Pass cookies from WebView to ExoPlayer
            if (cookies != null && !cookies.isEmpty()) {
                headers.put("Cookie", cookies);
            }
            openPlayer(url, st, false, null, headers, new JSObject(), title, "vod", null, -1, null, null, 0, 0, null, "", 0, 0, null, -1);
        });
    }

    private void injectVideoDetector(WebView view) {
        // CSS: black background, hide everything
        String css = "javascript:(function(){" +
            "var style=document.getElementById('adblock-style');" +
            "if(style)return;" +
            "style=document.createElement('style');" +
            "style.id='adblock-style';" +
            "style.textContent='" +
            "body{background:#000 !important;margin:0 !important;padding:0 !important;}" +
            // Hide ads by URL/class patterns
            "iframe[src*=ad],iframe[src*=pop],iframe[src*=banner],iframe[src*=click]," +
            "iframe[src*=traffic],iframe[src*=sponsor],iframe[src*=promo]," +
            "iframe[src*=exoclick],iframe[src*=juicyads],iframe[src*=trafficjunky]," +
            "iframe[src*=doubleclick],iframe[src*=googlesyndication]," +
            "ins.adsbygoogle,div[id*=google_ads],div[class*=google_ads]," +
            "a[href*=porn],a[href*=xxx],a[href*=adult],a[href*=sex]," +
            "[class*=exoclick],[class*=juicyads],[class*=trafficjunky]," +
            "[id*=exoclick],[id*=juicyads],[id*=trafficjunky]," +
            "[style*=z-index:2147483647],[style*=z-index: 2147483647]" +
            "{display:none !important;}" +
            "';" +
            "document.head.appendChild(style);" +
            "})();";

        // JS: find captcha and play button, move them to a clean overlay, hide everything else
        String js = "javascript:(function(){" +
            // Create a clean overlay container
            "if(document.getElementById('resolver-overlay'))return;" +
            "var overlay=document.createElement('div');" +
            "overlay.id='resolver-overlay';" +
            "overlay.style.cssText='position:fixed !important;top:0 !important;left:0 !important;" +
            "width:100% !important;height:100% !important;background:#000 !important;" +
            "z-index:2147483646 !important;display:flex !important;flex-direction:column !important;" +
            "align-items:center !important;justify-content:center !important;gap:20px !important;" +
            "padding:20px !important;box-sizing:border-box !important;';" +
            "document.body.appendChild(overlay);" +
            // Function to scan for captcha and play elements
            "function scanForElements(){" +
            // ALTCHA is proof-of-work — clicking its shadow checkbox starts the
            // solver and the page auto-submits. No user interaction needed.
            "  try{var aw=document.querySelector('altcha-widget');" +
            "  if(aw&&aw.shadowRoot){var acb=aw.shadowRoot.querySelector('input[type=checkbox],input,button');" +
            "  if(acb&&!acb.checked&&!acb.disabled)acb.click();}}catch(e){}" +
            "  // Find captcha: altcha, recaptcha, hcaptcha, or any iframe with captcha" +
            "  var captcha=null;" +
            "  // altcha-widget (VOE uses this)" +
            "  captcha=document.querySelector('altcha-widget,altcha,#altcha,.altcha');" +
            "  if(captcha&&captcha.tagName&&captcha.tagName.toLowerCase().indexOf('altcha')===0)captcha=null;" +
            "  if(!captcha)captcha=document.querySelector('iframe[src*=captcha],iframe[src*=recaptcha],iframe[src*=hcaptcha]');" +
            "  if(!captcha)captcha=document.querySelector('.g-recaptcha,#recaptcha,.h-captcha,#h-captcha');" +
            "  if(!captcha)captcha=document.querySelector('[class*=captcha],[id*=captcha]');" +
            "  if(captcha&&captcha.tagName&&captcha.tagName.toLowerCase().indexOf('altcha')===0)captcha=null;" +
            "  if(!captcha)captcha=document.querySelector('form[action*=access],form[action*=verify],form[action*=check]');" +
            // Find play button
            "  var playBtn=null;" +
            "  var btns=document.querySelectorAll('button,input[type=submit],a.btn,a.play,button.play,[class*=play],[id*=play]');" +
            "  for(var i=0;i<btns.length;i++){" +
            "    var b=btns[i];" +
            "    var txt=(b.textContent||b.value||b.title||'').toLowerCase();" +
            "    if(txt.indexOf('play')>-1||txt.indexOf('reproducir')>-1||txt.indexOf('ver')>-1||" +
            "       txt.indexOf('start')>-1||txt.indexOf('continue')>-1||txt.indexOf('confirm')>-1||" +
            "       b.type==='submit'){" +
            "      playBtn=b;break;" +
            "    }" +
            "  }" +
            // Find any visible video element (not placeholder)
            "  var video=document.querySelector('video');" +
            // If we found captcha or play button, add to overlay
            "  if(captcha&&!document.getElementById('overlay-captcha')){" +
            "    var c=captcha.cloneNode(true);" +
            "    c.id='overlay-captcha';" +
            "    c.style.cssText='display:block !important;visibility:visible !important;opacity:1 !important;';" +
            "    overlay.appendChild(c);" +
            "    // Also move the original to keep it functional" +
            "    captcha.id='original-captcha';" +
            "  }" +
            "  if(playBtn&&!document.getElementById('overlay-play')){" +
            "    var p=playBtn.cloneNode(true);" +
            "    p.id='overlay-play';" +
            "    p.style.cssText='display:block !important;visibility:visible !important;opacity:1 !important;" +
            "    padding:15px 40px !important;font-size:18px !important;cursor:pointer !important;" +
            "    background:#e50914 !important;color:#fff !important;border:none !important;" +
            "    border-radius:8px !important;';" +
            "    p.onclick=function(){playBtn.click();};" +
            "    overlay.appendChild(p);" +
            "  }" +
            // If video found and has src, notify
            "  if(video&&video.src&&video.src.indexOf('blob:')===-1){" +
            "    window.AndroidVideoResolver.onVideoFound(video.src);" +
            "  }" +
            "  // Check video sources" +
            "  var sources=document.querySelectorAll('video source');" +
            "  for(var j=0;j<sources.length;j++){" +
            "    if(sources[j].src)window.AndroidVideoResolver.onVideoFound(sources[j].src);" +
            "  }" +
            "}" +
            "scanForElements();" +
            "setInterval(scanForElements,2000);" +
            // Also check scripts for video URLs
            "var scripts=document.getElementsByTagName('script');" +
            "for(var i=0;i<scripts.length;i++){" +
            "  var s=scripts[i].textContent||'';" +
            "  var m=s.match(/https?:\\/\\/[^\"'\\s<>]+\\.(?:m3u8|mp4|mkv)[^\"'\\s<>]*/i);" +
            "  if(m&&m[0]) window.AndroidVideoResolver.onVideoFound(m[0]);" +
            "}" +
            // VOE decode: <script type="application/json"> with encoded payload
            // and var a168c='...' pattern. Decodes ROT13 + junk removal + base64 + shift + reverse base64.
            "function voeRot13(s){return s.split('').map(function(c){var x=c.charCodeAt(0);" +
            "if(x>=65&&x<=90)x=(x-65+13)%26+65;else if(x>=97&&x<=122)x=(x-97+13)%26+97;return String.fromCharCode(x);}).join('');}" +
            "function voeDecode(enc){try{" +
            "  var junk=['@$','^^','~@','%?','*~','!!','#&'];" +
            "  var s=voeRot13(enc);" +
            "  for(var i=0;i<junk.length;i++)s=s.split(junk[i]).join('_');" +
            "  s=s.replace(/_/g,'');" +
            "  s=atob(s);" +
            "  s=s.split('').map(function(c){return String.fromCharCode(c.charCodeAt(0)-3);}).join('');" +
            "  s=atob(s.split('').reverse().join(''));" +
            "  var d=JSON.parse(s);" +
            "  return d.source||d.file||d.direct_access_url||'';" +
            "}catch(e){return '';}}" +
            "var jsonScripts=document.querySelectorAll('script[type=\"application/json\"]');" +
            "for(var i=0;i<jsonScripts.length;i++){" +
            "  var enc=jsonScripts[i].textContent.trim();" +
            "  if(enc.startsWith('\"'))enc=enc.slice(1,-1);" +
            "  var src=voeDecode(enc);" +
            "  if(src)window.AndroidVideoResolver.onVideoFound(src);" +
            "}" +
            "var a168=document.querySelector('script:not([type])');" +
            "if(a168){var m=a168.textContent.match(/var\\s+a168c\\s*=\\s*['\"]([^'\"]+)['\"]/);" +
            "  if(m){var src=voeDecode(m[1]);if(src)window.AndroidVideoResolver.onVideoFound(src);}}" +
            // Override fetch/XHR
            "var origFetch=window.fetch;" +
            "window.fetch=function(u,o){" +
            "  if(typeof u==='string'&&(u.indexOf('.m3u8')>-1||u.indexOf('.mp4')>-1))" +
            "    window.AndroidVideoResolver.onVideoFound(u);" +
            "  return origFetch.apply(this,arguments);" +
            "};" +
            "var origOpen=XMLHttpRequest.prototype.open;" +
            "XMLHttpRequest.prototype.open=function(m,u){" +
            "  if(u&&(u.indexOf('.m3u8')>-1||u.indexOf('.mp4')>-1))" +
            "    window.AndroidVideoResolver.onVideoFound(u);" +
            "  return origOpen.apply(this,arguments);" +
            "};" +
            // Override video.src setter
            "try{" +
            "  var origSet=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'src').set;" +
            "  Object.defineProperty(HTMLMediaElement.prototype,'src',{" +
            "    set:function(v){origSet.call(this,v);if(v&&v.indexOf('blob:')===-1&&v.length>0)" +
            "      window.AndroidVideoResolver.onVideoFound(v);}," +
            "    get:function(){return origGet?origGet.call(this):'';}," +
            "    configurable:true" +
            "  });" +
            "  var origGet=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'src').get;" +
            "}catch(e){}" +
            "})();";
        view.evaluateJavascript(css, null);
        view.evaluateJavascript(js, null);
        // VOE encoded source decoder (AniWorld-Downloader port) - separate injection
        String voeJs = "(function(){" +
            "function voeRot13(s){var o='';for(var i=0;i<s.length;i++){var c=s.charCodeAt(i);if(c>=65&&c<=90)c=(c-65+13)%26+65;else if(c>=97&&c<=122)c=(c-97+13)%26+97;o+=String.fromCharCode(c);}return o;}" +
            "function voeB64(s){while(s.length%4)s+='=';try{return atob(s);}catch(e){return '';}}" +
            "function voeShiftBack(s,n){var o='';for(var i=0;i<s.length;i++){o+=String.fromCharCode(s.charCodeAt(i)-n);}return o;}" +
            "function voeIsBait(u){if(!u)return false;var l=u.toLowerCase();return l.indexOf('test-videos')>-1||l.indexOf('big_buck_bunny')>-1||l.indexOf('sample-videos')>-1||l.indexOf('example.com')>-1||l.indexOf('testvideo')>-1||l.indexOf('buckbunny')>-1;}" +
            "function voeDecodeString(enc){var s1=voeRot13(enc);var s2=s1;['@$','^^','~@','%?','*~','!!','#&'].forEach(function(p){s2=s2.split(p).join('_');});s2=s2.replace(/_/g,'');var s3=voeB64(s2);var s4=voeShiftBack(s3,3);var s5=voeB64(s4.split('').reverse().join(''));return JSON.parse(s5);}" +
            "function voeExtractSource(){" +
            "  var html=document.documentElement.outerHTML;" +
            // Method 1: JSON script + voe decode (AniWorld approach)
            "  var blocks=html.match(/<script[^>]*type=[\"']application\\/json[\"'][^>]*>[\\s\\S]*?<\\/script>/g)||[];" +
            "  for(var i=0;i<blocks.length;i++){" +
            "    var raw=blocks[i].replace(/<script[^>]*>/,'').replace(/<\\/script>/,'').trim();" +
            "    try{var decStr=JSON.parse(raw);if(typeof decStr==='string'){var dec=voeDecodeString(decStr);if(dec){console.log('[VoeDecode] source='+(dec.source||'none')+' hls='+(dec.hls||'none')+' file='+(dec.file||'none'));if(dec.source&&!voeIsBait(dec.source))return dec.source;if(dec.hls&&!voeIsBait(dec.hls))return dec.hls;if(dec.file&&!voeIsBait(dec.file))return dec.file;}}}catch(e){console.log('[VoeDecode] error: '+e.message);}" +
            "  }" +
            // Method 2: var a168c (voe-dl method6)
            "  var m=html.match(/var a168c=([^;]+)/);if(m){try{var dec=voeDecodeString(m[1]);if(dec&&dec.source&&!voeIsBait(dec.source))return dec.source;}catch(e){}}" +
            // Method 3: HLS field - not bait
            "  var m2=html.match(/hls[^a-zA-Z]*['\"]([^'\"]+\\.m3u8[^'\"]*)['\"]/);if(m2&&!voeIsBait(m2[1]))return m2[1];" +
            // Method 4: video/source tags - not bait
            "  var vids=document.querySelectorAll('video source,video[src],source[src]');for(var v=0;v<vids.length;v++){var s=vids[v].src||vids[v].getAttribute('src');if(s&&/m3u8|mp4/i.test(s)&&!voeIsBait(s))return s;}" +
            // Method 5: direct mp4/hls patterns - not bait
            "  var m3=html.match(/(?:mp4|hls)['\"]?\\s*:\\s*['\"]([^'\"]+)/);if(m3&&/^https?:/.test(m3[1])&&!voeIsBait(m3[1]))return m3[1];" +
            // Method 6: base64 encoded URL - not bait
            "  var m4=html.match(/['\"](eyJ[A-Za-z0-9+/=]+)['\"]/);if(m4){try{var dec=atob(m4[1]);if(/^https?:/.test(dec)&&/m3u8|mp4/i.test(dec)&&!voeIsBait(dec))return dec;}catch(e){}}" +
            // Method 7: any m3u8 URL - not bait
            "  var m5=html.match(/(https?:\\/\\/[^'\"\\s]+\\.m3u8[^'\"\\s]*)/);if(m5&&!voeIsBait(m5[1]))return m5[1];" +
            // Method 8: any mp4 URL - not bait
            "  var m6=html.match(/(https?:\\/\\/[^'\"\\s]+\\.mp4[^'\"\\s]*)/);if(m6&&!voeIsBait(m6[1]))return m6[1];" +
            "  return null;" +
            "}" +
            "function voeScan(){" +
            "  var html=document.documentElement.outerHTML;" +
            "  var src=voeExtractSource();" +
            "  var hasJson=html.indexOf('application/json')>-1;" +
            "  var hasM3u8=html.indexOf('m3u8')>-1;" +
            "  var hasAltcha=html.indexOf('altcha')>-1;" +
            "  var hasIframe=html.indexOf('iframe')>-1;" +
            "  var hasVideo=html.indexOf('video')>-1;" +
            "  var ifrSrc='';var ifr=document.querySelector('iframe');if(ifr)ifrSrc=ifr.src||'';" +
            "  var smallHtml='';if(html.length<2000)smallHtml=html.substring(0,500);" +
            "  console.log('[VoeScan] len='+html.length+' src='+(src?src.substring(0,80):'none')+' json='+hasJson+' m3u8='+hasM3u8+' altcha='+hasAltcha+' iframe='+hasIframe+' video='+hasVideo+' ifrSrc='+ifrSrc+' html='+smallHtml);" +
            // Follow iframe if page is small and has no video source (voe-dl approach)
            "  if(ifrSrc&&html.length<3000&&!src&&!hasM3u8&&window._iframeFollowed!==ifrSrc){" +
            "    window._iframeFollowed=ifrSrc;" +
            "    console.log('[VoeIframe] following iframe to: '+ifrSrc);" +
            "    window.location.href=ifrSrc;" +
            "  }" +
            "  if(html.length>0&&window._voeLogged!==true){window._voeLogged=true;var body=document.body?document.body.innerHTML.substring(0,800):'nobody';console.log('[VoeBody] '+body);var scripts=document.querySelectorAll('script');var si='';for(var k=0;k<scripts.length&&si.length<500;k++){si+=scripts[k].src+'|'+scripts[k].textContent.substring(0,100)+'||';}console.log('[VoeScripts] '+si);var forms=document.querySelectorAll('form');console.log('[VoeForms] count='+forms.length);for(var f=0;f<forms.length;f++){console.log('[VoeForm'+f+'] action='+forms[f].action+' method='+forms[f].method+' html='+forms[f].outerHTML.substring(0,300));}var btns=document.querySelectorAll('button,input[type=submit],a.btn,a.button');console.log('[VoeBtns] count='+btns.length);for(var b=0;b<btns.length;b++){console.log('[VoeBtn'+b+'] '+btns[b].outerHTML.substring(0,200));}}" +
            // Check ALTCHA state and auto-submit when verified
            "  if(hasAltcha){" +
            "    var aw=document.querySelector('altcha-widget');" +
            "    if(aw&&window._altchaSolving!==true){" +
            "      window._altchaSolving=true;" +
            "      var challengeUrl=aw.getAttribute('challenge');" +
            "      console.log('[VoeAltcha] starting manual solve, challengeUrl='+challengeUrl);" +
            // Click checkbox to trigger widget
            "      var cb=document.querySelector('.altcha input[type=checkbox],input[type=checkbox]');if(cb){console.log('[VoeAltcha] clicking checkbox');cb.click();}" +
            // Manual ALTCHA solver: fetch challenge, compute POW, fill input, submit
            "      if(challengeUrl){" +
            "        fetch(challengeUrl).then(function(r){return r.json();}).then(function(ch){" +
            "          console.log('[VoeAltcha] challenge received: alg='+ch.algorithm+' max='+ch.maxnumber+' salt='+(ch.salt||'').substring(0,20)+' challenge='+(ch.challenge||'').substring(0,20));" +
            "          var salt=ch.salt||'';var challenge=ch.challenge||'';var maxn=ch.maxnumber||1000000;var alg=ch.algorithm||'SHA-256';" +
            "          function hex(b){var h='';var bytes=new Uint8Array(b);for(var i=0;i<bytes.length;i++){h+=('00'+bytes[i].toString(16)).slice(-2);}return h;}" +
            "          function trySolve(n){" +
            "            if(n>maxn){console.log('[VoeAltcha] no solution found in '+maxn+' tries');return Promise.reject('no solution');}" +
            "            var data=new TextEncoder().encode(salt+n);" +
            "            return crypto.subtle.digest(alg,data).then(function(hash){" +
            "              var h=hex(hash);" +
            "              if(h.indexOf(challenge)===0){" +
            "                var solution={algorithm:alg,challenge:challenge,number:n,salt:salt,signature:ch.signature||''};" +
            "                var encoded=btoa(JSON.stringify(solution));" +
            "                var altchaInput=document.querySelector('input[name=altcha]');" +
            "                if(altchaInput){altchaInput.value=encoded;}" +
            "                console.log('[VoeAltcha] SOLVED! nonce='+n+' hash='+h.substring(0,20)+'...');" +
            "                if(window._formSubmitted!==true){" +
            "                  window._formSubmitted=true;" +
            "                  console.log('[VoeAltcha] submitting form with solution');" +
            "                  var f=document.querySelector('form.access-form,form');if(f)f.submit();" +
            "                }" +
            "                return true;" +
            "              }" +
            "              if(n%10000===0)console.log('[VoeAltcha] trying n='+n+' hash='+h.substring(0,20));" +
            "              return trySolve(n+1);" +
            "            });" +
            "          }" +
            "          trySolve(0).catch(function(e){console.log('[VoeAltcha] solve error: '+e);});" +
            "        }).catch(function(e){console.log('[VoeAltcha] fetch challenge error: '+e);});" +
            "      }" +
            "    }" +
            // Also check if altcha got a value from the widget itself
            "    var altchaInput=document.querySelector('input[name=altcha]');" +
            "    if(altchaInput&&altchaInput.value&&altchaInput.value.length>10&&window._formSubmitted!==true){" +
            "      window._formSubmitted=true;console.log('[VoeSubmit] altcha has value, submitting');" +
            "      var f=document.querySelector('form.access-form,form');if(f)f.submit();" +
            "    }" +
            "  }" +
            "  if(src)window.AndroidVideoResolver.onVideoFound(src);" +
            "}" +
            "voeScan();" +
            "setInterval(voeScan,1000);" +
            "})();";
        view.evaluateJavascript(voeJs, null);
    }

    private void notifyState(String state, String message) {
        JSObject notify = new JSObject();
        notify.put("state", state);
        if (message != null) notify.put("message", message);
        notifyListeners("playbackState", notify);
    }

    private boolean isVideoUrl(String url) {
        if (url == null || url.isEmpty()) return false;
        String lower = url.toLowerCase();
        // Solo http(s): el bridge JS es llamable por páginas embed de terceros
        // y sin esto file:///sdcard/x.mp4 o content:// pasarían el filtro.
        if (!lower.startsWith("http://") && !lower.startsWith("https://")) return false;
        // Exclude known analytics/tracking domains
        if (lower.contains("jwpltx.com") || lower.contains("doubleclick.net")
            || lower.contains("googletagmanager") || lower.contains("google-analytics")
            || lower.contains("ping.gif") || lower.contains("/track")
            || lower.contains("analytics") || lower.contains("/pixel")) return false;
        // Exclude placeholder/test videos (VOE anti-bot shows Big Buck Bunny)
        if (lower.contains("bigbuckbunny") || lower.contains("test-videos")
            || lower.contains("buck_bunny") || lower.contains("placeholder")) return false;
        // Extract the path (before query string) to check extension
        String path = url;
        int q = path.indexOf('?');
        if (q >= 0) path = path.substring(0, q);
        String lowerPath = path.toLowerCase();
        // Direct video extensions in the PATH (not query params)
        if (lowerPath.endsWith(".m3u8") || lowerPath.endsWith(".mp4") || lowerPath.endsWith(".mkv")) return true;
        if (lowerPath.contains(".m3u8?") || lowerPath.contains(".mp4?")) return true;
        // Google video
        if (lowerPath.contains("videoplayback")) return true;
        // HLS manifest patterns
        if (lowerPath.contains("/hls/") && lowerPath.endsWith(".m3u8")) return true;
        // Stream URLs with /stream/ path (common in voe, vidhide)
        if (lowerPath.contains("/stream/") && lowerPath.contains("master.m3u8")) return true;
        // VOE/vidhide CDN patterns - URLs with /stream/ and a long hash
        if (lowerPath.contains("/stream/") && lowerPath.length() > 40) return true;
        // URLs ending in /master (HLS without extension)
        if (lowerPath.endsWith("/master")) return true;
        // URLs with index.m3u8
        if (lowerPath.contains("index.m3u8")) return true;
        // VOE CDN: URLs with /hls/ or /dash/ segments
        if (lowerPath.matches(".*/(hls|dash)/[a-z0-9]{20,}.*")) return true;
        return false;
    }

    // Host (y puerto) de una URL para logs: las URLs de stream llevan tokens
    // firmados en query params que no deben acabar en logcat.
    private static String hostOf(String url) {
        if (url == null) return "?";
        try {
            android.net.Uri uri = android.net.Uri.parse(url);
            String h = uri.getHost();
            if (h == null) return "?";
            int p = uri.getPort();
            return p > 0 ? h + ":" + p : h;
        } catch (Exception e) { return "?"; }
    }

    private String getStreamType(String url) {
        if (url == null) return "mp4";
        String lower = url.toLowerCase();
        if (lower.contains(".m3u8")) return "hls";
        if (lower.contains(".mpd")) return "dash";
        return "mp4";
    }

    private void cleanupResolver() {
        if (resolverWebView != null) {
            try {
                resolverWebView.stopLoading();
                resolverWebView.destroy();
            } catch (Exception ignored) {}
            resolverWebView = null;
        }
        embedCookies = null;
        embedOverlay = null;
        embedCursor = null;
        embedCursorX = 0f;
        embedCursorY = 0f;
    }

    @PluginMethod
    public void play(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("url is required");
            return;
        }
        Uri parsedUrl = Uri.parse(url);
        String scheme = parsedUrl.getScheme();
        if (scheme == null || !(scheme.equalsIgnoreCase("http") || scheme.equalsIgnoreCase("https"))) {
            call.reject("invalid url scheme: only http/https are allowed");
            return;
        }

        String streamType = call.getString("streamType", "hls");
        boolean direct = call.getBoolean("direct", false);
        String licenseUrl = call.getString("licenseUrl", null);
        JSONObject headersJson = call.getObject("headers", new JSObject());
        JSONObject drmHeadersJson = call.getObject("drmHeaders", new JSObject());
        String title = call.getString("title", "");
        String mode = call.getString("mode", "vod");
        if (!mode.equals("live") && !mode.equals("vod") && !mode.equals("youtube")) mode = "vod";
        final String playerModeForCall = mode;
        double startTimeSec = call.getDouble("startTime", 0.0);

        // Live TV zapping: lista de canales (nombres) + índice actual + EPG
        JSONArray channels = call.getArray("channels", null);
        int chanIndex = call.getInt("channelIndex", -1);
        String epgNowStr = call.getString("epgNow", null);
        String epgNextStr = call.getString("epgNext", null);
        long epgStart = call.getDouble("epgStart", 0.0).longValue();
        long epgEnd = call.getDouble("epgEnd", 0.0).longValue();
        String logo = call.getString("logo", null);
        String imdbId = call.getString("imdbId", "");
        int mediaSeason = call.getInt("season", 0);
        int mediaEpisode = call.getInt("episode", 0);

        // Series: lista de episodios de la temporada para el panel lateral
        // del player (botón de episodios → zap de episodios).
        JSONArray episodes = call.getArray("episodes", null);
        int epIndex = call.getInt("episodeIndex", -1);

        boolean longBuf = call.getBoolean("longBuffering", false);
        // CDNs rápidos/adaptativos (YouTube): arrancar con menos buffer
        // para adelantar el primer frame.
        boolean fastStartFlag = call.getBoolean("fastStart", false);
        String loadText = call.getString("loadingText", null);

        // Subtítulos del proveedor (YouTube etc.): [{url, lang, label, mimeType, autoGenerated}]
        JSONArray subsJson = call.getArray("subtitles", null);
        final List<MediaItem.SubtitleConfiguration> subs = new ArrayList<>();
        if (subsJson != null) {
            for (int i = 0; i < subsJson.length(); i++) {
                JSONObject s = subsJson.optJSONObject(i);
                if (s == null) continue;
                String subUrl = s.optString("url", "");
                // Solo http(s): las URLs de subtítulos vienen de plugins de
                // terceros — file:///content:// leerían archivos locales.
                if (subUrl.isEmpty() || !(subUrl.startsWith("http://") || subUrl.startsWith("https://"))) continue;
                String mime = s.optString("mimeType", "").toLowerCase(java.util.Locale.ROOT);
                String subMime = mime.contains("vtt") ? androidx.media3.common.MimeTypes.TEXT_VTT
                        : mime.contains("srt") || mime.contains("subrip") ? androidx.media3.common.MimeTypes.APPLICATION_SUBRIP
                        : androidx.media3.common.MimeTypes.APPLICATION_TTML;
                String label = s.optString("label", "");
                String lang = s.optString("lang", "");
                if (label.isEmpty()) label = lang.isEmpty() ? "Subtítulos" : lang.toUpperCase(java.util.Locale.ROOT);
                if (s.optBoolean("autoGenerated", false)) label += " (auto)";
                subs.add(new MediaItem.SubtitleConfiguration.Builder(Uri.parse(subUrl))
                        .setMimeType(subMime)
                        .setLanguage(lang.isEmpty() ? null : lang)
                        .setLabel(label)
                        .build());
            }
        }

        Log.i(TAG, "playStream called: host=" + hostOf(url) + " streamType=" + streamType + " headers=" + (headersJson.length() > 0 ? "custom" : "none"));

        // Add matching cookies from the global CookieManager (CapacitorHttp / WebView)
        // for the target domain. This lets token-locked CDNs (Fastream, Voe) receive
        // the same session cookies on the master.m3u8 that were set on the embed page.
        try {
            android.webkit.CookieManager cm = android.webkit.CookieManager.getInstance();
            String cookies = cm.getCookie(url);
            if (cookies != null && !cookies.isEmpty() && (headersJson == null || !headersJson.has("Cookie"))) {
                headersJson.put("Cookie", cookies);
                Log.d(TAG, "Injected CookieManager cookies: " + cookies.length() + " chars");
            }
        } catch (Exception ignored) {}

        mainHandler.post(() -> {
            try {
                providerSubConfigs = subs.isEmpty() ? null : subs;
                longBuffering = longBuf;
                fastStart = fastStartFlag;
                streamLoadingText = loadText != null && !loadText.isEmpty() ? loadText : "Cargando enlace…";
                openPlayer(url, streamType, direct, licenseUrl, headersJson, drmHeadersJson, title,
                           playerModeForCall, channels, chanIndex, epgNowStr, epgNextStr, epgStart, epgEnd,
                           logo, imdbId, mediaSeason, mediaEpisode, episodes, epIndex);
                if (startTimeSec > 0 && player != null) {
                    pendingSeekMs = (long) (startTimeSec * 1000);
                }
                call.resolve(new JSObject().put("status", "playing"));
            } catch (Exception e) {
                // Log only the message, not the full stack trace (avoids StackOverflow
                // when the exception has a circular cause chain from PlayerView inflation)
                Log.e(TAG, "Error opening player: " + e.getMessage());
                call.reject("Failed to open player: " + e.getMessage());
            }
        });
    }

    private void openPlayer(String url, String streamType, boolean direct, String licenseUrl,
                            JSONObject headersJson, JSONObject drmHeadersJson, String title,
                            String mode, JSONArray channels, int chanIndex, String epgNowStr, String epgNextStr,
                            long epgStart, long epgEnd, String logo,
                            String imdbId, int season, int episode,
                            JSONArray episodes, int epIndex) {
        Context context = getContext();
        channelLogoFallback = logo;
        mediaImdbId = imdbId != null ? imdbId : "";
        mediaSeason = season;
        mediaEpisode = episode;
        // Episodios de la temporada: siempre vienen con play() — si el nuevo
        // stream no trae lista (película, YouTube, directo), se limpia.
        episodeList = episodes;
        episodeIndex = epIndex;
        externalSubUrl = null;
        pendingSelectExternalSub = false;
        playerMode = mode != null ? mode : "vod";
        // Una lista de canales solo se envía para Live TV. Esto mantiene el
        // zapping operativo aunque el bundle nativo llegue con un modo antiguo.
        if (channels != null && channels.length() > 1 && !"youtube".equals(playerMode)) {
            playerMode = "live";
        }
        currentUrl = url != null ? url : "";
        currentStreamType = streamType != null ? streamType : "hls";
        currentDirect = direct;
        currentHeaders = parseHeaders(headersJson);
        Log.i(TAG, "openPlayer: mode=" + playerMode + " channels param=" + (channels == null ? "null" : channels.length())
                + " chanIndex=" + chanIndex + " existing liveChannels=" + (liveChannels == null ? "null" : liveChannels.length()));
        // Reset next episode popup state for the new playback
        dismissNextEpPopup();
        dismissNextEpLoading();
        dismissStreamLoading();
        nextEpShown = false;
        // Preservar liveChannels si play no trae lista (puede haber sido
        // seteada por setChannels antes de openPlayer — orden de mainHandler).
        if (channels != null) {
            liveChannels = channels;
        }
        if (chanIndex >= 0) {
            channelIndex = chanIndex;
        }
        // Guardar el nombre del canal actual para fallback en zapChannel
        // (si channelIndex es -1, zapChannel puede buscar por nombre)
        currentChannelName = title != null ? title : "";
        epgNow = epgNowStr;
        epgNext = epgNextStr;
        epgNowStart = epgStart;
        epgNowEnd = epgEnd;
        // LiveTV cards already carry EPG in the channel list. Use it as a
        // fallback when the initial play request did not include the fields.
        if ("live".equals(playerMode) && channels != null && chanIndex >= 0 && chanIndex < channels.length()) {
            if (epgNow == null || epgNow.isEmpty()) epgNow = channelFieldAt(chanIndex, "now");
            if (epgNext == null || epgNext.isEmpty()) epgNext = channelFieldAt(chanIndex, "next");
            if (epgNowStart <= 0) epgNowStart = channelLongFieldAt(chanIndex, "start");
            if (epgNowEnd <= 0) epgNowEnd = channelLongFieldAt(chanIndex, "end");
        }

        // Release any previous player/embed before opening another server.
        // Keeping two dialogs/WebViews alive can exhaust the Android TV heap.
        // closePlayer() resets channelIndex/liveChannels/currentChannelName,
        // so save them before and restore after to preserve the zap state
        // that setChannels/openPlayer just configured.
        int savedChannelIndex = channelIndex;
        JSONArray savedLiveChannels = liveChannels;
        String savedChannelName = currentChannelName;
        String savedEpgNow = epgNow;
        String savedEpgNext = epgNext;
        long savedEpgStart = epgNowStart;
        long savedEpgEnd = epgNowEnd;
        if (player != null || dialog != null || resolverWebView != null || embedDialog != null) {
            // Suppress the "closed" event so the JS side doesn't unmount the
            // VideoPlayer when we're about to open a new player for the next
            // episode. This makes the transition seamless.
            suppressClosedEvent = true;
            closePlayer();
            suppressClosedEvent = false;
        }
        // Restore zap state that closePlayer() reset to defaults.
        if (savedLiveChannels != null) liveChannels = savedLiveChannels;
        if (savedChannelIndex >= 0) channelIndex = savedChannelIndex;
        if (savedChannelName != null && !savedChannelName.isEmpty()) currentChannelName = savedChannelName;
        epgNow = savedEpgNow;
        epgNext = savedEpgNext;
        epgNowStart = savedEpgStart;
        epgNowEnd = savedEpgEnd;

        // A new player is opening: clear the Back-suppression flag set by the
        // previous closePlayer() so the new dialog handles Back normally.
        suppressBackUntilOpen = false;
        backExitPressedAt = 0;
        lastBackHandledAt = 0;

        // Create full-screen dialog
        dialog = new Dialog(context, android.R.style.Theme_Black_NoTitleBar_Fullscreen) {
            @Override
            public boolean dispatchKeyEvent(KeyEvent event) {
                int code = event.getKeyCode();
                // After closePlayer() runs (Back/Escape), the dialog is
                // dismissed mid-press. Android then delivers the matching
                // ACTION_UP (and sometimes a duplicate ACTION_DOWN) to the
                // BridgeActivity, which fires Capacitor's backButton event.
                // That synthetic Back races with the native 'closed' event
                // and can reopen the channel. Swallow any Back/Escape key
                // events that arrive after we've started closing until a new
                // openPlayer() clears the flag.
                if (suppressBackUntilOpen
                        && (code == KeyEvent.KEYCODE_BACK || code == KeyEvent.KEYCODE_ESCAPE)) {
                    Log.i(TAG, "dispatchKeyEvent: swallowing leaked Back action=" + event.getAction());
                    return true;
                }
                boolean remoteKey = code == KeyEvent.KEYCODE_DPAD_UP
                        || code == KeyEvent.KEYCODE_DPAD_DOWN
                        || code == KeyEvent.KEYCODE_DPAD_LEFT
                        || code == KeyEvent.KEYCODE_DPAD_RIGHT
                        || code == KeyEvent.KEYCODE_DPAD_CENTER
                        || code == KeyEvent.KEYCODE_ENTER
                        || code == KeyEvent.KEYCODE_BACK
                        || code == KeyEvent.KEYCODE_BUTTON_X
                        || code == KeyEvent.KEYCODE_ESCAPE;
                if (remoteKey) {
                    Log.i(TAG, "dispatchKeyEvent: code=" + code + " action=" + event.getAction()
                            + " focus=" + (getCurrentFocus() == null ? "none" : getCurrentFocus().getClass().getSimpleName()));
                    if (event.getAction() == KeyEvent.ACTION_DOWN) return onKeyDown(code, event);
                    return true;
                }
                return super.dispatchKeyEvent(event);
            }

            @Override
            public void onBackPressed() {
                handlePlayerBack();
            }

            @Override
            public boolean onKeyDown(int keyCode, KeyEvent event) {
                boolean canZap = "live".equals(playerMode) && liveChannels != null && liveChannels.length() > 1;

                // Panel lateral abierto (canales o episodios): BACK/LEFT lo
                // cierran; el resto lo gestiona el foco de las filas (OK hace click).
                if (isChannelListVisible() || isEpisodeListVisible()) {
                    if (keyCode == KeyEvent.KEYCODE_BACK || keyCode == KeyEvent.KEYCODE_DPAD_LEFT
                            || keyCode == KeyEvent.KEYCODE_ESCAPE) {
                        hideChannelList();
                        hideEpisodeList();
                        return true;
                    }
                    // OK/Center: click en la fila con foco
                    if (keyCode == KeyEvent.KEYCODE_DPAD_CENTER || keyCode == KeyEvent.KEYCODE_ENTER) {
                        View focused = getCurrentFocus();
                        if (focused != null) focused.performClick();
                        return true;
                    }
                    return super.onKeyDown(keyCode, event);
                }
                if (keyCode == KeyEvent.KEYCODE_BACK || keyCode == KeyEvent.KEYCODE_ESCAPE) {
                    return handlePlayerBack();
                }
                // X (botón del mando o teclado) → cerrar reproducción
                if (keyCode == KeyEvent.KEYCODE_BUTTON_X
                        || keyCode == KeyEvent.KEYCODE_X
                        || keyCode == KeyEvent.KEYCODE_MEDIA_STOP) {
                    if (overlayView != null) dismissOverlay();
                    if (isChannelListVisible()) hideChannelList();
                    if (isEpisodeListVisible()) hideEpisodeList();
                    closePlayer();
                    return true;
                }
                if (keyCode == KeyEvent.KEYCODE_VOLUME_UP || keyCode == KeyEvent.KEYCODE_VOLUME_DOWN) {
                    adjustVolume(keyCode == KeyEvent.KEYCODE_VOLUME_UP ? AudioManager.ADJUST_RAISE : AudioManager.ADJUST_LOWER);
                    return true;
                }
                // Menú overlay abierto: ↑/↓ navega, →/OK selecciona, ←/BACK cierra
                if (overlayView != null) {
                    if (keyCode == KeyEvent.KEYCODE_BACK || keyCode == KeyEvent.KEYCODE_DPAD_LEFT
                            || keyCode == KeyEvent.KEYCODE_ESCAPE) {
                        dismissOverlay();
                        return true;
                    }
                    if (keyCode == KeyEvent.KEYCODE_DPAD_RIGHT
                            || keyCode == KeyEvent.KEYCODE_DPAD_CENTER
                            || keyCode == KeyEvent.KEYCODE_ENTER) {
                        View focused = getCurrentFocus();
                        if (focused != null) focused.performClick();
                        return true;
                    }
                    return super.onKeyDown(keyCode, event);
                }
                // Directo: OK abre la lista de canales solo si los controles
                // están ocultos. Con controles visibles, OK queda libre para
                // activar el botón enfocado (incluido el botón de listado).
                if (canZap && !isControlsVisible()
                        && (keyCode == KeyEvent.KEYCODE_DPAD_CENTER || keyCode == KeyEvent.KEYCODE_ENTER)) {
                    showChannelList();
                    return true;
                }
                // Con controles visibles: OK/Enter activa el botón enfocado.
                // Necesario porque dispatchKeyEvent traga el ACTION_UP del
                // mando, por lo que el click estándar de View.onKeyUp nunca
                // se dispara; hay que invocar performClick() a mano.
                // Si el foco está en un slider, OK cierra el popup y devuelve
                // el foco al icono correspondiente.
                if (isControlsVisible()
                        && (keyCode == KeyEvent.KEYCODE_DPAD_CENTER || keyCode == KeyEvent.KEYCODE_ENTER)) {
                    View focused = getCurrentFocus();
                    if (focused != null) {
                        // OK sobre la barra confirma el scrub pendiente (o
                        // inicia scrub en la posición actual si no hay).
                        if (focused.getId() == R.id.octo_seek) {
                            if (scrubActive) commitScrub();
                            resetControlsTimer();
                            return true;
                        }
                        if (focused.getId() == R.id.octo_volume_seek && volumePopup != null) {
                            volumePopup.setVisibility(View.GONE);
                            View vb = controlsOverlay.findViewById(R.id.octo_volume);
                            if (vb != null) vb.requestFocus();
                            resetControlsTimer();
                            return true;
                        }
                        if (focused.getId() == R.id.octo_boost_seek && boostPopup != null) {
                            boostPopup.setVisibility(View.GONE);
                            if (boostButton != null) boostButton.requestFocus();
                            resetControlsTimer();
                            return true;
                        }
                        int rep = event.getRepeatCount();
                        if (rep > 0) {
                            // Mantener OK sobre rew/ffwd: seek continuo
                            // moderado (~1 salto cada 4 repeticiones ≈ 5/s).
                            // En el resto de botones se ignoran las
                            // repeticiones para no togglear play/pausa.
                            if (focused.getId() == R.id.octo_rew || focused.getId() == R.id.octo_ffwd) {
                                if (rep % 4 == 0) {
                                    seekByStep(focused.getId() == R.id.octo_ffwd ? 1 : -1);
                                }
                            }
                            resetControlsTimer();
                            return true;
                        }
                        Log.i(TAG, "onKeyDown: OK performClick viewId=" + focused.getId()
                                + " type=" + focused.getClass().getSimpleName());
                        focused.performClick();
                        resetControlsTimer();
                        return true;
                    }
                }
                // Sliders horizontales: las flechas se consumen aquí porque
                // dispatchKeyEvent intercepta el mando antes del SeekBar.
                View focused = getCurrentFocus();
                if (focused != null && (keyCode == KeyEvent.KEYCODE_DPAD_LEFT
                        || keyCode == KeyEvent.KEYCODE_DPAD_RIGHT)) {
                    int delta = keyCode == KeyEvent.KEYCODE_DPAD_RIGHT ? 5 : -5;
                    if (focused.getId() == R.id.octo_volume_seek) {
                        adjustVolumeSeek(delta);
                        return true;
                    }
                    if (focused.getId() == R.id.octo_boost_seek) {
                        adjustBoostSeek(delta * 2);
                        return true;
                    }
                    // Seek bar de progreso (VOD): ←/→ mueven un destino de
                    // scrub visible sin saltar el vídeo (commit con OK/idle).
                    if (focused.getId() == R.id.octo_seek && player != null) {
                        scrubByStep(keyCode == KeyEvent.KEYCODE_DPAD_RIGHT ? 1 : -1);
                        return true;
                    }
                }
                // Directo: ↑/↓ siempre hacen zapping con o sin controles.
                if (canZap && (keyCode == KeyEvent.KEYCODE_DPAD_UP || keyCode == KeyEvent.KEYCODE_DPAD_DOWN)) {
                    Log.i(TAG, "onKeyDown: zap dir=" + (keyCode == KeyEvent.KEYCODE_DPAD_UP ? 1 : -1)
                            + " playerMode=" + playerMode + " channels=" + (liveChannels != null ? liveChannels.length() : "null"));
                    zapChannel(keyCode == KeyEvent.KEYCODE_DPAD_UP ? 1 : -1);
                    resetControlsTimer();
                    return true;
                }
                // VOD: sin zapping; navegación normal del D-pad.
                if (isControlsVisible()) {
                    // ↑ lleva a la barra de progreso desde cualquier control —
                    // el nextFocusUpId a veces no se aplica (barra aún oculta
                    // al construir la cadena, popups intermedios, etc.).
                    if (keyCode == KeyEvent.KEYCODE_DPAD_UP
                            && octoSeek != null && octoSeek.getVisibility() == View.VISIBLE) {
                        View f = getCurrentFocus();
                        if (f != octoSeek) octoSeek.requestFocus();
                        resetControlsTimer();
                        return true;
                    }
                    // ↓ desde la barra vuelve al botón de reproducción.
                    if (keyCode == KeyEvent.KEYCODE_DPAD_DOWN) {
                        View f = getCurrentFocus();
                        if (f == octoSeek) {
                            if (octoPlayBtn != null) octoPlayBtn.requestFocus();
                            resetControlsTimer();
                            return true;
                        }
                    }
                    // Navegar con el D-pad también mantiene los controles
                    // visibles; si no, el auto-ocultado los cierra a los 7s
                    // mientras el usuario se desplaza entre botones.
                    resetControlsTimer();
                    return super.onKeyDown(keyCode, event);
                }
                // VOD/YouTube con controles ocultos: ←/→ busca ±10s (con
                // aceleración al mantener) y muestra los controles, estilo
                // Netflix/Prime. En directo ←/→ solo despierta el OSD.
                if (!"live".equals(playerMode)
                        && (keyCode == KeyEvent.KEYCODE_DPAD_LEFT
                            || keyCode == KeyEvent.KEYCODE_DPAD_RIGHT)) {
                    seekByStep(keyCode == KeyEvent.KEYCODE_DPAD_RIGHT ? 1 : -1);
                }
                // Todo oculto: cualquier tecla muestra los controles.
                showControls();
                return true;
            }
        };

        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
        dialog.getWindow().setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(Color.BLACK));

        // Release any previous player and WebView resources before creating a new PlayerView.
        // This prevents OOM when the Java heap is already near the limit from provider/WebView usage.
        // Suppress the "closed" event: this closePlayer() is an internal cleanup
        // before opening a NEW player, not a user-requested close. Without this,
        // JS receives a spurious "closed" event on every openPlayer() call and
        // may unmount the VideoPlayer (reopening the channel or breaking the
        // Back-button flow).
        suppressClosedEvent = true;
        try {
            closePlayer();
        } finally {
            suppressClosedEvent = false;
        }
        // closePlayer() limpia currentUrl; restaurarla después de la limpieza
        // para que Cast siempre reciba la URL reproducida.
        currentUrl = url != null ? url : "";
        // Hint the GC to collect freed memory before allocating PlayerView
        System.gc();

        // Inflar nuestro layout: PlayerView como hijo (no raíz — como raíz se
        // autoinflaría en bucle) con controller_layout_id propio. Así el layout
        // del controller es determinista: sin iconos centrales y con nuestras
        // dos filas fijas (transporte + audio/velocidad/EPG).
        FrameLayout rootLayout = new FrameLayout(context);
        // En Android TV, si ninguna vista es focusable, los eventos D-pad no
        // llegan al setOnKeyListener del dialog. Hacer el root focusable para
        // que reciba los key events cuando los controles están ocultos.
        rootLayout.setFocusable(true);
        rootLayout.setFocusableInTouchMode(true);
        rootLayout.setDescendantFocusability(ViewGroup.FOCUS_AFTER_DESCENDANTS);
        View playerContainer;
        try {
            playerContainer = android.view.LayoutInflater.from(context)
                    .inflate(R.layout.octo_player_view, rootLayout, false);
        } catch (OutOfMemoryError oom) {
            System.gc();
            try { Thread.sleep(100); } catch (Exception ignored) {}
            playerContainer = android.view.LayoutInflater.from(context)
                    .inflate(R.layout.octo_player_view, rootLayout, false);
        }
        playerView = playerContainer.findViewById(R.id.octo_player_view);
        rootLayout.addView(playerContainer);
        playerView.setShowBuffering(PlayerView.SHOW_BUFFERING_WHEN_PLAYING);
        // PlayerView no debe capturar el foco ni los eventos D-pad — todo el
        // manejo de teclas va por el Dialog.onKeyDown override.
        playerView.setFocusable(false);
        playerView.setFocusableInTouchMode(false);

        // Root: playerView + top bar estilo Stremio
        topBar = buildTopBar(context, title);
        rootLayout.addView(topBar);
        // Controles propios (sin PlayerControlView de Media3)
        controlsOverlay = (LinearLayout) android.view.LayoutInflater.from(context)
                .inflate(R.layout.octo_controls, rootLayout, false);
        FrameLayout.LayoutParams controlsLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM);
        rootLayout.addView(controlsOverlay, controlsLp);
        rootLayoutRef = rootLayout;
        // Panel lateral de lista de canales (estilo Netfly), solo en directo
        if (liveChannels != null && liveChannels.length() > 1) {
            channelListPanel = buildChannelListPanel(context);
            rootLayout.addView(channelListPanel);
        }
        // Panel lateral de episodios de la temporada (series VOD)
        if (episodeList != null && episodeList.length() > 0) {
            episodeListPanel = buildEpisodeListPanel(context);
            rootLayout.addView(episodeListPanel);
        }
        dialog.setContentView(rootLayout);

        attachAudioControls(context);
        dialog.setCancelable(false);
        // Mantener la pantalla encendida durante la reproducción: sin el flag
        // el salvapantallas de Android TV salta encima del vídeo.
        dialog.getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        dialog.show();
        // Pantalla de marca mientras el enlace carga (hasta el primer READY)
        showStreamLoading();

        // Mouse / touch movement shows controls (Kodi-style). Any pointer
        // activity wakes the OSD without requiring a D-pad key press.
        rootLayout.setOnGenericMotionListener((v, ev) -> {
            if (ev.getAction() == android.view.MotionEvent.ACTION_HOVER_MOVE
                    || ev.getAction() == android.view.MotionEvent.ACTION_MOVE) {
                if (!isControlsVisible()) showControls();
                else resetControlsTimer();
            }
            return false;
        });
        rootLayout.setOnTouchListener((v, ev) -> {
            if (ev.getAction() == android.view.MotionEvent.ACTION_DOWN
                    || ev.getAction() == android.view.MotionEvent.ACTION_MOVE) {
                if (!isControlsVisible()) showControls();
                else resetControlsTimer();
            }
            // En móvil: deslizar arriba/abajo hace zapping en directo.
            if (swipeGestureDetector != null) swipeGestureDetector.onTouchEvent(ev);
            return true;
        });

        // GestureDetector para swipes verticales (zapping) en móvil.
        boolean canZapAtOpen = "live".equals(playerMode) && liveChannels != null && liveChannels.length() > 1;
        if (canZapAtOpen) {
            swipeGestureDetector = new GestureDetector(context, new GestureDetector.SimpleOnGestureListener() {
                private static final int SWIPE_THRESHOLD = 80;
                private static final int SWIPE_VELOCITY = 100;
                private float downY = 0;
                @Override
                public boolean onDown(MotionEvent e) {
                    downY = e.getY();
                    return true;
                }
                @Override
                public boolean onFling(MotionEvent e1, MotionEvent e2, float vx, float vy) {
                    float dy = e2.getY() - e1.getY();
                    float dx = Math.abs(e2.getX() - e1.getX());
                    // Swipe vertical: dy dominante, no horizontal
                    if (Math.abs(dy) > SWIPE_THRESHOLD && Math.abs(dy) > dx
                            && Math.abs(vy) > SWIPE_VELOCITY) {
                        boolean canZap = "live".equals(playerMode)
                                && liveChannels != null && liveChannels.length() > 1;
                        if (canZap) {
                            // Swipe arriba (dy negativo) → canal siguiente
                            // Swipe abajo (dy positivo) → canal anterior
                            zapChannel(dy < 0 ? 1 : -1);
                            return true;
                        }
                    }
                    return false;
                }
            });
        }

        // Capturar el foco en el rootLayout para que los eventos D-pad lleguen
        // al setOnKeyListener del dialog cuando los controles están ocultos.
        rootLayout.requestFocus();

        // Build HTTP headers for stream requests
        Map<String, String> headers = parseHeaders(headersJson);
        // Ensure User-Agent is always set (some hosts like faststream reject ExoPlayer's default UA)
        if (!headers.containsKey("User-Agent")) {
            headers.put("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
        }

        // Build DRM headers for license requests
        Map<String, String> drmHeaders = parseHeaders(drmHeadersJson);

        // Create HTTP data source factory using Cronet (Chromium network stack)
        // Cronet uses the same TLS/HTTP stack as Chrome, so CDNs that fingerprint
        // and reject OkHttp (DefaultHttpDataSource) will accept Cronet requests.
        // Uses cronet-embedded (bundled in APK, no Play Services required)
        CookieManager cookieManager = new CookieManager();
        cookieManager.setCookiePolicy(CookiePolicy.ACCEPT_ALL);
        try {
            java.net.CookieHandler.setDefault(cookieManager);
        } catch (Exception e) {
            Log.w(TAG, "Could not set cookie manager", e);
        }

        // URLs loopback (relay local de embeds, servidores LAN): nunca por WARP —
        // el proxy intentaría resolver 127.0.0.1 en su extremo remoto.
        lastSourceUsedWarp = shouldUseWarpProxy(url, direct, false);
        DataSource.Factory dataSourceFactory = buildStreamDataSourceFactory(url, headers, direct, false);

        // Build DRM session manager if license URL is provided
        DrmSessionManager drmSessionManager = null;
        if (licenseUrl != null && !licenseUrl.isEmpty()) {
            try {
                // EXACT match to TDT Spain APK (o.java lines 7241-7257):
                // factory7.setDefaultRequestProperties(f26064b)  -- stream headers (empty for U7D)
                // HttpMediaDrmCallback(licenseUrl, factory7)
                // for each f26074m entry: setKeyRequestProperty(key, value)
                //
                // For U7D Mediaset, f26064b is EMPTY and f26074m has all needed headers.
                // For live streams, f26064b may have config headers and f26074m may be empty.
                // We pass stream headers as defaults ONLY if no DRM headers are provided.
                DefaultHttpDataSource.Factory drmHttpFactory = new DefaultHttpDataSource.Factory()
                        .setAllowCrossProtocolRedirects(true);

                // Only set stream headers as default if no dedicated DRM headers are provided
                // (matching APK: for U7D, f26064b is empty, so no defaults are set)
                if (drmHeaders == null || drmHeaders.isEmpty()) {
                    if (headers != null && !headers.isEmpty()) {
                        drmHttpFactory.setDefaultRequestProperties(headers);
                    }
                }

                HttpMediaDrmCallback drmCallback = new HttpMediaDrmCallback(licenseUrl, drmHttpFactory);

                // Set DRM-specific key request properties (matching APK: f26074m)
                if (drmHeaders != null) {
                    for (Map.Entry<String, String> entry : drmHeaders.entrySet()) {
                        drmCallback.setKeyRequestProperty(entry.getKey(), entry.getValue());
                    }
                }

                drmSessionManager = new DefaultDrmSessionManager.Builder()
                        .setUuidAndExoMediaDrmProvider(C.WIDEVINE_UUID, FrameworkMediaDrm.DEFAULT_PROVIDER)
                        .setMultiSession(false)
                        .build(drmCallback);
            } catch (Exception e) {
                Log.e(TAG, "DRM Error: Error al inicializar Widevine", e);
            }
        }

        // Build media source based on stream type (matching TDT Spain APK logic)
        // Guardar el contexto para reconstruir el MediaSource al aplicar un
        // subtítulo externo (OpenSubtitles) sin cerrar el player.
        lastDataSourceFactory = dataSourceFactory;
        lastStreamType = streamType;
        lastDrmSessionManager = drmSessionManager;
        lastLicenseUrl = licenseUrl;
        MediaSource mediaSource = buildMediaSource(url, streamType, dataSourceFactory, drmSessionManager, licenseUrl);

        // Create ExoPlayer with proper configuration (matching TDT Spain APK)
        // Buffer aumentado para conexiones lentas:
        // - minBuffer: 50s (cuánto buffer mínimo antes de reanudar tras un rebuffer)
        // - maxBuffer: 120s (cuánto buffer máximo antes de dejar de descargar)
        // - bufferForPlayback: 2.5s (cuánto buffer para empezar a reproducir)
        // - bufferForPlaybackAfterRebuffer: 5s (cuánto buffer tras un rebuffer)
        DefaultLoadControl loadControl = new DefaultLoadControl.Builder()
                .setBufferDurationsMs(50000, 120000, fastStart ? 1000 : 2500, fastStart ? 2500 : 5000)
                .setTargetBufferBytes(50 * 1024 * 1024) // 50MB max buffer para conexiones lentas
                .setPrioritizeTimeOverSizeThresholds(true)
                .build();

        DefaultTrackSelector trackSelector = new DefaultTrackSelector(context);
        trackSelector.setParameters(
                trackSelector.buildUponParameters()
                        .setPreferredAudioLanguage("es")
                        .setPreferredTextLanguage("es")
                        // TV: no activar subtítulos automáticamente. El usuario
                        // puede activarlos únicamente desde el menú propio de ExoPlayer.
                        .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
                        .build()
        );

        AudioAttributes audioAttributes = mainAudioAttrs();

        DefaultRenderersFactory renderersFactory = new DefaultRenderersFactory(context) {
            @Override
            protected void buildTextRenderers(Context ctx, androidx.media3.exoplayer.text.TextOutput output,
                                              Looper looper, int extensionRendererMode,
                                              ArrayList<androidx.media3.exoplayer.Renderer> out) {
                // super.buildTextRenderers solo añade new TextRenderer(output,
                // looper): lo sustituimos por uno con nuestro decoder factory
                // que desplaza los tiempos de los cues (subtitleOffsetUs).
                out.add(new androidx.media3.exoplayer.text.TextRenderer(
                        output, looper, subtitleOffsetDecoderFactory));
            }
        };
        renderersFactory.setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_PREFER)
                .setEnableDecoderFallback(true);

        player = new ExoPlayer.Builder(context)
                .setLoadControl(loadControl)
                // Con PiP activo el mini es dueño del audio focus: si el
                // principal lo pidiera, el mini recibiría AUDIOFOCUS_LOSS y
                // Media3 lo pausaría automáticamente.
                .setAudioAttributes(audioAttributes, pipPlayer == null)
                .setTrackSelector(trackSelector)
                .setRenderersFactory(renderersFactory)
                .setWakeMode(C.WAKE_MODE_LOCAL) // CPU despierta durante playback
                .build();

        playerView.setPlayer(player);
        // La pantalla no debe dormirse mientras se reproduce vídeo.
        playerView.setKeepScreenOn(true);

        // Si hay un mini-player PiP activo, se re-ancla dentro del diálogo y
        // el principal queda muteado (el mini conserva el audio).
        if (pipPlayer != null) {
            attachPipToBestParent();
            mainVolBeforePip = Math.max(player.getVolume(), 0.01f);
            player.setVolume(0f);
        }

        // Listen for events
        player.addListener(new Player.Listener() {
            @Override
            public void onAudioSessionIdChanged(int audioSessionId) {
                configureLoudnessEnhancer(audioSessionId);
            }

            @Override
            public void onPlaybackStateChanged(int state) {
                JSObject event = new JSObject();
                switch (state) {
                    case Player.STATE_READY:
                        // Cancel buffering timeout
                        cancelBufferingCheck();
                        bufferingRetries = 0;
                        behindLiveRetries = 0;
                        sourceErrorRetries = 0;
                        dismissStreamLoading();
                        event.put("state", "ready");
                        if (pendingSeekMs > 0 && player != null) {
                            player.seekTo(pendingSeekMs);
                            pendingSeekMs = 0;
                        }
                        break;
                    case Player.STATE_BUFFERING:
                        // Timeout de 20s con reintento automático: un directo
                        // con la playlist HLS colgada se recarga solo antes de
                        // rendirse y cerrar el player.
                        scheduleBufferingCheck();
                        // En torrents un stall = espera de piezas. Mostrar el
                        // overlay de carga (JS lo mantiene con el progreso de
                        // descarga en vivo vía setLoadingText).
                        if (longBuffering) showStreamLoading();
                        event.put("state", "buffering");
                        break;
                    case Player.STATE_ENDED:
                        cancelBufferingCheck();
                        event.put("state", "ended");
                        // Don't close immediately. Show loading overlay so JS can
                        // resolve the next episode stream. JS will call playStream
                        // (which closes+opens) or stopPlayback when done.
                        showNextEpLoading();
                        break;
                    case Player.STATE_IDLE:
                        cancelBufferingCheck();
                        event.put("state", "idle");
                        break;
                }
                notifyListeners("playbackState", event);
            }

            // La pista de texto side-loaded puede registrarse después de
            // STATE_READY: seleccionarla cuando los tracks se actualicen.
            @Override
            public void onTracksChanged(Tracks tracks) {
                if (pendingSelectExternalSub) selectExternalSubtitleTrack();
            }

            @Override
            public void onPlayerError(androidx.media3.common.PlaybackException error) {
                // El directo se le escapó al player (la ventana en vivo dejó
                // atrás su posición — pasa cuando el relay/la red van lentos).
                // Recuperar saltando al borde en vivo en vez de matar el
                // player: JS no ve error y no hay fallback al embed.
                if (error.errorCode
                        == androidx.media3.common.PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW
                        && player != null && lastMediaSource != null
                        && behindLiveRetries < 4) {
                    behindLiveRetries++;
                    Log.w(TAG, "Behind live window — salto al borde en vivo ("
                            + behindLiveRetries + "/4)");
                    cancelBufferingCheck();
                    player.seekToDefaultPosition();
                    player.prepare();
                    return;
                }
                // Errores de red en directos (ERROR_CODE_IO_* = 2000-2999:
                // token de segmento caducado → 403, timeout, conexión caída).
                // Un directo se reintenta con backoff — la playlist rota y el
                // siguiente intento suele entrar. Sin esto un solo 403 mata el
                // player y JS cae al embed.
                if ("live".equals(playerMode) && lastMediaSource != null
                        && error.errorCode >= 2000 && error.errorCode < 3000
                        && sourceErrorRetries < 3) {
                    sourceErrorRetries++;
                    Log.w(TAG, "IO error en live (" + error.errorCode
                            + ") — reintento " + sourceErrorRetries + "/3");
                    cancelBufferingCheck();
                    dismissStreamLoading();
                    showStreamLoading();
                    // Si la ruta actual iba por el proxy WARP local y el fallo es
                    // que ese proxy rechazó la conexión (túnel Aether caído o
                    // reconectando tras un hueco de red), reintentar con el mismo
                    // factory nunca se recupera solo — reconstruir en directo.
                    if (lastSourceUsedWarp && isWarpConnRefused(error)
                            && currentUrl != null && !currentUrl.isEmpty()) {
                        Log.w(TAG, "WARP proxy local caído (conexión rechazada) — reintento en directo sin proxy");
                        try {
                            DataSource.Factory dsf = buildStreamDataSourceFactory(
                                    currentUrl, currentHeaders, currentDirect, true);
                            MediaSource src = buildMediaSource(
                                    currentUrl, currentStreamType, dsf, lastDrmSessionManager, lastLicenseUrl);
                            lastDataSourceFactory = dsf;
                            lastMediaSource = src;
                            lastSourceUsedWarp = false;
                        } catch (Exception ignored) {}
                    }
                    mainHandler.postDelayed(() -> {
                        if (player == null || lastMediaSource == null) return;
                        try {
                            player.setMediaSource(lastMediaSource);
                            player.prepare();
                        } catch (Exception ignored) {}
                    }, 1500L * sourceErrorRetries);
                    return;
                }
                // Cancel buffering timeout on error
                cancelBufferingCheck();
                dismissStreamLoading();
                Log.e(TAG, "Player error", error);
                JSObject event = new JSObject();
                event.put("state", "error");
                // Build a detailed message including HTTP status code if available
                String msg = error.getMessage() != null ? error.getMessage() : "unknown";
                if (error.getCause() != null) {
                    String causeMsg = error.getCause().getMessage();
                    if (causeMsg != null) msg += " — " + causeMsg;
                }
                event.put("message", msg);
                event.put("errorCode", error.errorCode);
                notifyListeners("playbackState", event);
            }
        });

        lastMediaSource = mediaSource;
        player.setMediaSource(mediaSource);
        player.prepare();
        player.setPlayWhenReady(true);

        // Periodically report position and duration for progress saving
        positionUpdateRunnable = new Runnable() {
            private long lastEmittedPosition = -1;
            @Override
            public void run() {
                if (player == null) return;
                long position = player.getCurrentPosition();
                long duration = player.getDuration();
                // Emit position event every tick (5s) for progress saving.
                // En pausa la posición no cambia: no emitir evita tráfico de
                // bridge (y el log de JS) constante mientras el TV está idle.
                if (position > 0 && (player.isPlaying() || position != lastEmittedPosition)) {
                    lastEmittedPosition = position;
                    JSObject event = new JSObject();
                    event.put("state", "position");
                    event.put("position", position);
                    event.put("duration", duration > 0 ? duration : 0);
                    notifyListeners("playbackState", event);
                }
                // Next episode popup: show 30s before end (10s for short content)
                // Check every 5s; only log when close to threshold
                if (nextEpTitle != null && !nextEpTitle.isEmpty() && !nextEpShown) {
                    long threshold = duration > 120000 ? 30000 : 10000;
                    long timeLeft = duration > 0 ? duration - position : -1;
                    if (duration > 0 && timeLeft <= threshold && timeLeft > 0) {
                        nextEpShown = true;
                        Log.i(TAG, "Showing next episode popup: " + nextEpTitle);
                        showNextEpPopup();
                    }
                }
                mainHandler.postDelayed(this, 5000); // every 5s
            }
        };
        mainHandler.postDelayed(positionUpdateRunnable, 10000);
    }

    // Timeout de buffering con reintento automático. Al saltar (20s sin salir
    // de BUFFERING) se re-asigna el MediaSource — fuerza recarga de la playlist
    // HLS en directo y saca al loader de un estado colgado. Directos: 2
    // reintentos (~60s de tolerancia); VOD: 1. Agotados → error + cierre.
    private void cancelBufferingCheck() {
        if (bufferingCheckRunnable != null) {
            mainHandler.removeCallbacks(bufferingCheckRunnable);
            bufferingCheckRunnable = null;
        }
    }

    private void scheduleBufferingCheck() {
        cancelBufferingCheck();
        bufferingCheckRunnable = () -> {
            if (player == null || player.getPlaybackState() != Player.STATE_BUFFERING) return;
            int maxRetries = longBuffering ? 4 : "live".equals(playerMode) ? 2 : 1;
            if (bufferingRetries < maxRetries && lastMediaSource != null) {
                bufferingRetries++;
                Log.w(TAG, "Buffering timeout — reloading source (retry " + bufferingRetries + "/" + maxRetries + ")");
                try {
                    float savedVolume = player.getVolume();
                    if ("live".equals(playerMode)) {
                        player.setMediaSource(lastMediaSource);
                    } else {
                        player.setMediaSource(lastMediaSource, Math.max(0, player.getCurrentPosition()));
                    }
                    player.prepare();
                    if (savedVolume > 0f) player.setVolume(savedVolume);
                } catch (Exception e) {
                    Log.e(TAG, "buffering retry failed: " + e.getMessage());
                }
                // El BUFFERING subsiguiente (o READY si recupera) reprograma
                // este check desde onPlaybackStateChanged.
                return;
            }
            Log.w(TAG, "Buffering timeout agotado, mostrando error");
            JSObject timeoutEvent = new JSObject();
            timeoutEvent.put("state", "error");
            timeoutEvent.put("message", "Timeout: el canal no responde");
            timeoutEvent.put("errorCode", -1);
            notifyListeners("playbackState", timeoutEvent);
            closePlayer();
        };
        mainHandler.postDelayed(bufferingCheckRunnable, longBuffering ? 90000 : 20000);
    }

    private boolean isTdtSpainDomain(String url) {
        if (url == null) return false;
        try {
            String host = Uri.parse(url).getHost();
            if (host == null) return false;
            host = host.toLowerCase(java.util.Locale.ROOT);
            return host.equals("tdtspain.com") || host.endsWith(".tdtspain.com")
                    || host.equals("tdtchannels.com") || host.endsWith(".tdtchannels.com")
                    || host.equals("rtve.es") || host.endsWith(".rtve.es")
                    || host.equals("mediaset.net") || host.endsWith(".mediaset.net")
                    || host.equals("mediasetinfinity.es") || host.endsWith(".mediasetinfinity.es")
                    || host.equals("dai.google.com") || host.endsWith(".dai.google.com")
                    || host.equals("doubleclick.net") || host.endsWith(".doubleclick.net");
        } catch (Exception ignored) {
            return false;
        }
    }

    private MediaSource buildMediaSource(String url, String streamType,
                                         DataSource.Factory dataSourceFactory,
                                         DrmSessionManager drmSessionManager,
                                         String licenseUrl) {
        Uri uri = Uri.parse(url);
        MediaItem.Builder mediaItemBuilder = new MediaItem.Builder().setUri(uri);

        Log.i(TAG, "buildMediaSource: host=" + hostOf(url) + " streamType=" + streamType);

        // Configure DRM if available
        if (drmSessionManager != null && licenseUrl != null && !licenseUrl.isEmpty()) {
            MediaItem.DrmConfiguration drmConfig = new MediaItem.DrmConfiguration.Builder(C.WIDEVINE_UUID)
                    .setLicenseUri(licenseUrl)
                    .build();
            mediaItemBuilder.setDrmConfiguration(drmConfig);
        }

        // Subtítulo externo (OpenSubtitles/Stremio): en Media3 1.3.1 el player
        // NO procesa MediaItem.subtitleConfigurations al pasar un MediaSource
        // ya construido — hay que envolverlo con MergingMediaSource +
        // SingleSampleMediaSource (ver más abajo, tras construir el source).
        final MediaItem.SubtitleConfiguration externalSubConfig =
                (externalSubUrl != null && !externalSubUrl.isEmpty())
                        ? new MediaItem.SubtitleConfiguration.Builder(Uri.parse(externalSubUrl))
                                .setMimeType(externalSubUrl.toLowerCase().contains(".vtt")
                                        ? androidx.media3.common.MimeTypes.TEXT_VTT
                                        : androidx.media3.common.MimeTypes.APPLICATION_SUBRIP)
                                .setLanguage(externalSubLang)
                                .setLabel("OpenSubtitles")
                                .build()
                        : null;

        MediaItem mediaItem = mediaItemBuilder.build();

        // Select MediaSource based on URL and stream type (matching TDT Spain APK)
        String lowerUrl = url.toLowerCase();
        // If streamType was explicitly provided (not "hls" default), respect it
        // and only override if URL clearly indicates a different type
        String effectiveType = streamType != null ? streamType.toLowerCase() : "hls";
        if (lowerUrl.contains(".m3u8") || lowerUrl.contains("m3u8")) {
            effectiveType = "hls";
        } else if (lowerUrl.contains(".mp4") || lowerUrl.contains("videoplayback")) {
            effectiveType = "mp4";
        } else if (lowerUrl.contains(".mpd")) {
            effectiveType = "dash";
        }
        // Debrid download links (alldebrid.com/d/) are direct file downloads
        // Don't override "mp4" streamType with "hls" for these URLs
        if (lowerUrl.contains("download.alldebrid.com") || lowerUrl.contains("alldebrid.com/d/")) {
            if (!effectiveType.equals("dash")) {
                effectiveType = "mp4";
            }
        }
        Log.i(TAG, "buildMediaSource: effectiveType=" + effectiveType + " (was " + streamType + ")");

        MediaSource source;
        switch (effectiveType) {
            case "dash":
                DashMediaSource.Factory dashFactory = new DashMediaSource.Factory(dataSourceFactory);
                if (drmSessionManager != null) {
                    dashFactory.setDrmSessionManagerProvider(unused -> drmSessionManager);
                }
                source = dashFactory.createMediaSource(mediaItem);
                break;
            case "mp4":
                source = new ProgressiveMediaSource.Factory(dataSourceFactory).createMediaSource(mediaItem);
                break;
            case "hls":
            default:
                HlsMediaSource.Factory hlsFactory = new HlsMediaSource.Factory(dataSourceFactory);
                if (drmSessionManager != null) {
                    hlsFactory.setDrmSessionManagerProvider(unused -> drmSessionManager);
                }
                source = hlsFactory.createMediaSource(mediaItem);
                break;
        }

        // Side-loaded subtitles: merge SingleSampleMediaSource(s) with the main
        // source. treatLoadErrorsAsEndOfStream evita que una descarga fallida
        // del .srt/.ttml tumbe la reproducción entera. Incluye los subtítulos
        // del proveedor (YouTube) y el externo (OpenSubtitles) si lo hay.
        List<MediaItem.SubtitleConfiguration> allSubs = new ArrayList<>();
        if (providerSubConfigs != null) allSubs.addAll(providerSubConfigs);
        if (externalSubConfig != null) allSubs.add(externalSubConfig);
        if (!allSubs.isEmpty()) {
            SingleSampleMediaSource.Factory subFactory = new SingleSampleMediaSource.Factory(dataSourceFactory)
                    .setTreatLoadErrorsAsEndOfStream(true);
            MediaSource[] merged = new MediaSource[allSubs.size() + 1];
            merged[0] = source;
            for (int i = 0; i < allSubs.size(); i++) {
                merged[i + 1] = subFactory.createMediaSource(allSubs.get(i), C.TIME_UNSET);
            }
            source = new MergingMediaSource(merged);
        }
        return source;
    }

    // Bindea las vistas del layout octo_controls.xml (controles 100% propios,
    // sin PlayerControlView de Media3).
    private void attachAudioControls(Context context) {
        boolean canZap = "live".equals(playerMode) && liveChannels != null && liveChannels.length() > 1;

        // --- Transporte: play/pause, rew, ffwd ---
        octoPlayBtn = controlsOverlay.findViewById(R.id.octo_play);
        octoPlayBtn.setColorFilter(Color.WHITE);
        octoPlayBtn.setOnClickListener(v -> {
            if (player == null) return;
            if (player.getPlayWhenReady()) player.pause();
            else player.play();
            updateControlsUi();
            resetControlsTimer();
        });

        ImageButton rewBtn = controlsOverlay.findViewById(R.id.octo_rew);
        ImageButton ffwdBtn = controlsOverlay.findViewById(R.id.octo_ffwd);
        // Live TV keeps only play/pause. Rewind/forward remain available for
        // VOD and U7D playback, where seeking is meaningful.
        if ("live".equals(playerMode)) {
            rewBtn.setVisibility(View.GONE);
            ffwdBtn.setVisibility(View.GONE);
        }
        // Click = ±10s; pulsaciones repetidas o mantener aceleran el salto
        // (escalera 15s → 120s). Long-press táctil = salto directo de 60s.
        rewBtn.setOnClickListener(v -> seekByStep(-1));
        ffwdBtn.setOnClickListener(v -> seekByStep(1));
        rewBtn.setOnLongClickListener(v -> { seekByMs(-60000); return true; });
        ffwdBtn.setOnLongClickListener(v -> { seekByMs(60000); return true; });

        // Botón cuadrado: finaliza la reproducción (cierra el player).
        octoStopBtn = controlsOverlay.findViewById(R.id.octo_stop);
        octoStopBtn.setOnClickListener(v -> closePlayer());

        // Botón listado de canales: abre el diálogo de canales (solo directo).
        octoChannelsBtn = controlsOverlay.findViewById(R.id.octo_channels);
        if ("live".equals(playerMode)) {
            octoChannelsBtn.setVisibility(View.VISIBLE);
            octoChannelsBtn.setOnClickListener(v -> showChannelList());
        } else {
            octoChannelsBtn.setVisibility(View.GONE);
        }

        // Botón lista de episodios de la temporada (series VOD).
        octoEpisodesBtn = controlsOverlay.findViewById(R.id.octo_episodes);
        if (octoEpisodesBtn != null) {
            if (episodeList != null && episodeList.length() > 0 && !"live".equals(playerMode)) {
                octoEpisodesBtn.setVisibility(View.VISIBLE);
                octoEpisodesBtn.setOnClickListener(v -> showEpisodeList());
            } else {
                octoEpisodesBtn.setVisibility(View.GONE);
            }
        }

        // Zapping se hace solo desde el logo (↑/↓). Sin botones en la fila.
        // Subtítulos: en directo siempre desactivados por defecto.
        View subtitle = controlsOverlay.findViewById(R.id.octo_subtitle);
        subtitle.setOnClickListener(v -> showSubtitleMenu());
        View settings = controlsOverlay.findViewById(R.id.octo_settings);
        if (settings != null) settings.setOnClickListener(v -> showSettingsMenu());
        View subDelay = controlsOverlay.findViewById(R.id.octo_subdelay);
        if (subDelay != null) subDelay.setOnClickListener(v -> showSubtitleDelayMenu());

        // Fila EPG: logo + programa actual/siguiente. El logo es focusable y
        // con ↑/↓ hace zapping (estilo Netfly).
        octoInfoRow = controlsOverlay.findViewById(R.id.octo_info_row);
        octoLogo = controlsOverlay.findViewById(R.id.octo_logo);
        octoNowTv = controlsOverlay.findViewById(R.id.octo_now);
        octoNextTv = controlsOverlay.findViewById(R.id.octo_next);
        octoLiveBadge = controlsOverlay.findViewById(R.id.octo_live_badge);
        octoProg = controlsOverlay.findViewById(R.id.octo_prog);
        octoEpgStartTv = controlsOverlay.findViewById(R.id.octo_epg_start);
        octoEpgEndTv = controlsOverlay.findViewById(R.id.octo_epg_end);
        octoEpgStartTv = controlsOverlay.findViewById(R.id.octo_epg_start);
        octoEpgEndTv = controlsOverlay.findViewById(R.id.octo_epg_end);
        octoLogo.setOnKeyListener((v, keyCode, event) -> {
            if (event.getAction() != KeyEvent.ACTION_DOWN) return false;
            if (keyCode == KeyEvent.KEYCODE_DPAD_UP) { zapChannel(1); return true; }
            if (keyCode == KeyEvent.KEYCODE_DPAD_DOWN) { zapChannel(-1); return true; }
            return false;
        });
        applyFocusScale(octoLogo);

        // Seek de progreso (VOD; en directo se oculta en updateControlsUi)
        octoSeek = controlsOverlay.findViewById(R.id.octo_seek);
        octoPosition = controlsOverlay.findViewById(R.id.octo_position);
        octoDuration = controlsOverlay.findViewById(R.id.octo_duration);
        octoSeekDelta = controlsOverlay.findViewById(R.id.octo_seek_delta);
        octoSeek.getProgressDrawable().setColorFilter(ACCENT_COLOR, android.graphics.PorterDuff.Mode.SRC_IN);
        octoSeek.getThumb().setColorFilter(ACCENT_COLOR, android.graphics.PorterDuff.Mode.SRC_IN);
        // Foco en la barra: engordarla para que se vea claramente dónde está
        // el D-pad; al perder el foco se confirma el scrub pendiente.
        octoSeek.setOnFocusChangeListener((v, hasFocus) -> {
            v.animate().scaleY(hasFocus ? 2.0f : 1f).setDuration(120).start();
            if (hasFocus) resetControlsTimer();
            else commitScrub();
        });
        octoSeek.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar sb, int progress, boolean fromUser) {
                if (fromUser && octoPosition != null && player != null) {
                    long dur = player.getDuration();
                    if (dur > 0) octoPosition.setText(formatMs(progress * dur / 1000));
                }
            }
            @Override public void onStartTrackingTouch(SeekBar sb) { controlsSeeking = true; }
            @Override public void onStopTrackingTouch(SeekBar sb) {
                controlsSeeking = false;
                if (player != null) {
                    long dur = player.getDuration();
                    if (dur > 0) player.seekTo(sb.getProgress() * dur / 1000);
                }
                updateControlsUi();
                resetControlsTimer();
            }
        });

        // --- Fila 2: volumen, slider, amplificador, velocidad, EPG ---
        ImageButton volumeButton = controlsOverlay.findViewById(R.id.octo_volume);
        volumeButton.setOnClickListener(v -> {
            if (player == null) return;
            // Click en el icono: abre/cierra el popup de volumen.
            if (volumePopup != null) {
                boolean show = volumePopup.getVisibility() != View.VISIBLE;
                volumePopup.setVisibility(show ? View.VISIBLE : View.GONE);
                if (boostPopup != null) boostPopup.setVisibility(View.GONE);
                if (show) volumeSeek.requestFocus();
            }
            resetControlsTimer();
        });

        volumePopup = controlsOverlay.findViewById(R.id.octo_volume_popup);
        volumeSeek = controlsOverlay.findViewById(R.id.octo_volume_seek);
        volumeSeek.setProgress(player != null ? Math.round(player.getVolume() * 100f) : 100);
        volumeSeek.getProgressDrawable().setColorFilter(ACCENT_COLOR, android.graphics.PorterDuff.Mode.SRC_IN);
        volumeSeek.getThumb().setColorFilter(ACCENT_COLOR, android.graphics.PorterDuff.Mode.SRC_IN);
        volumeSeek.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar sb, int progress, boolean fromUser) {
                if (fromUser && player != null) player.setVolume(progress / 100f);
                if (fromUser) resetControlsTimer();
            }
            @Override public void onStartTrackingTouch(SeekBar sb) {}
            @Override public void onStopTrackingTouch(SeekBar sb) { resetControlsTimer(); }
        });
        // Al perder foco el slider, ocultar el popup (vuelve al icono).
        volumeSeek.setOnFocusChangeListener((v, hasFocus) -> {
            if (!hasFocus && volumePopup != null) volumePopup.setVisibility(View.GONE);
        });


        // Amplificador: barra vertical con número (100%-300%), igual que el
        // volumen — se muestra solo al enfocar/seleccionar el botón.
        boostButton = controlsOverlay.findViewById(R.id.octo_boost);
        boostSeek = controlsOverlay.findViewById(R.id.octo_boost_seek);
        boostValueTv = controlsOverlay.findViewById(R.id.octo_boost_value);
        boostSeek.setProgress(boostPercent - 100);
        boostValueTv.setText(boostPercent + "%");
        boostSeek.getProgressDrawable().setColorFilter(ACCENT_COLOR, android.graphics.PorterDuff.Mode.SRC_IN);
        boostSeek.getThumb().setColorFilter(ACCENT_COLOR, android.graphics.PorterDuff.Mode.SRC_IN);
        boostPopup = controlsOverlay.findViewById(R.id.octo_boost_popup);
        boostButton.setOnClickListener(v -> {
            if (boostPopup == null) return;
            boolean show = boostPopup.getVisibility() != View.VISIBLE;
            boostPopup.setVisibility(show ? View.VISIBLE : View.GONE);
            if (volumePopup != null) volumePopup.setVisibility(View.GONE);
            if (show) boostSeek.requestFocus();
            resetControlsTimer();
        });
        boostSeek.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar sb, int progress, boolean fromUser) {
                boostPercent = 100 + progress;
                if (boostValueTv != null) boostValueTv.setText(boostPercent + "%");
                if (fromUser) {
                    applyVolumeBoost();
                    resetControlsTimer();
                }
            }
            @Override public void onStartTrackingTouch(SeekBar sb) {}
            @Override public void onStopTrackingTouch(SeekBar sb) { resetControlsTimer(); }
        });
        // Al perder foco el slider, ocultar el popup (vuelve al icono).
        boostSeek.setOnFocusChangeListener((v, hasFocus) -> {
            if (!hasFocus && boostPopup != null) boostPopup.setVisibility(View.GONE);
        });


        speedLabel = controlsOverlay.findViewById(R.id.octo_speed);
        speedLabel.setText(formatSpeed(currentSpeed));
        speedLabel.setOnClickListener(v -> showPlaybackSpeedMenu());

        // Cast: botón junto a los demás controles. Usa el framework nativo de
        // Google Cast (MediaRouter + CastContext) para mostrar el selector de
        // dispositivos del sistema. El SDK web (chrome.cast) no funciona en
        // Android WebView (Capacitor), así que delegamos al nativo.
        octoCastBtn = controlsOverlay.findViewById(R.id.octo_cast);
        if (octoCastBtn != null) {
            octoCastBtn.setColorFilter(Color.WHITE);
            try {
                // Inicializar CastContext y configurar el botón como MediaRouteButton
                Log.i(TAG, "castButton: initializing CastContext...");
                castContext = CastContext.getSharedInstance(getContext());
                if (castContext != null) {
                    Log.i(TAG, "castButton: CastContext initialized OK");
                    // CastButtonFactory necesita un MediaRouteButton; nuestro
                    // ImageButton no lo es, así que abrimos el diálogo manualmente.
                    octoCastBtn.setOnClickListener(v -> {
                        Log.i(TAG, "castButton: clicked, opening cast menu url=" + hostOf(currentUrl));
                        try {
                            showCastMenu();
                        } catch (Exception e) {
                            Log.e(TAG, "castButton error: " + e.getMessage());
                        }
                        resetControlsTimer();
                    });
                    // Listener para detectar cuando se conecta a un dispositivo
                    castSessionListener = new SessionManagerListener<CastSession>() {
                        @Override
                        public void onSessionStarted(CastSession session, String sessionId) {
                            Log.i(TAG, "castSession: started id=" + sessionId);
                            loadMediaOnCast(session);
                        }
                        @Override
                        public void onSessionEnded(CastSession session, int error) {
                            Log.i(TAG, "castSession: ended error=" + error);
                        }
                        @Override public void onSessionStarting(CastSession session) {}
                        @Override public void onSessionStartFailed(CastSession session, int error) {}
                        @Override public void onSessionEnding(CastSession session) {}
                        @Override public void onSessionResuming(CastSession session, String sessionId) {}
                        @Override public void onSessionResumed(CastSession session, boolean wasSuspended) {
                            loadMediaOnCast(session);
                        }
                        @Override public void onSessionResumeFailed(CastSession session, int error) {}
                        @Override public void onSessionSuspended(CastSession session, int reason) {}
                    };
                    castContext.getSessionManager().addSessionManagerListener(castSessionListener, CastSession.class);
                }
            } catch (Exception e) {
                Log.e(TAG, "CastContext init failed: " + e.getMessage());
                // El menú JS no se ve porque el ExoPlayer Dialog cubre el WebView:
                // se muestra el menú nativo showCastMenu (sin opción Chromecast).
                octoCastBtn.setOnClickListener(v -> {
                    Log.i(TAG, "castButton: clicked (fallback), showing cast menu url=" + hostOf(currentUrl));
                    showCastMenu();
                    resetControlsTimer();
                });
            }
        }

        // PiP: baja el stream actual a una mini-ventana con audio y cierra el
        // diálogo — el usuario navega y abre otro vídeo que sale muteado.
        octoPipBtn = controlsOverlay.findViewById(R.id.octo_pip);
        if (octoPipBtn != null) {
            octoPipBtn.setColorFilter(Color.WHITE);
            octoPipBtn.setOnClickListener(v -> {
                minimizeToPip();
            });
        }

        // Focus scale en la fila única de controles (octo_seek tiene su
        // propio listener de foco con engorde + commit de scrub).
        applyFocusScaleToAll((ViewGroup) controlsOverlay.findViewById(R.id.octo_row_transport));

        refreshFocusLinks();
    }

    // Reconstruye los enlaces de foco del D-pad: una sola fila de controles,
    // arriba el seek (VOD) o el logo (directo).
    private void refreshFocusLinks() {
        if (controlsOverlay == null) return;
        boolean canZap = "live".equals(playerMode) && liveChannels != null && liveChannels.length() > 1;
        View[] row = new View[]{
                octoChannelsBtn,
                octoEpisodesBtn,
                controlsOverlay.findViewById(R.id.octo_rew),
                octoPlayBtn,
                controlsOverlay.findViewById(R.id.octo_ffwd),
                octoStopBtn,
                controlsOverlay.findViewById(R.id.octo_volume),
                boostButton,
                controlsOverlay.findViewById(R.id.octo_subtitle),
                controlsOverlay.findViewById(R.id.octo_subdelay),
                speedLabel,
                controlsOverlay.findViewById(R.id.octo_settings),
                octoCastBtn,
                octoPipBtn};
        for (int i = 0; i < row.length; i++) {
            View view = row[i];
            if (view == null) continue;
            View left = previousAvailable(row, i);
            View right = nextAvailable(row, i);
            if (left != null) view.setNextFocusLeftId(left.getId());
            if (right != null) view.setNextFocusRightId(right.getId());
            // Arriba: seek en VOD, logo en directo
            View up = (octoSeek != null && octoSeek.getVisibility() == View.VISIBLE)
                    ? octoSeek
                    : (canZap ? octoLogo : null);
            if (up != null) view.setNextFocusUpId(up.getId());
        }
        if (octoSeek != null) {
            if (canZap && octoLogo != null) octoSeek.setNextFocusUpId(octoLogo.getId());
            if (octoPlayBtn != null) octoSeek.setNextFocusDownId(octoPlayBtn.getId());
        }
        if (octoLogo != null) {
            View down = (octoSeek != null && octoSeek.getVisibility() == View.VISIBLE)
                    ? octoSeek : octoPlayBtn;
            if (down != null) octoLogo.setNextFocusDownId(down.getId());
        }
    }

    private void resetControlsTimer() {
        mainHandler.removeCallbacks(hideControlsRunnable);
        mainHandler.postDelayed(hideControlsRunnable, 7000);
    }

    // ↑/↓ con el foco en el botón de volumen/amplificador: ajusta el valor
    // sin mover el foco a la barra (el mando no navega dentro del slider).
    private void adjustVolumeSeek(int delta) {
        if (volumeSeek == null) return;
        int progress = Math.max(0, Math.min(100, volumeSeek.getProgress() + delta));
        volumeSeek.setProgress(progress);
        if (player != null) player.setVolume(progress / 100f);
        resetControlsTimer();
    }

    private void adjustBoostSeek(int delta) {
        if (boostSeek == null) return;
        int progress = Math.max(0, Math.min(200, boostSeek.getProgress() + delta));
        boostSeek.setProgress(progress);
        applyVolumeBoost();
        resetControlsTimer();
    }

    private View previousAvailable(View[] views, int index) {
        for (int i = index - 1; i >= 0; i--) {
            View v = views[i];
            if (v != null && v.getVisibility() == View.VISIBLE && v.isFocusable()) return v;
        }
        return null;
    }

    private View nextAvailable(View[] views, int index) {
        for (int i = index + 1; i < views.length; i++) {
            View v = views[i];
            if (v != null && v.getVisibility() == View.VISIBLE && v.isFocusable()) return v;
        }
        return null;
    }

    // --- Seek: adelantar/atrasar ---------------------------------------------

    // Salto directo (ms) con clamp, refresco de barra/posición y timer de
    // auto-ocultado de los controles.
    private void seekByMs(long deltaMs) {
        if (player == null) return;
        long dur = player.getDuration();
        long target = player.getCurrentPosition() + deltaMs;
        if (dur > 0) target = Math.max(0, Math.min(dur, target));
        else target = Math.max(0, target);
        player.seekTo(target);
        if (octoSeek != null && dur > 0) octoSeek.setProgress((int) (target * 1000 / dur));
        if (octoPosition != null) octoPosition.setText(formatMs(target));
        updateControlsUi();
        resetControlsTimer();
    }

    // Seek acelerado por repetición: la 1ª pulsación salta 10s; mantener el
    // botón o pulsar rápido en la misma dirección sube el salto por la
    // escalera 15s → 30s → 60s → 90s → 120s (estilo Netflix/Prime en TV).
    private void seekByStep(int dir) {
        if (player == null) return;
        long now = android.os.SystemClock.uptimeMillis();
        if (dir != lastSeekDir || now - lastSeekAtMs > 1200) {
            seekStreak = 0;
            quickSeekAccumMs = 0;
        } else {
            seekStreak++;
        }
        lastSeekDir = dir;
        lastSeekAtMs = now;
        long[] steps = {10000, 15000, 30000, 60000, 90000, 120000};
        long step = steps[Math.min(seekStreak, steps.length - 1)];
        long dur = player.getDuration();
        // Nunca saltar más del 10% de la duración por pulsación.
        if (dur > 0) step = Math.min(step, Math.max(10000, dur / 10));
        quickSeekAccumMs += dir * step;
        seekByMs(dir * step);
        showSeekDelta(quickSeekAccumMs);
    }

    // Muestra el delta de seek junto a la posición ("+1:20" / "−0:30") y lo
    // limpia a los ~1,5s de inactividad.
    private void showSeekDelta(long deltaMs) {
        if (octoSeekDelta == null) return;
        octoSeekDelta.setText((deltaMs >= 0 ? "+" : "−") + formatMs(Math.abs(deltaMs)));
        mainHandler.removeCallbacks(clearSeekDeltaRunnable);
        mainHandler.postDelayed(clearSeekDeltaRunnable, 1500);
    }

    // Scrub con vista previa en la barra de progreso: ←/→ con el foco en la
    // barra acumulan un destino visible (la barra y la posición muestran el
    // punto elegido y el delta total) sin interrumpir el vídeo. Se confirma
    // con OK, al perder el foco, o tras ~1,2s sin pulsar; BACK lo cancela.
    private void scrubByStep(int dir) {
        if (player == null) return;
        long dur = player.getDuration();
        if (dur <= 0) return;
        long now = android.os.SystemClock.uptimeMillis();
        if (dir != scrubDir || now - scrubLastAtMs > 1200) scrubStreak = 0;
        else scrubStreak++;
        scrubDir = dir;
        scrubLastAtMs = now;
        if (!scrubActive) {
            scrubActive = true;
            controlsSeeking = true; // congela la barra frente al tick de posición
            scrubBaseMs = player.getCurrentPosition();
            scrubTargetMs = scrubBaseMs;
        }
        long[] steps = {10000, 15000, 30000, 60000, 90000, 120000};
        long step = steps[Math.min(scrubStreak, steps.length - 1)];
        step = Math.min(step, Math.max(10000, dur / 10));
        scrubTargetMs = Math.max(0, Math.min(dur, scrubTargetMs + dir * step));
        if (octoSeek != null) octoSeek.setProgress((int) (scrubTargetMs * 1000 / dur));
        if (octoPosition != null) octoPosition.setText(formatMs(scrubTargetMs));
        showSeekDelta(scrubTargetMs - scrubBaseMs);
        mainHandler.removeCallbacks(commitScrubRunnable);
        mainHandler.postDelayed(commitScrubRunnable, 1200);
        resetControlsTimer();
    }

    private void commitScrub() {
        if (!scrubActive) return;
        scrubActive = false;
        controlsSeeking = false;
        if (player != null) player.seekTo(scrubTargetMs);
        updateControlsUi();
        resetControlsTimer();
        mainHandler.removeCallbacks(clearSeekDeltaRunnable);
        mainHandler.postDelayed(clearSeekDeltaRunnable, 1500);
    }

    private void cancelScrub() {
        if (!scrubActive) return;
        scrubActive = false;
        controlsSeeking = false;
        mainHandler.removeCallbacks(commitScrubRunnable);
        if (octoSeekDelta != null) octoSeekDelta.setText("");
        updateControlsUi();
        resetControlsTimer();
    }

    // --- Live TV: overlay "qué se está emitiendo" + zapping --------------------

    private String formatClock(long epochSec) {
        java.text.SimpleDateFormat fmt = new java.text.SimpleDateFormat("HH:mm", java.util.Locale.getDefault());
        return fmt.format(new java.util.Date(epochSec * 1000));
    }

    // --- Controles propios (reemplazan al PlayerControlView de Media3) ---------

    private boolean handlePlayerBack() {
        // dispatchKeyEvent→onKeyDown y onBackPressed se disparan ambos por la
        // misma pulsación (predictive back, Android 13+): la 2ª invocación
        // llega a los pocos ms y cerraría una capa extra — ignorarla.
        long now = System.currentTimeMillis();
        if (now - lastBackHandledAt < BACK_DEBOUNCE_MS) return true;
        lastBackHandledAt = now;
        // BACK durante un scrub pendiente: cancela el salto, no cierra nada.
        if (scrubActive) {
            cancelScrub();
            return true;
        }
        if (volumeSeek != null && volumeSeek.hasFocus() && volumePopup != null) {
            volumePopup.setVisibility(View.GONE);
            View vb = controlsOverlay != null ? controlsOverlay.findViewById(R.id.octo_volume) : null;
            if (vb != null) vb.requestFocus();
            return true;
        }
        if (boostSeek != null && boostSeek.hasFocus() && boostPopup != null) {
            boostPopup.setVisibility(View.GONE);
            if (boostButton != null) boostButton.requestFocus();
            return true;
        }
        if (overlayView != null) {
            dismissOverlay();
            return true;
        }
        if (isChannelListVisible()) {
            hideChannelList();
            return true;
        }
        // Doble Back para salir: la primera pulsación avisa, la segunda
        // (dentro de BACK_EXIT_WINDOW_MS) cierra el player.
        if (now - backExitPressedAt > BACK_EXIT_WINDOW_MS) {
            backExitPressedAt = now;
            showControls();
            Toast.makeText(getContext(), "Pulsa atrás otra vez para salir", Toast.LENGTH_SHORT).show();
            return true;
        }
        backExitPressedAt = 0;
        suppressBackUntilOpen = true;
        closePlayer();
        return true;
    }

    private boolean isControlsVisible() {
        return controlsOverlay != null && controlsOverlay.getVisibility() == View.VISIBLE;
    }

    private void showControls() {
        if (controlsOverlay == null) return;
        controlsOverlay.setVisibility(View.VISIBLE);
        if (topBar != null) topBar.setVisibility(View.VISIBLE);
        updateControlsUi();
        mainHandler.removeCallbacks(hideControlsRunnable);
        mainHandler.postDelayed(hideControlsRunnable, 7000);
        mainHandler.removeCallbacks(controlsTickRunnable);
        mainHandler.post(controlsTickRunnable);
        // Foco en play
        if (octoPlayBtn != null) octoPlayBtn.requestFocus();
    }

    private void hideControls() {
        if (controlsOverlay != null) controlsOverlay.setVisibility(View.GONE);
        if (topBar != null) topBar.setVisibility(View.GONE);
        mainHandler.removeCallbacks(hideControlsRunnable);
        mainHandler.removeCallbacks(controlsTickRunnable);
        // Devolver el foco al rootLayout para que el D-pad siga llegando.
        // Con un menú overlay abierto NO se mueve el foco: robarlo dejaría
        // el menú visible pero inerte al D-pad.
        if (overlayView == null && rootLayoutRef != null) rootLayoutRef.requestFocus();
    }

    private ViewGroup rootLayoutRef = null;

    private void updateControlsUi() {
        if (clockView != null) clockView.setText(clockFormat.format(new java.util.Date()));
        if (controlsOverlay == null || player == null) return;
        long pos = player.getCurrentPosition();
        long dur = player.getDuration();
        // La UI de TV (EPG, logo, sin seek) solo depende del modo explícito,
        // no de si el stream HLS reporta "live". Los streams U7D de Mediaset
        // pueden reportar isCurrentMediaItemLive() aunque sean VOD grabado.
        boolean live = "live".equals(playerMode);

        // Fila EPG (logo + programa) solo en directo; tiempos+seek solo en VOD
        if (octoInfoRow != null) octoInfoRow.setVisibility(live ? View.VISIBLE : View.GONE);
        // Durante scrub/touch-drag el texto lo escribe el propio scrub.
        if (octoPosition != null && !controlsSeeking) {
            octoPosition.setText(live ? "" : formatMs(pos));
        }
        if (octoDuration != null) octoDuration.setText(live ? "" : (dur > 0 ? formatMs(dur) : "--:--"));
        // EPG start/end times (directo)
        if (octoEpgStartTv != null) {
            octoEpgStartTv.setText((live && epgNowStart > 0) ? formatClock(epgNowStart) : "");
        }
        if (octoEpgEndTv != null) {
            octoEpgEndTv.setText((live && epgNowEnd > 0) ? formatClock(epgNowEnd) : "");
        }
        if (octoSeek != null) {
            if (live || dur <= 0) {
                octoSeek.setVisibility(View.GONE);
            } else {
                octoSeek.setVisibility(View.VISIBLE);
                if (!controlsSeeking) {
                    octoSeek.setProgress((int) (pos * 1000 / Math.max(1, dur)));
                }
            }
        }
        // Barra de progreso del programa EPG (solo directo con horarios)
        if (octoProg != null) {
            if (live && epgNowStart > 0 && epgNowEnd > epgNowStart) {
                long nowSec = System.currentTimeMillis() / 1000;
                int prog = (int) ((nowSec - epgNowStart) * 1000 / (epgNowEnd - epgNowStart));
                octoProg.setVisibility(View.VISIBLE);
                octoProg.setProgress(Math.max(0, Math.min(1000, prog)));
            } else {
                octoProg.setVisibility(View.GONE);
            }
        }
        if (octoPlayBtn != null) {
            octoPlayBtn.setImageResource(player.isPlaying()
                    ? androidx.media3.ui.R.drawable.exo_styled_controls_pause
                    : androidx.media3.ui.R.drawable.exo_styled_controls_play);
        }

        if (octoLiveBadge != null) {
            octoLiveBadge.setVisibility(live && epgNow != null && !epgNow.isEmpty()
                    ? View.VISIBLE : View.GONE);
        }
        if (live) {
            // Programa actual + horario EPG (arriba de la barra de progreso)
            if (octoNowTv != null) {
                StringBuilder now = new StringBuilder();
                if (epgNow != null && !epgNow.isEmpty()) now.append(epgNow);
                if (epgNowStart > 0 && epgNowEnd > epgNowStart) {
                    now.append("   ").append(formatClock(epgNowStart))
                       .append(" - ").append(formatClock(epgNowEnd));
                }
                octoNowTv.setText(now.toString());
            }
            if (octoNextTv != null) {
                octoNextTv.setText(epgNext != null && !epgNext.isEmpty()
                        ? "A continuación: " + epgNext : "");
            }
            // Logo del canal: de la lista de canales o, si no hay lista
            // (reproducción directa desde historial/favoritos), del que vino
            // en la llamada play().
            String logo = channelFieldAt(channelIndex, "logo");
            if (logo.isEmpty() && channelLogoFallback != null) logo = channelLogoFallback;
            if (logo != null && !logo.equals(currentLogoUrl)) {
                currentLogoUrl = logo;
                loadChannelLogo(logo);
            }
            // Top bar: nombre del canal + EPG
            if (playerTitleView != null) {
                String name = channelNameAt(channelIndex);
                if (!name.isEmpty()) playerTitleView.setText(name);
            }
            if (playerSubtitleView != null) {
                StringBuilder sub = new StringBuilder();
                if (epgNow != null && !epgNow.isEmpty()) sub.append("Ahora: ").append(epgNow);
                if (epgNext != null && !epgNext.isEmpty()) {
                    if (sub.length() > 0) sub.append("  ·  ");
                    sub.append("Luego: ").append(epgNext);
                }
                playerSubtitleView.setText(sub.toString());
            }
        }
        refreshFocusLinks();
    }

    // Carga el logo del canal en background con caché en memoria.
    private void loadChannelLogo(String url) {
        if (octoLogo == null) return;
        currentLogoUrl = url;
        if (url == null || url.isEmpty()) {
            octoLogo.setImageDrawable(null);
            octoLogo.setBackgroundColor(Color.TRANSPARENT);
            return;
        }
        android.graphics.Bitmap cached = logoCache.get(url);
        if (cached != null) {
            octoLogo.setImageBitmap(cached);
            return;
        }
        new Thread(() -> {
            try {
                java.net.HttpURLConnection conn =
                        (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
                conn.setConnectTimeout(5000);
                conn.setReadTimeout(5000);
                android.graphics.Bitmap bmp =
                        android.graphics.BitmapFactory.decodeStream(conn.getInputStream());
                conn.disconnect();
                if (bmp != null) {
                    logoCache.put(url, bmp);
                    mainHandler.post(() -> {
                        if (octoLogo != null && url.equals(currentLogoUrl)) octoLogo.setImageBitmap(bmp);
                    });
                }
            } catch (Exception ignored) {}
        }).start();
    }

    private String formatMs(long ms) {
        if (ms < 0) ms = 0;
        long totalSec = ms / 1000;
        long h = totalSec / 3600;
        long m = (totalSec % 3600) / 60;
        long s = totalSec % 60;
        if (h > 0) return String.format(java.util.Locale.US, "%d:%02d:%02d", h, m, s);
        return String.format(java.util.Locale.US, "%02d:%02d", m, s);
    }

    // --- Panel lateral de canales estilo Netfly --------------------------------

    private LinearLayout buildChannelListPanel(Context context) {
        LinearLayout panel = new LinearLayout(context);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setBackgroundColor(0xF20E1116);
        panel.setPadding(0, dp(14), 0, dp(12));
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                dp(360), ViewGroup.LayoutParams.MATCH_PARENT, Gravity.START | Gravity.TOP);
        panel.setLayoutParams(lp);
        panel.setVisibility(View.GONE);

        TextView header = new TextView(context);
        header.setText("CANALES");
        header.setTextColor(0xFF9E9E9E);
        header.setTextSize(13f);
        header.setTypeface(null, android.graphics.Typeface.BOLD);
        header.setPadding(dp(16), 0, 0, dp(8));
        panel.addView(header);

        ScrollView scroll = new ScrollView(context);
        scroll.setVerticalScrollBarEnabled(false);
        channelListContainer = new LinearLayout(context);
        channelListContainer.setOrientation(LinearLayout.VERTICAL);
        channelListContainer.setFocusable(false);
        scroll.addView(channelListContainer);
        panel.addView(scroll, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        populateChannelList(context);
        return panel;
    }

    private void populateChannelList(Context context) {
        if (channelListContainer == null || liveChannels == null) return;
        channelListContainer.removeAllViews();
        for (int i = 0; i < liveChannels.length(); i++) {
            final int idx = i;
            String name = "";
            String now = "";
            try {
                Object item = liveChannels.get(i);
                if (item instanceof JSONObject) {
                    JSONObject ch = (JSONObject) item;
                    name = ch.optString("name", ch.optString("title", ""));
                    now = ch.optString("now", "");
                } else {
                    name = String.valueOf(item);
                }
            } catch (Exception ignored) {}

            LinearLayout row = new LinearLayout(context);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setPadding(dp(16), dp(9), dp(12), dp(9));
            row.setFocusable(true);
            row.setClickable(true);

            TextView num = new TextView(context);
            num.setText(String.valueOf(i + 1));
            num.setTextColor(ACCENT_COLOR);
            num.setTextSize(15f);
            num.setTypeface(null, android.graphics.Typeface.BOLD);
            row.addView(num, new LinearLayout.LayoutParams(dp(44), ViewGroup.LayoutParams.WRAP_CONTENT));

            LinearLayout texts = new LinearLayout(context);
            texts.setOrientation(LinearLayout.VERTICAL);
            TextView nameTv = new TextView(context);
            nameTv.setText(name);
            nameTv.setTextColor(Color.WHITE);
            nameTv.setTextSize(15f);
            nameTv.setMaxLines(1);
            nameTv.setEllipsize(TextUtils.TruncateAt.END);
            texts.addView(nameTv);
            if (!now.isEmpty()) {
                TextView nowTv = new TextView(context);
                nowTv.setText(now);
                nowTv.setTextColor(0xFF9E9E9E);
                nowTv.setTextSize(12f);
                nowTv.setMaxLines(1);
                nowTv.setEllipsize(TextUtils.TruncateAt.END);
                texts.addView(nowTv);
            }
            row.addView(texts, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

            row.setOnClickListener(v -> zapToIndex(idx, true));
            row.setOnFocusChangeListener((v, hasFocus) -> {
                if (hasFocus) {
                    v.setBackgroundColor(0x557B5BF5);
                } else {
                    v.setBackgroundColor(idx == channelIndex ? 0x227B5BF5 : Color.TRANSPARENT);
                }
            });
            if (i == channelIndex) row.setBackgroundColor(0x227B5BF5);
            channelListContainer.addView(row);
        }
    }

    private boolean isChannelListVisible() {
        return channelListPanel != null && channelListPanel.getVisibility() == View.VISIBLE;
    }

    private void showChannelList() {
        if (channelListPanel == null) return;
        channelListPanel.setVisibility(View.VISIBLE);
        // Foco en el canal actual
        mainHandler.post(() -> {
            if (channelListContainer != null && channelIndex >= 0
                    && channelIndex < channelListContainer.getChildCount()) {
                channelListContainer.getChildAt(channelIndex).requestFocus();
            }
        });
    }

    private void hideChannelList() {
        if (channelListPanel != null) channelListPanel.setVisibility(View.GONE);
    }

    // --- Panel lateral de episodios de la temporada (series VOD) -------------

    private LinearLayout buildEpisodeListPanel(Context context) {
        LinearLayout panel = new LinearLayout(context);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setBackgroundColor(0xF20E1116);
        panel.setPadding(0, dp(14), 0, dp(12));
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                dp(360), ViewGroup.LayoutParams.MATCH_PARENT, Gravity.START | Gravity.TOP);
        panel.setLayoutParams(lp);
        panel.setVisibility(View.GONE);

        TextView header = new TextView(context);
        header.setText("EPISODIOS");
        header.setTextColor(0xFF9E9E9E);
        header.setTextSize(13f);
        header.setTypeface(null, android.graphics.Typeface.BOLD);
        header.setPadding(dp(16), 0, 0, dp(8));
        panel.addView(header);

        ScrollView scroll = new ScrollView(context);
        scroll.setVerticalScrollBarEnabled(false);
        episodeListContainer = new LinearLayout(context);
        episodeListContainer.setOrientation(LinearLayout.VERTICAL);
        episodeListContainer.setFocusable(false);
        scroll.addView(episodeListContainer);
        panel.addView(scroll, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        populateEpisodeList(context);
        return panel;
    }

    private void populateEpisodeList(Context context) {
        if (episodeListContainer == null || episodeList == null) return;
        episodeListContainer.removeAllViews();
        for (int i = 0; i < episodeList.length(); i++) {
            final int idx = i;
            String name = "";
            int epNum = 0;
            int season = 0;
            boolean watched = false;
            try {
                JSONObject ep = episodeList.optJSONObject(i);
                if (ep != null) {
                    name = ep.optString("name", "");
                    epNum = ep.optInt("episode", i + 1);
                    season = ep.optInt("season", 0);
                    watched = ep.optBoolean("watched", false);
                }
            } catch (Exception ignored) {}
            if (name.isEmpty()) name = "Episodio " + epNum;

            LinearLayout row = new LinearLayout(context);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setPadding(dp(16), dp(9), dp(12), dp(9));
            row.setFocusable(true);
            row.setClickable(true);

            TextView num = new TextView(context);
            num.setText("E" + epNum);
            num.setTextColor(ACCENT_COLOR);
            num.setTextSize(15f);
            num.setTypeface(null, android.graphics.Typeface.BOLD);
            row.addView(num, new LinearLayout.LayoutParams(dp(48), ViewGroup.LayoutParams.WRAP_CONTENT));

            TextView nameTv = new TextView(context);
            nameTv.setText(name);
            nameTv.setTextColor(Color.WHITE);
            nameTv.setTextSize(15f);
            nameTv.setMaxLines(1);
            nameTv.setEllipsize(TextUtils.TruncateAt.END);
            row.addView(nameTv, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

            if (watched) {
                TextView check = new TextView(context);
                check.setText("✓");
                check.setTextColor(0xFF4CAF50);
                check.setTextSize(15f);
                check.setTypeface(null, android.graphics.Typeface.BOLD);
                check.setPadding(dp(8), 0, 0, 0);
                row.addView(check);
            }

            final int epSeason = season;
            final int epNumber = epNum;
            row.setOnClickListener(v -> selectEpisodeAt(idx, epSeason, epNumber));
            row.setOnFocusChangeListener((v, hasFocus) -> {
                if (hasFocus) {
                    v.setBackgroundColor(0x557B5BF5);
                } else {
                    v.setBackgroundColor(idx == episodeIndex ? 0x227B5BF5 : Color.TRANSPARENT);
                }
            });
            if (i == episodeIndex) row.setBackgroundColor(0x227B5BF5);
            episodeListContainer.addView(row);
        }
    }

    private boolean isEpisodeListVisible() {
        return episodeListPanel != null && episodeListPanel.getVisibility() == View.VISIBLE;
    }

    private void showEpisodeList() {
        if (episodeListPanel == null) return;
        episodeListPanel.setVisibility(View.VISIBLE);
        // Foco en el episodio actual
        mainHandler.post(() -> {
            if (episodeListContainer != null && episodeIndex >= 0
                    && episodeIndex < episodeListContainer.getChildCount()) {
                episodeListContainer.getChildAt(episodeIndex).requestFocus();
            } else if (episodeListContainer != null && episodeListContainer.getChildCount() > 0) {
                episodeListContainer.getChildAt(0).requestFocus();
            }
        });
    }

    private void hideEpisodeList() {
        if (episodeListPanel != null) episodeListPanel.setVisibility(View.GONE);
    }

    private void selectEpisodeAt(int idx, int season, int episode) {
        hideEpisodeList();
        // Aviso transitorio mientras JS resuelve los enlaces del episodio (el
        // episodio actual sigue reproduciéndose). No usar showStreamLoading:
        // si la resolución falla ese overlay no se cerraría nunca.
        Toast.makeText(getContext(), "Cargando episodio E" + episode + "…", Toast.LENGTH_LONG).show();
        JSObject data = new JSObject();
        data.put("index", idx);
        data.put("season", season);
        data.put("episode", episode);
        notifyListeners("episodeSelected", data);
    }

    private void zapToIndex(int idx) { zapToIndex(idx, false); }

    private void zapToIndex(int idx, boolean immediate) {
        if (liveChannels == null || idx < 0 || idx >= liveChannels.length()) return;
        hideChannelList();
        int direction = idx >= channelIndex ? 1 : -1;
        channelIndex = idx;
        String name = channelNameAt(idx);
        String now = channelFieldAt(idx, "now");
        String next = channelFieldAt(idx, "next");
        epgNow = now;
        epgNext = next;
        Log.i(TAG, "zapToIndex: idx=" + idx + " name=" + name + " now=" + now + " channels=" + liveChannels.length() + " immediate=" + immediate);
        updateControlsUi();
        // Al cambiar de canal, mostrar los controles para feedback visual.
        showControls();
        // Disparar el evento a JS. Con debounce (zapping con flechas): esperar
        // 400ms tras la última tecla para que solo haya un switchChannel por
        // ráfaga. Sin debounce (click directo en la lista de canales): disparar
        // inmediatamente para que no se sienta lento.
        final int fireIdx = idx;
        final int fireDir = direction;
        final String fireName = name;
        Runnable fire = () -> {
            zapDebounceRunnable = null;
            JSObject data = new JSObject();
            data.put("index", fireIdx);
            data.put("direction", fireDir);
            data.put("name", fireName);
            notifyListeners("channelZap", data);
        };
        if (immediate) {
            if (zapDebounceRunnable != null) {
                mainHandler.removeCallbacks(zapDebounceRunnable);
                zapDebounceRunnable = null;
            }
            pendingZapIndex = -1;
            fire.run();
        } else {
            pendingZapIndex = idx;
            if (zapDebounceRunnable != null) mainHandler.removeCallbacks(zapDebounceRunnable);
            zapDebounceRunnable = fire;
            mainHandler.postDelayed(zapDebounceRunnable, 400);
        }
    }

    private String channelNameAt(int index) {
        if (liveChannels == null || index < 0 || index >= liveChannels.length()) return "";
        try {
            Object item = liveChannels.get(index);
            if (item instanceof JSONObject) {
                String n = ((JSONObject) item).optString("name", "");
                return n.isEmpty() ? ((JSONObject) item).optString("title", "") : n;
            }
            return String.valueOf(item);
        } catch (Exception e) {
            return "";
        }
    }

    private String channelFieldAt(int index, String field) {
        if (liveChannels == null || index < 0 || index >= liveChannels.length()) return "";
        try {
            Object item = liveChannels.get(index);
            if (!(item instanceof JSONObject)) return "";
            JSONObject channel = (JSONObject) item;
            String value = channel.optString(field, "");
            if (value.isEmpty() && "now".equals(field)) value = channel.optString("nowPlaying", "");
            if (value.isEmpty() && "next".equals(field)) value = channel.optString("nextPlaying", "");
            return value;
        } catch (Exception e) {
            return "";
        }
    }

    private long channelLongFieldAt(int index, String field) {
        if (liveChannels == null || index < 0 || index >= liveChannels.length()) return 0;
        try {
            Object item = liveChannels.get(index);
            if (!(item instanceof JSONObject)) return 0;
            JSONObject channel = (JSONObject) item;
            String fallback = "start".equals(field) ? "nowPlayingStart" : "nowPlayingEnd";
            Object value = channel.opt(field);
            if (value == null || value.toString().isEmpty()) value = channel.opt(fallback);
            if (value instanceof Number) return ((Number) value).longValue();
            return Long.parseLong(String.valueOf(value));
        } catch (Exception e) {
            return 0;
        }
    }

    private void zapChannel(int direction) {
        Log.i(TAG, "zapChannel: dir=" + direction + " liveChannels=" + (liveChannels == null ? "null" : liveChannels.length()) + " channelIndex=" + channelIndex);
        if (liveChannels == null || liveChannels.length() == 0) return;
        int size = liveChannels.length();
        int curIdx = channelIndex;
        // Fallback: si channelIndex es -1 (no se pudo resolver por ID),
        // buscar el canal actual por nombre para que el zapping empiece desde
        // el canal correcto en vez de ir al primero (índice 0).
        if (curIdx < 0 && currentChannelName != null && !currentChannelName.isEmpty()) {
            for (int i = 0; i < size; i++) {
                String name = channelNameAt(i);
                if (name != null && name.equals(currentChannelName)) {
                    curIdx = i;
                    Log.i(TAG, "zapChannel: found current channel by name '" + currentChannelName + "' at index " + i);
                    break;
                }
            }
        }
        int newIndex = curIdx < 0 ? 0 : (curIdx + direction + size) % size;
        zapToIndex(newIndex);
    }

    // Actualiza la lista de canales y el EPG en caliente, sin reabrir el player.
    // Necesario porque la lista puede cargar de forma asíncrona después de que
    // empiece la reproducción (ruta Details → live) y porque el EPG se refresca.
    @PluginMethod
    public void setChannels(PluginCall call) {
        JSONArray channels = call.getArray("channels", null);
        int idx = call.getInt("channelIndex", -1);
        Log.i(TAG, "setChannels: parsed channels=" + (channels == null ? "null" : channels.length()) + " idx=" + idx);
        mainHandler.post(() -> {
            Log.i(TAG, "setChannels: on main thread, channels=" + (channels == null ? "null" : channels.length()));
            liveChannels = channels;
            if (channels != null && channels.length() > 1 && !"youtube".equals(playerMode)) {
                playerMode = "live";
                Log.i(TAG, "setChannels: inferred live mode for " + channels.length() + " channels");
            }
            if (idx >= 0) {
                channelIndex = idx;
            } else if (channelIndex < 0 && channels != null && currentChannelName != null && !currentChannelName.isEmpty()) {
                // Fallback: buscar el canal actual por nombre si channelIndex es -1
                for (int i = 0; i < channels.length(); i++) {
                    String name = channelNameAt(i);
                    if (name != null && name.equals(currentChannelName)) {
                        channelIndex = i;
                        Log.i(TAG, "setChannels: found current channel by name '" + currentChannelName + "' at index " + i);
                        break;
                    }
                }
            }
            // Actualizar EPG del canal actual con lo que venga en la lista
            if (liveChannels != null && channelIndex >= 0 && channelIndex < liveChannels.length()) {
                String now = channelFieldAt(channelIndex, "now");
                String next = channelFieldAt(channelIndex, "next");
                if (!now.isEmpty()) epgNow = now;
                if (!next.isEmpty()) epgNext = next;
            }
            // Si el panel de canales no existía (llegó channels: null al abrir)
            // y ahora hay lista, crearlo y añadirlo al root. Si ya existía,
            // repoblarlo con la lista nueva.
            if (channelListPanel == null && liveChannels != null && liveChannels.length() > 1
                    && rootLayoutRef != null) {
                channelListPanel = buildChannelListPanel(getContext());
                rootLayoutRef.addView(channelListPanel);
            } else if (channelListPanel != null && channelListContainer != null
                    && liveChannels != null && liveChannels.length() > 1) {
                populateChannelList(getContext());
            }
            updateControlsUi();
            updatePlayerSubtitle(channelNameAt(channelIndex));
            Log.i(TAG, "setChannels: done, liveChannels now=" + (liveChannels == null ? "null" : liveChannels.length()));
            call.resolve();
        });
    }

    // Actualiza la lista de episodios de la temporada sin reabrir el player
    // (p. ej. si la lista llega después de empezar la reproducción).
    @PluginMethod
    public void setEpisodes(PluginCall call) {
        JSONArray episodes = call.getArray("episodes", null);
        int idx = call.getInt("episodeIndex", -1);
        mainHandler.post(() -> {
            episodeList = episodes;
            episodeIndex = idx;
            if (octoEpisodesBtn != null) {
                boolean show = episodeList != null && episodeList.length() > 0
                        && !"live".equals(playerMode);
                octoEpisodesBtn.setVisibility(show ? View.VISIBLE : View.GONE);
                refreshFocusLinks();
            }
            if (episodeList != null && episodeList.length() > 0) {
                if (episodeListPanel == null && rootLayoutRef != null) {
                    episodeListPanel = buildEpisodeListPanel(getContext());
                    rootLayoutRef.addView(episodeListPanel);
                } else if (episodeListContainer != null) {
                    populateEpisodeList(getContext());
                }
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void switchChannel(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty() || player == null) {
            call.reject("url required or player not active");
            return;
        }
        Uri parsedZap = Uri.parse(url);
        String zapScheme = parsedZap.getScheme();
        if (zapScheme == null || !(zapScheme.equalsIgnoreCase("http") || zapScheme.equalsIgnoreCase("https"))) {
            call.reject("invalid url scheme: only http/https are allowed");
            return;
        }
        mainHandler.post(() -> {
            try {
                currentUrl = url != null ? url : "";
                String streamType = call.getString("streamType", "hls");
                boolean direct = call.getBoolean("direct", false);
                String title = call.getString("title", "");
                int idx = call.getInt("channelIndex", channelIndex);
                String now = call.getString("epgNow", null);
                String next = call.getString("epgNext", null);
                epgNowStart = call.getDouble("epgStart", 0.0).longValue();
                epgNowEnd = call.getDouble("epgEnd", 0.0).longValue();
                JSONObject headersJson = call.getObject("headers", new JSObject());
                if (idx >= 0) channelIndex = idx;
                if (title != null && !title.isEmpty()) currentChannelName = title;
                epgNow = now;
                epgNext = next;

                // Reuse the same routing policy as initial playback. The old
                // implementation always used DefaultHttpDataSource here, so a
                // channel zap silently bypassed WARP for non-TDT streams.
                Map<String, String> headers = parseHeaders(headersJson);
                currentStreamType = streamType;
                currentDirect = direct;
                currentHeaders = headers;
                lastSourceUsedWarp = shouldUseWarpProxy(url, direct, false);
                DataSource.Factory dsFactory = buildStreamDataSourceFactory(url, headers, direct, false);
                // Al hacer zapping el subtítulo externo ya no aplica.
                externalSubUrl = null;
                pendingSelectExternalSub = false;
                lastDataSourceFactory = dsFactory;
                lastStreamType = streamType;
                lastDrmSessionManager = null;
                lastLicenseUrl = null;
                MediaSource source = buildMediaSource(url, streamType, dsFactory, null, null);
                // No llamar a player.stop() antes de setMediaSource: el propio
                // setMediaSource + prepare resetean el player y la sesión de audio
                // correctamente. El stop() explícito puede dejar la sesión de audio
                // en un estado intermedio cuando se hace zapping rápido, causando
                // que todos los canales se queden sin audio.
                float savedVolume = player.getVolume();
                player.setMediaSource(source);
                lastMediaSource = source;
                player.prepare();
                // Restore volume — setMediaSource puede resetearla a 0 en algunos casos.
                if (savedVolume > 0f) player.setVolume(savedVolume);
                player.play();
                updatePlayerSubtitle(title.isEmpty() ? channelNameAt(channelIndex) : title);
                updateControlsUi();
                call.resolve(new JSObject().put("status", "switched"));
            } catch (Exception e) {
                call.reject("switchChannel failed: " + e.getMessage());
            }
        });
    }

    // ─── Mini-player PiP ─────────────────────────────────────────────────
    // Segundo ExoPlayer ligero en una vista flotante. Regla de audio: el mini
    // siempre suena; el principal queda muteado (setVolume(0)) mientras haya
    // PiP, y no pide audio focus (setAudioAttributes con handleAudioFocus=false
    // en el mini evita peleas de foco entre los dos players).

    @PluginMethod
    public void playPip(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("url is required");
            return;
        }
        Uri parsed = Uri.parse(url);
        String scheme = parsed.getScheme();
        if (scheme == null || !(scheme.equalsIgnoreCase("http") || scheme.equalsIgnoreCase("https"))) {
            call.reject("invalid url scheme: only http/https are allowed");
            return;
        }
        String type = call.getString("streamType", "hls");
        boolean direct = call.getBoolean("direct", false);
        Map<String, String> headers = parseHeaders(call.getObject("headers", new JSObject()));
        String title = call.getString("title", "");
        mainHandler.post(() -> {
            try {
                showPip(url, type, headers, direct, title);
                call.resolve(new JSObject().put("status", "pip"));
            } catch (Exception e) {
                call.reject("playPip failed: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void stopPip(PluginCall call) {
        mainHandler.post(() -> {
            stopPipInternal();
            call.resolve();
        });
    }

    @PluginMethod
    public void isPipActive(PluginCall call) {
        call.resolve(new JSObject().put("active", pipPlayer != null));
    }

    private static AudioAttributes mainAudioAttrs() {
        return new AudioAttributes.Builder().setContentType(2).setUsage(1).build();
    }

    // Política de enrutado WARP compartida por openPlayer/zapChannel: decide si
    // una URL debe salir por el proxy HTTP local de CloudProxy.
    private boolean shouldUseWarpProxy(String url, boolean direct, boolean forceBypassProxy) {
        if (forceBypassProxy || direct) return false;
        if (isTdtSpainDomain(url) || isLoopbackUrl(url)) return false;
        String socksProxy = com.octostream.cloudproxy.CloudProxyPlugin.getSocksProxy();
        return socksProxy != null && !socksProxy.isEmpty();
    }

    // Construye el DataSource.Factory del stream principal (o de un zap),
    // enrutando por WARP salvo que forceBypassProxy fuerce directo — se usa
    // cuando el túnel WARP local está caído y reintentar por el mismo proxy
    // roto nunca se recuperaría (ver onPlayerError / isWarpConnRefused).
    private DataSource.Factory buildStreamDataSourceFactory(String url, Map<String, String> headers,
            boolean direct, boolean forceBypassProxy) {
        String ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
        if (shouldUseWarpProxy(url, direct, forceBypassProxy)) {
            try {
                String socksProxy = com.octostream.cloudproxy.CloudProxyPlugin.getSocksProxy();
                String[] parts = socksProxy.split(":", 2);
                OkHttpClient.Builder clientBuilder = new OkHttpClient.Builder()
                        .connectTimeout(15, TimeUnit.SECONDS)
                        .readTimeout(30, TimeUnit.SECONDS)
                        .followRedirects(true)
                        .followSslRedirects(true)
                        .proxy(new java.net.Proxy(
                                java.net.Proxy.Type.HTTP,
                                new java.net.InetSocketAddress(parts[0], Integer.parseInt(parts[1]))));
                Log.i(TAG, "Using WARP HTTP proxy " + socksProxy + " for movie/stream URL (remote DNS)");
                OkHttpDataSource.Factory okHttpFactory = new OkHttpDataSource.Factory(clientBuilder.build())
                        .setUserAgent(ua);
                if (!headers.isEmpty()) okHttpFactory.setDefaultRequestProperties(headers);
                return new DefaultDataSource.Factory(getContext(), okHttpFactory);
            } catch (Exception e) {
                Log.e(TAG, "Failed to create OkHttpDataSource with WARP proxy: " + e.getMessage());
                // cae al factory directo de abajo
            }
        }
        DefaultHttpDataSource.Factory httpFactory = new DefaultHttpDataSource.Factory()
                .setAllowCrossProtocolRedirects(true)
                .setConnectTimeoutMs(15000)
                .setReadTimeoutMs(30000)
                .setUserAgent(ua);
        if (!headers.isEmpty()) httpFactory.setDefaultRequestProperties(headers);
        if (forceBypassProxy) Log.i(TAG, "Using DefaultHttpDataSource — bypass de WARP tras fallo del proxy local");
        return new DefaultDataSource.Factory(getContext(), httpFactory);
    }

    // Detecta si un PlaybackException viene de que el proxy HTTP local de WARP
    // (127.0.0.1:puerto) rechazó la conexión — el túnel Aether está caído o
    // reconectando. Reintentar con el mismo factory nunca se recupera solo.
    private static boolean isWarpConnRefused(Throwable t) {
        int depth = 0;
        while (t != null && depth++ < 8) {
            if (t instanceof java.net.ConnectException) {
                String m = t.getMessage();
                if (m != null && m.contains("127.0.0.1")) return true;
            }
            t = t.getCause();
        }
        return false;
    }

    private DataSource.Factory makePipDsFactory(String url, Map<String, String> headers, boolean direct) {
        String warpProxy = com.octostream.cloudproxy.CloudProxyPlugin.getSocksProxy();
        boolean loopback = isLoopbackUrl(url);
        String ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
        if (!direct && !loopback && warpProxy != null && !warpProxy.isEmpty()) {
            String[] parts = warpProxy.split(":", 2);
            OkHttpClient.Builder clientBuilder = new OkHttpClient.Builder()
                    .connectTimeout(15, TimeUnit.SECONDS)
                    .readTimeout(30, TimeUnit.SECONDS)
                    .followRedirects(true)
                    .followSslRedirects(true)
                    .proxy(new java.net.Proxy(
                            java.net.Proxy.Type.HTTP,
                            new java.net.InetSocketAddress(parts[0], Integer.parseInt(parts[1]))));
            OkHttpDataSource.Factory okHttpFactory = new OkHttpDataSource.Factory(clientBuilder.build())
                    .setUserAgent(ua);
            if (!headers.isEmpty()) okHttpFactory.setDefaultRequestProperties(headers);
            return new DefaultDataSource.Factory(getContext(), okHttpFactory);
        }
        DefaultHttpDataSource.Factory httpFactory = new DefaultHttpDataSource.Factory()
                .setAllowCrossProtocolRedirects(true)
                .setConnectTimeoutMs(15000)
                .setReadTimeoutMs(30000)
                .setUserAgent(ua);
        if (!headers.isEmpty()) httpFactory.setDefaultRequestProperties(headers);
        return new DefaultDataSource.Factory(getContext(), httpFactory);
    }

    private void attachPipToBestParent() {
        if (pipLayout == null) return;
        ViewGroup parent = (dialog != null && dialog.isShowing() && rootLayoutRef != null)
                ? rootLayoutRef
                : (ViewGroup) getActivity().getWindow().getDecorView();
        if (pipLayout.getParent() == parent) return;
        if (pipLayout.getParent() != null) {
            ((ViewGroup) pipLayout.getParent()).removeView(pipLayout);
        }
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                dp(340), dp(191), Gravity.BOTTOM | Gravity.END);
        lp.setMargins(0, 0, dp(24), dp(24));
        parent.addView(pipLayout, lp);
        pipLayout.setElevation(dp(6));
        // Los overlays de controles deben quedar por encima del mini.
        if (controlsOverlay != null && controlsOverlay.getParent() == parent) controlsOverlay.bringToFront();
        if (topBar != null && topBar.getParent() == parent) topBar.bringToFront();
        if (channelListPanel != null) channelListPanel.bringToFront();
        if (episodeListPanel != null) episodeListPanel.bringToFront();
        // Mover la PlayerView entre ventanas (diálogo del partido → decorView
        // y viceversa) no siempre repinta su SurfaceView: se queda con el
        // último frame — negro o transparente ("hole punch" de la surface
        // vieja sin sustituir) — hasta el siguiente keyframe, que puede no
        // llegar nunca en directo si el decoder no fuerza uno nuevo. Forzar
        // el rebind (setPlayer(null) + setPlayer(pipPlayer)) hace que
        // PlayerView pida una Surface nueva a la ventana actual y reintente
        // el primer frame; sin rebind el mini queda "colgado" hasta que el
        // usuario lo cierra y lo reabre.
        if (pipView != null && pipPlayer != null) {
            pipView.setPlayer(null);
            pipView.setPlayer(pipPlayer);
        }
    }

    private void showPip(String url, String type, Map<String, String> headers, boolean direct, String title) {
        stopPipInternal();
        Context context = getContext();
        pipUrl = url;
        pipType = type != null ? type : "hls";
        pipHeaders = headers != null ? headers : new HashMap<>();
        pipDirect = direct;
        pipTitle = title != null ? title : "";

        pipLayout = new FrameLayout(context);
        pipLayout.setBackgroundColor(Color.BLACK);
        pipLayout.setFocusable(true);
        pipLayout.setFocusableInTouchMode(true);
        pipLayout.setClickable(true);

        pipView = new PlayerView(context);
        pipView.setUseController(false);
        pipView.setResizeMode(AspectRatioFrameLayout.RESIZE_MODE_FIT);
        pipLayout.addView(pipView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        TextView label = new TextView(context);
        label.setText(pipTitle);
        label.setTextColor(Color.WHITE);
        label.setTextSize(11);
        label.setPadding(dp(6), dp(2), dp(6), dp(2));
        label.setBackgroundColor(0x66000000);
        label.setVisibility(pipTitle.isEmpty() ? View.GONE : View.VISIBLE);
        pipLayout.addView(label, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM | Gravity.START));

        TextView close = new TextView(context);
        close.setText("✕");
        close.setTextColor(Color.WHITE);
        close.setTextSize(14);
        close.setPadding(dp(8), dp(4), dp(8), dp(4));
        close.setBackgroundColor(0x66000000);
        close.setClickable(true);
        close.setFocusable(true);
        close.setOnClickListener(v -> stopPipInternal());
        pipLayout.addView(close, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.TOP | Gravity.END));

        // Tap/OK sobre el mini: intercambiar contenido con el principal.
        View.OnClickListener swap = v -> swapPip();
        pipLayout.setOnClickListener(swap);
        pipView.setOnClickListener(swap);
        pipLayout.setOnKeyListener((v, keyCode, event) -> {
            if (event.getAction() == KeyEvent.ACTION_DOWN
                    && (keyCode == KeyEvent.KEYCODE_DPAD_CENTER || keyCode == KeyEvent.KEYCODE_ENTER)) {
                swapPip();
                return true;
            }
            return false;
        });

        // Antes de que el mini pida el audio focus, el principal lo suelta:
        // si no, recibiría AUDIOFOCUS_LOSS y Media3 lo pausaría.
        if (player != null) {
            mainVolBeforePip = Math.max(player.getVolume(), 0.01f);
            player.setAudioAttributes(mainAudioAttrs(), false);
            player.setVolume(0f);
        }

        AudioAttributes aa = new AudioAttributes.Builder()
                .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
                .setUsage(C.USAGE_MEDIA)
                .build();
        // El mini se ve a ~340dp: decodificar 1080p para él dispara CPU/GPU y
        // RAM en boxes débiles. Track selector capado a ~270p/600kbps (los
        // masters HLS eligen la variante más baja que cumpla) y LoadControl
        // pequeño — el default reserva ~50MB, demasiado para un 2º player.
        // YouTube (manifest.googlevideo.com) se capa aún más, al mínimo
        // (~144p/300kbps): en el mini solo importa el audio.
        boolean yt = url != null
            && (url.contains("googlevideo.com") || url.contains("youtube"));
        DefaultTrackSelector pipTrackSelector = new DefaultTrackSelector(context);
        pipTrackSelector.setParameters(pipTrackSelector.buildUponParameters()
                .setMaxVideoSize(yt ? 256 : 480, yt ? 144 : 270)
                .setMaxVideoBitrate(yt ? 300_000 : 600_000)
                .build());
        DefaultLoadControl pipLoadControl = new DefaultLoadControl.Builder()
                .setBufferDurationsMs(10_000, 30_000, 1_000, 2_000)
                .setTargetBufferBytes(15 * 1024 * 1024)
                .build();
        pipPlayer = new ExoPlayer.Builder(context)
                .setAudioAttributes(aa, true)
                .setTrackSelector(pipTrackSelector)
                .setLoadControl(pipLoadControl)
                .setWakeMode(C.WAKE_MODE_LOCAL)
                .build();
        pipView.setPlayer(pipPlayer);
        try {
            DataSource.Factory dsf = makePipDsFactory(url, pipHeaders, direct);
            pipPlayer.setMediaSource(buildMediaSource(url, pipType, dsf, null, null));
            pipPlayer.setVolume(1f);
            pipPlayer.prepare();
            pipPlayer.play();
        } catch (Exception e) {
            Log.e(TAG, "showPip failed", e);
            stopPipInternal();
            return;
        }
        attachPipToBestParent();
    }

    private void swapPip() {
        if (pipPlayer == null || player == null || pipUrl == null) return;
        // Contenido del mini → principal; el del principal → mini.
        String mUrl = currentUrl, mType = currentStreamType, mTitle = currentChannelName;
        Map<String, String> mHeaders = currentHeaders;
        boolean mDirect = currentDirect;

        currentUrl = pipUrl;
        currentStreamType = pipType;
        currentHeaders = pipHeaders;
        currentDirect = pipDirect;
        currentChannelName = pipTitle;
        try {
            DataSource.Factory dsf = makePipDsFactory(currentUrl, currentHeaders, currentDirect);
            MediaSource src = buildMediaSource(currentUrl, currentStreamType, dsf, null, null);
            player.setMediaSource(src);
            lastDataSourceFactory = dsf;
            lastStreamType = currentStreamType;
            lastDrmSessionManager = null;
            lastLicenseUrl = null;
            lastMediaSource = src;
            player.prepare();
            player.play();
            updatePlayerSubtitle(pipTitle);
            updateControlsUi();
        } catch (Exception e) {
            Log.e(TAG, "swapPip main failed", e);
        }

        pipUrl = mUrl;
        pipType = mType;
        pipHeaders = mHeaders;
        pipDirect = mDirect;
        pipTitle = mTitle;
        try {
            DataSource.Factory dsf2 = makePipDsFactory(pipUrl, pipHeaders, pipDirect);
            pipPlayer.setMediaSource(buildMediaSource(pipUrl, pipType, dsf2, null, null));
            pipPlayer.prepare();
            pipPlayer.play();
        } catch (Exception e) {
            Log.e(TAG, "swapPip pip failed", e);
        }
    }

    private void minimizeToPip() {
        if (player == null || currentUrl == null || currentUrl.isEmpty()) return;
        // El stream actual pasa al mini con audio; el diálogo se cierra y el
        // usuario navega para abrir otro vídeo que saldrá muteado.
        showPip(currentUrl, currentStreamType, currentHeaders, currentDirect, currentChannelName);
        closePlayer();
        attachPipToBestParent();
    }

    private void stopPipInternal() {
        if (pipView != null) {
            try { pipView.setPlayer(null); } catch (Throwable ignored) {}
        }
        if (pipPlayer != null) {
            try { pipPlayer.release(); } catch (Throwable ignored) {}
            pipPlayer = null;
        }
        if (pipLayout != null && pipLayout.getParent() != null) {
            ((ViewGroup) pipLayout.getParent()).removeView(pipLayout);
        }
        pipLayout = null;
        pipView = null;
        pipUrl = null;
        // Restaurar el audio del principal (volumen + manejo de audio focus).
        if (player != null) {
            player.setAudioAttributes(mainAudioAttrs(), true);
            player.setVolume(mainVolBeforePip);
        }
    }

    private String formatSpeed(float speed) {
        if (speed == (long) speed) return (long) speed + "x";
        return speed + "x";
    }

    // --- Top bar estilo Stremio ------------------------------------------------

    private LinearLayout buildTopBar(Context context, String title) {
        LinearLayout bar = new LinearLayout(context);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundResource(R.drawable.top_gradient);
        bar.setPadding(dp(12), dp(10), dp(16), dp(20));
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.TOP
        );
        bar.setLayoutParams(lp);

        ImageButton back = new ImageButton(context);
        back.setImageResource(R.drawable.ic_arrow_back);
        back.setBackgroundColor(Color.TRANSPARENT);
        back.setContentDescription("Atrás");
        back.setPadding(dp(8), dp(8), dp(8), dp(8));
        // En TV el botón de atrás del mando ya cierra; evitar robar el foco D-pad
        back.setFocusable(false);
        back.setOnClickListener(v -> closePlayer());
        bar.addView(back, new LinearLayout.LayoutParams(dp(44), dp(44)));

        LinearLayout texts = new LinearLayout(context);
        texts.setOrientation(LinearLayout.VERTICAL);
        texts.setPadding(dp(8), 0, 0, 0);

        playerTitleView = new TextView(context);
        playerTitleView.setTextColor(Color.WHITE);
        playerTitleView.setTextSize(16f);
        playerTitleView.setTypeface(null, android.graphics.Typeface.BOLD);
        playerTitleView.setMaxLines(1);
        playerTitleView.setEllipsize(TextUtils.TruncateAt.END);
        playerTitleView.setText(title != null ? title : "");
        texts.addView(playerTitleView);

        playerSubtitleView = new TextView(context);
        playerSubtitleView.setTextColor(0xFFB3B3B3);
        playerSubtitleView.setTextSize(13f);
        playerSubtitleView.setMaxLines(1);
        playerSubtitleView.setEllipsize(TextUtils.TruncateAt.END);
        texts.addView(playerSubtitleView);

        bar.addView(texts, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        // Reloj a la derecha de la top bar — se actualiza con el tick de controles
        clockView = new TextView(context);
        clockView.setTextColor(Color.WHITE);
        clockView.setTextSize(15f);
        clockView.setTypeface(null, android.graphics.Typeface.BOLD);
        clockView.setPadding(dp(12), 0, 0, 0);
        clockView.setFocusable(false);
        clockView.setText(clockFormat.format(new java.util.Date()));
        bar.addView(clockView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        updatePlayerSubtitle(title);
        bar.setVisibility(View.GONE); // se muestra junto al controller
        return bar;
    }

    private void updatePlayerSubtitle(String title) {
        if (playerTitleView != null && title != null && !title.isEmpty()) {
            playerTitleView.setText(title);
        }
        if (playerSubtitleView == null) return;
        StringBuilder sub = new StringBuilder();
        if (epgNow != null && !epgNow.isEmpty()) sub.append("Ahora: ").append(epgNow);
        if (epgNext != null && !epgNext.isEmpty()) {
            if (sub.length() > 0) sub.append("  ·  ");
            sub.append("Luego: ").append(epgNext);
        }
        playerSubtitleView.setText(sub.toString());
        playerSubtitleView.setVisibility(sub.length() > 0 ? View.VISIBLE : View.GONE);
    }

    // Show an in-player overlay menu (replaces AlertDialog for a TV-friendly UI).
    // Drawer lateral izquierdo para Android TV:
    //   ↑ / ↓  = navegar por opciones
    //   → / OK = seleccionar la opción enfocada
    //   ← / BACK = cerrar menú
    // title: header text. options: selectable rows. selectedIndex: initial highlight.
    // onSelect: called with the chosen index when user presses Enter.
    private void showInPlayerMenu(String title, String[] options, int selectedIndex, OnMenuSelect onSelect) {
        dismissOverlay();
        Context context = getContext();

        // Backdrop semitransparente que cubre toda la pantalla y cierra al pulsar
        FrameLayout backdrop = new FrameLayout(context);
        backdrop.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        backdrop.setBackgroundColor(0x66000000);
        backdrop.setFocusable(false);
        backdrop.setClickable(true);
        backdrop.setOnClickListener(v -> dismissOverlay());

        // Popup estilo Stremio: centrado horizontalmente, encima de la fila de controles
        LinearLayout popup = new LinearLayout(context);
        popup.setOrientation(LinearLayout.VERTICAL);
        FrameLayout.LayoutParams popupParams = new FrameLayout.LayoutParams(
                dp(280), ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER_HORIZONTAL | Gravity.BOTTOM);
        popupParams.setMargins(dp(24), 0, dp(24), dp(110));
        popup.setLayoutParams(popupParams);
        popup.setBackgroundResource(R.drawable.seekbar_popup_bg);
        popup.setPadding(dp(16), dp(16), dp(16), dp(16));
        popup.setFocusable(false);

        // Título
        TextView titleView = new TextView(context);
        titleView.setText(title);
        titleView.setTextColor(Color.WHITE);
        titleView.setTextSize(16);
        titleView.setTypeface(null, android.graphics.Typeface.BOLD);
        titleView.setPadding(dp(8), 0, dp(8), dp(12));
        popup.addView(titleView);

        // Lista de opciones scrolleable
        ScrollView scroll = new ScrollView(context);
        scroll.setVerticalScrollBarEnabled(false);
        scroll.setFocusable(false);
        scroll.setFocusableInTouchMode(false);
        LinearLayout container = new LinearLayout(context);
        container.setOrientation(LinearLayout.VERTICAL);
        container.setFocusable(false);

        final TextView[] optionViews = new TextView[options.length];
        for (int i = 0; i < options.length; i++) {
            final int idx = i;
            TextView opt = new TextView(context);
            opt.setText(options[i]);
            opt.setTextSize(15);
            opt.setPadding(dp(12), dp(12), dp(12), dp(12));
            opt.setTextColor(Color.WHITE);
            opt.setBackground(menuOptionBackground(i == selectedIndex));
            opt.setFocusable(true);
            opt.setFocusableInTouchMode(true);
            opt.setClickable(true);
            // La escala se registra antes del listener de selección para no
            // sobrescribir el cambio de texto/fondo al mover el foco.
            applyFocusScale(opt);
            opt.setOnClickListener(v -> {
                dismissOverlay();
                onSelect.onSelect(idx);
            });
            opt.setOnFocusChangeListener((v, hasFocus) -> {
                if (hasFocus) {
                    for (int j = 0; j < optionViews.length; j++) {
                        optionViews[j].setTextColor(Color.WHITE);
                        optionViews[j].setBackground(menuOptionBackground(j == idx));
                    }
                    mainHandler.post(() -> scroll.smoothScrollTo(0, v.getTop()));
                }
            });
            container.addView(opt);
            optionViews[i] = opt;
        }
        scroll.addView(container);
        popup.addView(scroll, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        backdrop.addView(popup);

        // Añadir al diálogo y enfocar la opción inicial
        if (dialog != null) {
            ViewGroup root = (ViewGroup) dialog.getWindow().getDecorView();
            if (root != null) {
                root.addView(backdrop);
                overlayDialog = null;
                overlayView = backdrop;
                if (selectedIndex >= 0 && selectedIndex < optionViews.length) {
                    optionViews[selectedIndex].requestFocus();
                } else if (optionViews.length > 0) {
                    optionViews[0].requestFocus();
                }
            }
        }
    }

    private android.graphics.drawable.Drawable menuOptionBackground(boolean selected) {
        android.graphics.drawable.GradientDrawable background = new android.graphics.drawable.GradientDrawable();
        background.setColor(selected ? ACCENT_COLOR : 0x22333333);
        background.setCornerRadius(dp(12));
        background.setStroke(dp(1), selected ? 0x99FFFFFF : 0x22333333);
        return background;
    }

    private GestureDetector swipeGestureDetector = null;
    private View overlayView = null;

    private void dismissOverlay() {
        if (overlayView != null && overlayView.getParent() instanceof ViewGroup) {
            ((ViewGroup) overlayView.getParent()).removeView(overlayView);
            overlayView = null;
        }
        showControls();
    }

    interface OnMenuSelect {
        void onSelect(int index);
    }

    private void showSettingsMenu() {
        if (player == null) return;
        String[] options = {"Calidad", "Idioma de audio", "Subtítulos", "Velocidad"};
        showInPlayerMenu("Ajustes de reproducción", options, -1, (which) -> {
            switch (which) {
                case 0: showQualityMenu(); break;
                case 1: showAudioMenu(); break;
                case 2: showSubtitleMenu(); break;
                case 3: showPlaybackSpeedMenu(); break;
            }
        });
    }

    private void showQualityMenu() {
        if (player == null) return;
        List<Tracks.Group> groups = new ArrayList<>();
        List<Integer> indexes = new ArrayList<>();
        List<String> labels = new ArrayList<>();
        labels.add("Auto");
        for (Tracks.Group group : player.getCurrentTracks().getGroups()) {
            if (group.getType() != C.TRACK_TYPE_VIDEO) continue;
            for (int i = 0; i < group.length; i++) {
                if (!group.isTrackSupported(i)) continue;
                groups.add(group);
                indexes.add(i);
                Format fmt = group.getTrackFormat(i);
                int height = fmt.height;
                int width = fmt.width;
                String label;
                if (height > 0) {
                    label = height + "p" + (fmt.frameRate > 30 ? " " + (int)fmt.frameRate + "fps" : "");
                    if (width > 0) label += " (" + width + "x" + height + ")";
                    if (fmt.bitrate > 0) label += " · " + (fmt.bitrate / 1000) + "kbps";
                } else {
                    label = fmt.label != null ? fmt.label : "Pista " + labels.size();
                }
                labels.add(label);
            }
        }
        if (labels.size() <= 1) {
            showInPlayerMenu("Calidad", new String[]{"Solo hay una calidad disponible"}, 0, (s) -> {});
            return;
        }
        showInPlayerMenu("Calidad de video", labels.toArray(new String[0]), 0, (selected) -> {
            TrackSelectionParameters.Builder parameters = player.getTrackSelectionParameters().buildUpon();
            if (selected == 0) {
                parameters.clearOverridesOfType(C.TRACK_TYPE_VIDEO);
            } else {
                Tracks.Group group = groups.get(selected - 1);
                parameters.addOverride(new TrackSelectionOverride(group.getMediaTrackGroup(), indexes.get(selected - 1)));
            }
            player.setTrackSelectionParameters(parameters.build());
        });
    }

    private void showAudioMenu() {
        if (player == null) return;
        List<Tracks.Group> groups = new ArrayList<>();
        List<Integer> indexes = new ArrayList<>();
        List<String> labels = new ArrayList<>();
        labels.add("Auto");
        for (Tracks.Group group : player.getCurrentTracks().getGroups()) {
            if (group.getType() != C.TRACK_TYPE_AUDIO) continue;
            for (int i = 0; i < group.length; i++) {
                if (!group.isTrackSupported(i)) continue;
                groups.add(group);
                indexes.add(i);
                Format fmt = group.getTrackFormat(i);
                String label = "";
                if (fmt.label != null && !fmt.label.isEmpty()) label = fmt.label;
                else if (fmt.language != null) label = fmt.language.toUpperCase();
                else label = "Audio " + labels.size();
                if (fmt.channelCount > 0) label += " (" + fmt.channelCount + "ch)";
                labels.add(label);
            }
        }
        if (labels.size() <= 1) {
            showInPlayerMenu("Idioma de audio", new String[]{"Solo hay una pista de audio disponible"}, 0, (s) -> {});
            return;
        }
        showInPlayerMenu("Idioma de audio", labels.toArray(new String[0]), 0, (selected) -> {
            TrackSelectionParameters.Builder parameters = player.getTrackSelectionParameters().buildUpon();
            if (selected == 0) {
                parameters.clearOverridesOfType(C.TRACK_TYPE_AUDIO);
            } else {
                Tracks.Group group = groups.get(selected - 1);
                parameters.addOverride(new TrackSelectionOverride(group.getMediaTrackGroup(), indexes.get(selected - 1)));
            }
            player.setTrackSelectionParameters(parameters.build());
        });
    }

    private void showSubtitleMenu() {
        if (player == null) return;
        List<Tracks.Group> groups = new ArrayList<>();
        List<Integer> indexes = new ArrayList<>();
        List<String> labels = new ArrayList<>();
        labels.add("Desactivados");
        for (Tracks.Group group : player.getCurrentTracks().getGroups()) {
            if (group.getType() != C.TRACK_TYPE_TEXT) continue;
            for (int i = 0; i < group.length; i++) {
                if (!group.isTrackSupported(i)) continue;
                groups.add(group);
                indexes.add(i);
                String label = group.getTrackFormat(i).label;
                String language = group.getTrackFormat(i).language;
                labels.add(label != null && !label.isEmpty() ? label : language != null ? language.toUpperCase() : "Subtítulos " + labels.size());
            }
        }
        // Con IMDB id disponible (películas/series TMDB) se ofrece la búsqueda
        // online en el addon OpenSubtitles de Stremio (sin API key).
        final boolean canSearchOnline = mediaImdbId != null && !mediaImdbId.isEmpty();
        if (canSearchOnline) labels.add("Buscar en OpenSubtitles…");
        showInPlayerMenu("Subtítulos", labels.toArray(new String[0]), 0, (selected) -> {
            if (canSearchOnline && selected == labels.size() - 1) {
                searchOpenSubtitlesOnline();
                return;
            }
            TrackSelectionParameters.Builder parameters = player.getTrackSelectionParameters().buildUpon()
                    .clearOverridesOfType(C.TRACK_TYPE_TEXT);
            if (selected == 0) {
                parameters.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true);
            } else {
                Tracks.Group group = groups.get(selected - 1);
                parameters.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
                        .addOverride(new TrackSelectionOverride(group.getMediaTrackGroup(), indexes.get(selected - 1)));
            }
            player.setTrackSelectionParameters(parameters.build());
        });
    }

    // Ajuste de sincronía de subtítulos: modifica subtitleOffsetUs, que
    // OffsetSubtitleDecoder aplica a los tiempos de los cues al decodificar.
    // Positivo = aparecen más tarde (retraso), negativo = antes (adelanto).
    // Reabre el menú tras cada paso para poder repetir con el D-pad.
    private void showSubtitleDelayMenu() {
        String off = String.format(java.util.Locale.US, "%+.1f s", subtitleOffsetUs / 1_000_000f);
        showInPlayerMenu("Sincronía subtítulos (" + off + ")", new String[]{
                "Adelantar +0,5 s (aparecen antes)",
                "Retrasar +0,5 s (aparecen después)",
                "Restablecer (0 s)",
        }, -1, which -> {
            if (which == 0) subtitleOffsetUs -= 500_000L;
            else if (which == 1) subtitleOffsetUs += 500_000L;
            else subtitleOffsetUs = 0;
            long max = 10_000_000L; // ±10 s
            if (subtitleOffsetUs > max) subtitleOffsetUs = max;
            if (subtitleOffsetUs < -max) subtitleOffsetUs = -max;
            showSubtitleDelayMenu();
        });
    }

    // Búsqueda de subtítulos online vía el addon público de Stremio
    // (opensubtitles-v3.strem.io): sin API key, indexa por IMDB id.
    // Película: /subtitles/movie/ttXXX.json — Serie: ttXXX:temp:epi.
    private void searchOpenSubtitlesOnline() {
        if (mediaImdbId == null || mediaImdbId.isEmpty()) return;
        final boolean isSeries = mediaSeason > 0 && mediaEpisode > 0;
        final String id = isSeries
                ? mediaImdbId + ":" + mediaSeason + ":" + mediaEpisode
                : mediaImdbId;
        final String endpoint = "https://opensubtitles-v3.strem.io/subtitles/"
                + (isSeries ? "series" : "movie") + "/" + id + ".json";
        showInPlayerMenu("OpenSubtitles", new String[]{"Buscando…"}, 0, s -> {});
        new Thread(() -> {
            try {
                // Cliente compartido: cada `new OkHttpClient()` crea su propio
                // dispatcher (pool de hilos) y connection pool.
                OkHttpClient client = sharedOkHttpClient();
                Response resp = client.newCall(new Request.Builder().url(endpoint).build()).execute();
                if (!resp.isSuccessful() || resp.body() == null) {
                    throw new Exception("HTTP " + resp.code());
                }
                JSONArray subs = new JSONObject(resp.body().string()).optJSONArray("subtitles");
                List<JSONObject> list = new ArrayList<>();
                if (subs != null) {
                    for (int i = 0; i < subs.length(); i++) list.add(subs.optJSONObject(i));
                }
                // Español primero, luego inglés, resto al final.
                list.sort((a, b) -> opensubsLangRank(a.optString("lang", ""))
                        - opensubsLangRank(b.optString("lang", "")));
                List<String> names = new ArrayList<>();
                for (JSONObject s : list) {
                    if (s == null) continue;
                    String lang = s.optString("lang", "?").toUpperCase(java.util.Locale.ROOT);
                    String name = s.optString("subtitleFileName",
                            s.optString("movieReleaseName", "Subtítulo"));
                    names.add("[" + lang + "] " + name);
                }
                if (names.isEmpty()) names.add("Sin resultados");
                final List<JSONObject> results = list;
                mainHandler.post(() -> showInPlayerMenu("OpenSubtitles",
                        names.toArray(new String[0]), 0, idx -> {
                            JSONObject s = idx < results.size() ? results.get(idx) : null;
                            if (s != null) applyExternalSubtitle(
                                    s.optString("url"), s.optString("lang", "es"));
                        }));
            } catch (Exception e) {
                Log.e(TAG, "OpenSubtitles search failed: " + e.getMessage());
                mainHandler.post(() -> showInPlayerMenu("OpenSubtitles",
                        new String[]{"Error de red o sin resultados"}, 0, s -> {}));
            }
        }).start();
    }

    private int opensubsLangRank(String lang) {
        if ("spa".equals(lang) || "esp".equals(lang)) return 0;
        if ("eng".equals(lang)) return 1;
        return 2;
    }

    // Aplica un subtítulo side-loaded: reconstruye el MediaSource con la
    // configuración de subtítulo y continúa desde la posición actual.
    private void applyExternalSubtitle(String url, String lang) {
        if (player == null || url == null || url.isEmpty()) return;
        if (!url.startsWith("http://") && !url.startsWith("https://")) return;
        externalSubUrl = url;
        externalSubLang = opensubsToIso1(lang);
        pendingSelectExternalSub = true;
        externalSubSelectTries = 0;
        try {
            MediaSource src = buildMediaSource(currentUrl, lastStreamType,
                    lastDataSourceFactory, lastDrmSessionManager, lastLicenseUrl);
            lastMediaSource = src;
            boolean wasPlaying = player.getPlayWhenReady();
            // setMediaSource puede resetear el volumen a 0 — guardarlo y
            // restaurarlo tras prepare() (igual que en switchChannel).
            float savedVolume = player.getVolume();
            if ("live".equals(playerMode)) {
                player.setMediaSource(src);
            } else {
                long pos = player.getCurrentPosition();
                player.setMediaSource(src, Math.max(0, pos));
            }
            player.prepare();
            if (savedVolume > 0f) player.setVolume(savedVolume);
            if (wasPlaying) player.play();
        } catch (Exception e) {
            Log.e(TAG, "applyExternalSubtitle failed: " + e.getMessage());
        }
    }

    // El addon devuelve ISO-639-2 (spa, eng…); Media3 espera ISO-639-1.
    private String opensubsToIso1(String lang) {
        if (lang == null) return "es";
        switch (lang) {
            case "spa": case "esp": return "es";
            case "eng": return "en";
            case "fre": case "fra": return "fr";
            case "ger": case "deu": return "de";
            case "ita": return "it";
            case "por": return "pt";
            case "jpn": return "ja";
            case "kor": return "ko";
            default: return lang.length() == 2 ? lang : "es";
        }
    }

    // Se llama desde onTracksChanged mientras pendingSelectExternalSub esté
    // activo: la pista side-loaded puede registrarse unos instantes después
    // de STATE_READY. Al encontrarla, se selecciona y se limpia el flag.
    private int externalSubSelectTries = 0;
    private void selectExternalSubtitleTrack() {
        if (player == null) return;
        for (Tracks.Group g : player.getCurrentTracks().getGroups()) {
            if (g.getType() != C.TRACK_TYPE_TEXT) continue;
            for (int i = 0; i < g.length; i++) {
                if ("OpenSubtitles".equals(g.getTrackFormat(i).label)) {
                    player.setTrackSelectionParameters(
                            player.getTrackSelectionParameters().buildUpon()
                                    .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
                                    .clearOverridesOfType(C.TRACK_TYPE_TEXT)
                                    .addOverride(new TrackSelectionOverride(g.getMediaTrackGroup(), i))
                                    .build());
                    pendingSelectExternalSub = false;
                    externalSubSelectTries = 0;
                    Log.i(TAG, "External subtitle track selected");
                    return;
                }
            }
        }
        // Reintentos limitados: si la pista nunca aparece (URL caída, formato
        // no soportado), se abandona tras ~10 actualizaciones de tracks.
        if (++externalSubSelectTries > 10) {
            pendingSelectExternalSub = false;
            externalSubSelectTries = 0;
            Log.w(TAG, "External subtitle track not found in current tracks");
        }
    }

    // Decoder de subtítulos que desplaza los tiempos de salida por
    // subtitleOffsetUs. El offset se lee en cada llamada, así que un cambio
    // del menú surte efecto al instante (incluso en buffers ya decodificados
    // que aún no se han mostrado).
    private class OffsetSubtitleDecoder implements androidx.media3.extractor.text.SubtitleDecoder {
        private final androidx.media3.extractor.text.SubtitleDecoder delegate;

        OffsetSubtitleDecoder(androidx.media3.extractor.text.SubtitleDecoder delegate) {
            this.delegate = delegate;
        }

        @Override
        public String getName() {
            return delegate.getName();
        }

        @Override
        public void setOutputStartTimeUs(long timeUs) {
            delegate.setOutputStartTimeUs(timeUs - subtitleOffsetUs);
        }

        @Override
        public androidx.media3.extractor.text.SubtitleInputBuffer dequeueInputBuffer()
                throws androidx.media3.extractor.text.SubtitleDecoderException {
            return delegate.dequeueInputBuffer();
        }

        @Override
        public void queueInputBuffer(androidx.media3.extractor.text.SubtitleInputBuffer buffer)
                throws androidx.media3.extractor.text.SubtitleDecoderException {
            delegate.queueInputBuffer(buffer);
        }

        @Override
        public androidx.media3.extractor.text.SubtitleOutputBuffer dequeueOutputBuffer()
                throws androidx.media3.extractor.text.SubtitleDecoderException {
            androidx.media3.extractor.text.SubtitleOutputBuffer out = delegate.dequeueOutputBuffer();
            return out == null ? null : new OffsetSubtitleBuffer(out);
        }

        @Override
        public void flush() {
            delegate.flush();
        }

        @Override
        public void release() {
            delegate.release();
        }

        @Override
        public void setPositionUs(long positionUs) {
            delegate.setPositionUs(positionUs - subtitleOffsetUs);
        }
    }

    // Buffer de salida que delega en el buffer real del decoder desplazando
    // los tiempos de los cues por subtitleOffsetUs (leído en cada llamada).
    // Un cue [t0, t1] se muestra durante [t0+offset, t1+offset].
    // release()/clear() van al buffer original para devolverlo a su pool.
    private class OffsetSubtitleBuffer extends androidx.media3.extractor.text.SubtitleOutputBuffer {
        private final androidx.media3.extractor.text.SubtitleOutputBuffer delegate;

        OffsetSubtitleBuffer(androidx.media3.extractor.text.SubtitleOutputBuffer delegate) {
            this.delegate = delegate;
            this.timeUs = delegate.timeUs + subtitleOffsetUs;
            this.skippedOutputBufferCount = delegate.skippedOutputBufferCount;
            this.shouldBeSkipped = delegate.shouldBeSkipped;
            if (delegate.isDecodeOnly()) addFlag(C.BUFFER_FLAG_DECODE_ONLY);
            if (delegate.isEndOfStream()) addFlag(C.BUFFER_FLAG_END_OF_STREAM);
            if (delegate.isKeyFrame()) addFlag(C.BUFFER_FLAG_KEY_FRAME);
            if (delegate.isFirstSample()) addFlag(C.BUFFER_FLAG_FIRST_SAMPLE);
            if (delegate.isLastSample()) addFlag(C.BUFFER_FLAG_LAST_SAMPLE);
            if (delegate.hasSupplementalData()) addFlag(C.BUFFER_FLAG_HAS_SUPPLEMENTAL_DATA);
        }

        @Override
        public int getNextEventTimeIndex(long timeUs) {
            return delegate.getNextEventTimeIndex(timeUs - subtitleOffsetUs);
        }

        @Override
        public int getEventTimeCount() {
            return delegate.getEventTimeCount();
        }

        @Override
        public long getEventTime(int index) {
            return delegate.getEventTime(index) + subtitleOffsetUs;
        }

        @Override
        public List<androidx.media3.common.text.Cue> getCues(long timeUs) {
            return delegate.getCues(timeUs - subtitleOffsetUs);
        }

        @Override
        public void release() {
            delegate.release();
        }

        @Override
        public void clear() {
            delegate.clear();
        }
    }

    // Muestra un diálogo nativo con opciones de Cast cuando el framework de
    // Google Cast no está disponible (sin Play Services / Waydroid / emulador).
    // Menú "Enviar a" dentro del player (estilo TV, navegable con D-pad).
    // Chromecast abre el selector nativo; OctoStream busca otros dispositivos
    // con la app en la LAN (SyncServer :8765) y les envía el stream por /play.
    private void showCastMenu() {
        String castLabel = "Chromecast / Google TV";
        CastSession activeSession = null;
        try {
            if (castContext != null) {
                SessionManager sm = castContext.getSessionManager();
                CastSession s = sm != null ? sm.getCurrentCastSession() : null;
                if (s != null && s.isConnected()) {
                    activeSession = s;
                    String name = s.getCastDevice() != null ? s.getCastDevice().getFriendlyName() : "TV";
                    castLabel = "Chromecast: " + name;
                }
            }
        } catch (Exception ignored) {}

        final CastSession session = activeSession;
        final String[] options;
        if (castContext != null) {
            options = new String[]{
                castLabel,
                "Enviar a TV (DLNA)",
                "Duplicar pantalla (Miracast)",
                "Otro OctoStream (misma red)",
                "Copiar URL del stream",
                "Abrir en navegador de TV",
            };
        } else {
            options = new String[]{
                "Enviar a TV (DLNA)",
                "Duplicar pantalla (Miracast)",
                "Otro OctoStream (misma red)",
                "Copiar URL del stream",
                "Abrir en navegador de TV",
            };
        }
        final boolean hasCast = castContext != null;
        showInPlayerMenu("Enviar a", options, -1, which -> {
            int i = which;
            if (!hasCast) i += 1; // sin Chromecast, las opciones empiezan en DLNA
            if (i == 0) {
                if (session != null) loadMediaOnCast(session);
                else openCastDevicePicker();
            } else if (i == 1) {
                showDlnaScan();
            } else if (i == 2) {
                startMiracastScan();
            } else if (i == 3) {
                showOctoStreamScan();
            } else if (i == 4) {
                copyStreamUrlToClipboard();
            } else if (i == 5) {
                openCastReceiverInBrowser();
            }
        });
    }

    // ─── Miracast (WiFi Display source) ────────────────────────────────────
    // android.media.MediaRouter está deprecado pero sigue siendo la única vía
    // de una app normal para disparar el escaneo y la conexión WiFi Display
    // (la selección de ruta remota la negocia el sistema vía RTSP/WFD).
    // Constantes @SystemApi no expuestas en el SDK público:
    // MediaRouter.ROUTE_TYPE_REMOTE_DISPLAY = 1 << 2
    // MediaRouter.CALLBACK_FLAG_REQUEST_DISCOVERY = 1 << 2
    private static final int ROUTE_TYPE_REMOTE_DISPLAY = 4;
    private static final int CALLBACK_FLAG_REQUEST_DISCOVERY = 4;

    private android.media.MediaRouter.Callback miracastCb;
    private final java.util.List<android.media.MediaRouter.RouteInfo> miracastRoutes = new java.util.ArrayList<>();
    private Runnable miracastTimeout;

    // Una app normal NO puede iniciar el escaneo WiFi Display del sistema
    // (CONFIGURE_WIFI_DISPLAY es firma|sistema): MediaRouter solo devuelve
    // rutas que Android ya conoce. WifiP2pManager.discoverPeers sí hace un
    // escaneo P2P real con permiso de runtime — detecta sinks Miracast
    // (wfdInfo) aunque la sesión final la tenga que abrir el sistema.
    private boolean hasWfdScanPermission() {
        Context ctx = getContext();
        if (ctx == null) return false;
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            return ctx.checkSelfPermission(android.Manifest.permission.NEARBY_WIFI_DEVICES)
                    == android.content.pm.PackageManager.PERMISSION_GRANTED;
        }
        return ctx.checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION)
                == android.content.pm.PackageManager.PERMISSION_GRANTED;
    }

    // Escaneo WiFi Direct real (~8s máx., termina antes al encontrar peers).
    // Devuelve nombres de dispositivos; los sinks Miracast llevan wfdInfo.
    private void scanWifiDirectPeers(final java.util.function.Consumer<java.util.List<String>> done) {
        final java.util.List<String> peers = new java.util.ArrayList<>();
        final Context ctx = getContext();
        if (ctx == null || !hasWfdScanPermission()) { done.accept(peers); return; }
        final android.net.wifi.p2p.WifiP2pManager mgr =
                (android.net.wifi.p2p.WifiP2pManager) ctx.getSystemService(Context.WIFI_P2P_SERVICE);
        if (mgr == null) { done.accept(peers); return; }
        final android.net.wifi.p2p.WifiP2pManager.Channel channel =
                mgr.initialize(ctx, ctx.getMainLooper(), null);
        if (channel == null) { done.accept(peers); return; }

        final boolean[] finished = { false };
        final android.content.BroadcastReceiver[] recv = { null };
        final Runnable finish = () -> {
            if (finished[0]) return;
            finished[0] = true;
            try { if (recv[0] != null) ctx.unregisterReceiver(recv[0]); } catch (Exception ignored) {}
            try { mgr.stopPeerDiscovery(channel, null); } catch (Exception ignored) {}
            done.accept(peers);
        };
        recv[0] = new android.content.BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent intent) {
                if (!android.net.wifi.p2p.WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION.equals(intent.getAction())) return;
                try {
                    mgr.requestPeers(channel, list -> {
                        if (list == null) return;
                        for (android.net.wifi.p2p.WifiP2pDevice d : list.getDeviceList()) {
                            // wfdInfo es @hide en el SDK: se intenta por
                            // reflexión para etiquetar sinks Miracast reales.
                            boolean wfd = false;
                            try {
                                Object info = android.net.wifi.p2p.WifiP2pDevice.class
                                        .getField("wfdInfo").get(d);
                                if (info != null) {
                                    wfd = Boolean.TRUE.equals(info.getClass()
                                            .getMethod("isWfdEnabled").invoke(info));
                                }
                            } catch (Exception ignored) {}
                            String name = d.deviceName != null && !d.deviceName.isEmpty()
                                    ? d.deviceName : d.deviceAddress;
                            if (name != null && !peers.contains(name)) {
                                peers.add(wfd ? name + " [Miracast]" : name);
                            }
                        }
                        // Con peers ya encontrados se termina el escaneo.
                        if (!peers.isEmpty()) finish.run();
                    });
                } catch (SecurityException e) {
                    finish.run();
                }
            }
        };
        android.content.IntentFilter filter =
                new android.content.IntentFilter(android.net.wifi.p2p.WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION);
        try {
            if (android.os.Build.VERSION.SDK_INT >= 33) {
                ctx.registerReceiver(recv[0], filter, Context.RECEIVER_EXPORTED);
            } else {
                ctx.registerReceiver(recv[0], filter);
            }
            mgr.discoverPeers(channel, new android.net.wifi.p2p.WifiP2pManager.ActionListener() {
                @Override public void onSuccess() {}
                @Override public void onFailure(int reason) { finish.run(); }
            });
        } catch (SecurityException e) {
            finish.run();
            return;
        }
        mainHandler.postDelayed(finish, 8000);
    }

    private boolean isMiracastRoute(android.media.MediaRouter.RouteInfo r) {
        return r != null
            && (r.getSupportedTypes() & ROUTE_TYPE_REMOTE_DISPLAY) != 0
            && r.getPlaybackType() == android.media.MediaRouter.RouteInfo.PLAYBACK_TYPE_REMOTE
            && r.isEnabled();
    }

    @SuppressWarnings("deprecation")
    private void stopMiracastScan() {
        try {
            Context ctx = getContext();
            if (ctx != null && miracastCb != null) {
                android.media.MediaRouter router =
                        (android.media.MediaRouter) ctx.getSystemService(Context.MEDIA_ROUTER_SERVICE);
                if (router != null) router.removeCallback(miracastCb);
            }
        } catch (Exception ignored) {}
        miracastCb = null;
        if (miracastTimeout != null) { mainHandler.removeCallbacks(miracastTimeout); miracastTimeout = null; }
    }

    @SuppressWarnings("deprecation")
    private void showMiracastPicker(android.media.MediaRouter router) {
        if (miracastRoutes.isEmpty()) {
            showInPlayerMenu("Duplicar pantalla", new String[]{"Buscando pantallas Miracast…"}, -1, i -> {});
            return;
        }
        String[] labels = new String[miracastRoutes.size() + 1];
        for (int i = 0; i < miracastRoutes.size(); i++) labels[i] = miracastRoutes.get(i).getName().toString();
        labels[miracastRoutes.size()] = "Abrir ajustes de proyección";
        showInPlayerMenu("Duplicar pantalla (Miracast)", labels, -1, i -> {
            if (i < miracastRoutes.size()) {
                android.media.MediaRouter.RouteInfo r = miracastRoutes.get(i);
                stopMiracastScan();
                // El sistema negocia la sesión WiFi Display y empieza a duplicar.
                router.selectRoute(ROUTE_TYPE_REMOTE_DISPLAY, r);
                notifyState("cast_started", "Conectando con " + r.getName());
            } else {
                openMiracastSettings();
            }
        });
    }

    @SuppressWarnings("deprecation")
    private void startMiracastScan() {
        Context ctx = getContext();
        if (ctx == null) return;
        // Miracast (WiFi Display) va sobre WiFi Direct: sin el feature el
        // dispositivo no puede emitir y ningún escaneo encontrará pantallas.
        if (!ctx.getPackageManager().hasSystemFeature(android.content.pm.PackageManager.FEATURE_WIFI_DIRECT)) {
            showInPlayerMenu("Duplicar pantalla (Miracast)",
                new String[]{"Este dispositivo no admite Miracast (sin Wi-Fi Direct)", "Abrir ajustes"}, -1,
                i -> { if (i == 1) openMiracastSettings(); });
            return;
        }
        final android.media.MediaRouter router =
                (android.media.MediaRouter) ctx.getSystemService(Context.MEDIA_ROUTER_SERVICE);
        if (router == null) { openMiracastSettings(); return; }
        stopMiracastScan();
        miracastRoutes.clear();
        for (int i = 0; i < router.getRouteCount(); i++) {
            android.media.MediaRouter.RouteInfo r = router.getRouteAt(i);
            if (isMiracastRoute(r) && !miracastRoutes.contains(r)) miracastRoutes.add(r);
        }
        showMiracastPicker(router);
        miracastCb = new android.media.MediaRouter.Callback() {
            @Override public void onRouteAdded(android.media.MediaRouter mr, android.media.MediaRouter.RouteInfo info) {
                if (isMiracastRoute(info) && !miracastRoutes.contains(info)) {
                    miracastRoutes.add(info);
                    showMiracastPicker(router);
                }
            }
            @Override public void onRouteRemoved(android.media.MediaRouter mr, android.media.MediaRouter.RouteInfo info) {
                if (miracastRoutes.remove(info)) showMiracastPicker(router);
            }
            @Override public void onRouteSelected(android.media.MediaRouter mr, int type, android.media.MediaRouter.RouteInfo info) {
                if (isMiracastRoute(info)) stopMiracastScan();
            }
            @Override public void onRouteUnselected(android.media.MediaRouter mr, int type, android.media.MediaRouter.RouteInfo info) {}
            @Override public void onRouteChanged(android.media.MediaRouter mr, android.media.MediaRouter.RouteInfo info) {}
            @Override public void onRouteGrouped(android.media.MediaRouter mr, android.media.MediaRouter.RouteInfo info, android.media.MediaRouter.RouteGroup group, int index) {}
            @Override public void onRouteUngrouped(android.media.MediaRouter mr, android.media.MediaRouter.RouteInfo info, android.media.MediaRouter.RouteGroup group) {}
            @Override public void onRouteVolumeChanged(android.media.MediaRouter mr, android.media.MediaRouter.RouteInfo info) {}
        };
        // REQUEST_DISCOVERY hace que el sistema busque pantallas WiFi Display;
        // ACTIVE_SCAN mantiene el descubrimiento P2P activo mientras dure.
        router.addCallback(ROUTE_TYPE_REMOTE_DISPLAY, miracastCb,
                CALLBACK_FLAG_REQUEST_DISCOVERY
                        | android.media.MediaRouter.CALLBACK_FLAG_PERFORM_ACTIVE_SCAN);
        miracastTimeout = () -> {
            stopMiracastScan();
            if (miracastRoutes.isEmpty()) {
                dismissOverlay();
                notifyState("cast_error", "No se encontraron pantallas Miracast — abriendo ajustes");
                openMiracastSettings();
            }
        };
        mainHandler.postDelayed(miracastTimeout, 12000);
        // MediaRouter solo ve rutas que el sistema ya conoce; el escaneo P2P
        // real descubre sinks Miracast aunque la sesión la abra el sistema.
        scanWifiDirectPeers(peers -> mainHandler.post(() -> {
            if (peers.isEmpty() || !miracastRoutes.isEmpty() || miracastCb == null) return;
            java.util.List<String> opts = new java.util.ArrayList<>();
            for (String p : peers) opts.add(p + " (ajustes)");
            opts.add("Abrir ajustes de proyección");
            showInPlayerMenu("Duplicar pantalla (Miracast)", opts.toArray(new String[0]), -1,
                    i -> { stopMiracastScan(); openMiracastSettings(); });
        }));
    }

    private android.media.MediaRouter.RouteInfo findMiracastRoute(android.media.MediaRouter router) {
        for (int i = 0; i < router.getRouteCount(); i++) {
            android.media.MediaRouter.RouteInfo r = router.getRouteAt(i);
            if (isMiracastRoute(r)) return r;
        }
        return null;
    }

    private void openMiracastSettings() {
        String[] actions = {
            "android.settings.WIRELESS_DISPLAY_SETTINGS",
            "android.settings.CAST_SETTINGS",
            android.provider.Settings.ACTION_DISPLAY_SETTINGS,
            android.provider.Settings.ACTION_SETTINGS,
        };
        for (String a : actions) {
            try {
                android.content.Intent i = new android.content.Intent(a);
                i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
                return;
            } catch (Exception ignored) {}
        }
        notifyState("cast_error", "No se pudo abrir la pantalla de proyección inalámbrica");
    }

    // ─── DLNA (MediaRenderer / DMR) ────────────────────────────────────────
    // Envía la URL del stream a una TV/receptor DLNA por la red local:
    // SSDP para descubrir → device description XML → SetAVTransportURI + Play.
    // No necesita WiFi Direct ni Chromecast — vale para la mayoría de Smart TVs.

    private static class DlnaDevice {
        String name;
        String controlUrl;
    }

    private static String dlnaHeader(String resp, String name) {
        for (String line : resp.split("\r\n|\n")) {
            int c = line.indexOf(':');
            if (c > 0 && line.substring(0, c).trim().equalsIgnoreCase(name)) {
                return line.substring(c + 1).trim();
            }
        }
        return null;
    }

    private static String dlnaTag(String xml, String tag) {
        java.util.regex.Matcher m = java.util.regex.Pattern.compile(
            "<[^>]*" + tag + "[^>]*>([^<]*)<").matcher(xml);
        return m.find() ? m.group(1).trim() : null;
    }

    private static String dlnaEsc(String s) {
        if (s == null) return "";
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                .replace("\"", "&quot;");
    }

    // Un renderer DLNA siempre vive en la LAN. Sin este filtro un respondedor
    // SSDP falso podría anunciar LOCATION/controlURL apuntando a hosts
    // arbitrarios y convertirnos en proxy SSRF (fetch + POST SOAP ciegos).
    private static boolean isPrivateHost(String host) {
        if (host == null) return false;
        host = host.replaceAll("^\\[|\\]$", "").toLowerCase(java.util.Locale.ROOT);
        if (host.equals("localhost") || host.equals("::1")) return true;
        if (host.startsWith("127.") || host.startsWith("10.") || host.startsWith("192.168.")) return true;
        if (host.matches("^172\\.(1[6-9]|2[0-9]|3[01])\\..*")) return true;
        if (host.startsWith("169.254.") || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return true;
        return false;
    }

    private DlnaDevice fetchDlnaDevice(String loc) {
        try {
            java.net.URL u = new java.net.URL(loc);
            if (!("http".equals(u.getProtocol()) || "https".equals(u.getProtocol()))
                    || !isPrivateHost(u.getHost())) return null;
            java.net.HttpURLConnection c = (java.net.HttpURLConnection) u.openConnection();
            c.setConnectTimeout(3000);
            c.setReadTimeout(3000);
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            java.io.InputStream in = c.getInputStream();
            byte[] buf = new byte[8192];
            int n;
            // Cap: una descripción UPnP real son unos pocos KB — sin límite un
            // respondedor hostil podría agotar la memoria del dispositivo.
            while ((n = in.read(buf)) > 0) {
                bos.write(buf, 0, n);
                if (bos.size() > 512 * 1024) { in.close(); return null; }
            }
            String xml = bos.toString("UTF-8");
            String control = null;
            java.util.regex.Matcher sm = java.util.regex.Pattern.compile(
                "<service>.*?</service>", java.util.regex.Pattern.DOTALL).matcher(xml);
            while (sm.find()) {
                String svc = sm.group();
                if (svc.contains("AVTransport")) {
                    String cu = dlnaTag(svc, "controlURL");
                    if (cu != null) {
                        String abs = cu.startsWith("http") ? cu
                            : u.getProtocol() + "://" + u.getHost()
                              + (u.getPort() > 0 ? ":" + u.getPort() : "")
                              + (cu.startsWith("/") ? cu : "/" + cu);
                        try {
                            java.net.URL cu2 = new java.net.URL(abs);
                            if (("http".equals(cu2.getProtocol()) || "https".equals(cu2.getProtocol()))
                                    && isPrivateHost(cu2.getHost())) control = abs;
                        } catch (Exception ignored) {}
                    }
                }
            }
            if (control == null) return null;
            DlnaDevice d = new DlnaDevice();
            d.name = dlnaTag(xml, "friendlyName");
            if (d.name == null || d.name.isEmpty()) d.name = u.getHost();
            d.controlUrl = control;
            return d;
        } catch (Exception e) {
            return null;
        }
    }

    private java.util.List<DlnaDevice> scanDlnaRenderers() {
        java.util.List<DlnaDevice> out = new java.util.ArrayList<>();
        java.net.DatagramSocket sock = null;
        try {
            sock = new java.net.DatagramSocket();
            sock.setSoTimeout(800);
            String req = "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\n"
                + "MAN: \"ssdp:discover\"\r\nMX: 2\r\n"
                + "ST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n";
            byte[] data = req.getBytes(java.nio.charset.StandardCharsets.UTF_8);
            java.net.InetAddress grp = java.net.InetAddress.getByName("239.255.255.250");
            for (int i = 0; i < 2; i++) {
                sock.send(new java.net.DatagramPacket(data, data.length, grp, 1900));
            }
            java.util.Set<String> seen = new java.util.HashSet<>();
            long deadline = System.currentTimeMillis() + 4000;
            while (System.currentTimeMillis() < deadline) {
                byte[] buf = new byte[4096];
                java.net.DatagramPacket p = new java.net.DatagramPacket(buf, buf.length);
                try {
                    sock.receive(p);
                } catch (java.net.SocketTimeoutException e) {
                    continue;
                }
                String txt = new String(p.getData(), 0, p.getLength(), java.nio.charset.StandardCharsets.UTF_8);
                String loc = dlnaHeader(txt, "location");
                String st = dlnaHeader(txt, "st");
                if (loc == null || !seen.add(loc)) continue;
                if (st != null && !st.contains("MediaRenderer") && !st.contains("rootdevice")) continue;
                DlnaDevice d = fetchDlnaDevice(loc);
                if (d != null) out.add(d);
            }
        } catch (Exception ignored) {
        } finally {
            if (sock != null) try { sock.close(); } catch (Exception ignored) {}
        }
        return out;
    }

    private void dlnaSoap(String url, String action, String bodyXml) throws Exception {
        String env = "<?xml version=\"1.0\" encoding=\"utf-8\"?>"
            + "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" "
            + "s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body>"
            + bodyXml + "</s:Body></s:Envelope>";
        java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
        c.setRequestMethod("POST");
        c.setConnectTimeout(5000);
        c.setReadTimeout(5000);
        c.setRequestProperty("Content-Type", "text/xml; charset=\"utf-8\"");
        c.setRequestProperty("SOAPACTION", "\"" + action + "\"");
        c.setDoOutput(true);
        c.getOutputStream().write(env.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        int code = c.getResponseCode();
        if (code >= 400) throw new Exception("HTTP " + code);
    }

    private void dlnaSend(String controlUrl, String mediaUrl, String title) {
        new Thread(() -> {
            try {
                String meta = "<DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" "
                    + "xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\">"
                    + "<item id=\"0\" parentID=\"-1\" restricted=\"1\"><dc:title>" + dlnaEsc(title) + "</dc:title>"
                    + "<upnp:class>object.item.videoItem</upnp:class>"
                    + "<res protocolInfo=\"http-get:*:video/*:*\">" + dlnaEsc(mediaUrl) + "</res></item></DIDL-Lite>";
                dlnaSoap(controlUrl, "urn:schemas-upnp-org:service:AVTransport:1#SetAVTransportURI",
                    "<u:SetAVTransportURI xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\">"
                    + "<InstanceID>0</InstanceID><CurrentURI>" + dlnaEsc(mediaUrl) + "</CurrentURI>"
                    + "<CurrentURIMetaData>" + dlnaEsc(meta) + "</CurrentURIMetaData></u:SetAVTransportURI>");
                dlnaSoap(controlUrl, "urn:schemas-upnp-org:service:AVTransport:1#Play",
                    "<u:Play xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\">"
                    + "<InstanceID>0</InstanceID><Speed>1</Speed></u:Play>");
                mainHandler.post(() -> notifyState("cast_started", "Enviado a TV por DLNA"));
            } catch (Exception e) {
                Log.w(TAG, "dlnaSend failed: " + e.getMessage());
                mainHandler.post(() -> notifyState("cast_error", "La TV no aceptó el envío DLNA"));
            }
        }).start();
    }

    private void showDlnaScan() {
        showInPlayerMenu("Enviar a TV (DLNA)", new String[]{"Buscando TVs en la red…"}, -1, i -> {});
        new Thread(() -> {
            final java.util.List<DlnaDevice> devs = scanDlnaRenderers();
            mainHandler.post(() -> {
                if (devs.isEmpty()) {
                    showInPlayerMenu("Enviar a TV (DLNA)",
                        new String[]{"Ninguna TV DLNA encontrada", "Reintentar búsqueda"}, -1,
                        i -> { if (i == 1) showDlnaScan(); });
                    return;
                }
                String[] labels = new String[devs.size()];
                for (int i = 0; i < devs.size(); i++) labels[i] = devs.get(i).name;
                showInPlayerMenu("Enviar a TV (DLNA)", labels, -1, i -> {
                    DlnaDevice d = devs.get(i);
                    String title = playerTitleView != null ? playerTitleView.getText().toString() : "OctoStream";
                    dlnaSend(d.controlUrl, currentUrl, title);
                });
            });
        }).start();
    }

    // Escaneo del /24 local buscando otros OctoStream (SyncServer /ping).
    private void showOctoStreamScan() {
        showInPlayerMenu("Enviar a OctoStream", new String[]{"Buscando en la red local…"}, -1, i -> {});
        new Thread(() -> {
            final java.util.List<String> found = scanOctoDevices();
            mainHandler.post(() -> {
                if (found.isEmpty()) {
                    showInPlayerMenu("Enviar a OctoStream",
                        new String[]{"Ningún OctoStream encontrado", "Reintentar búsqueda"}, -1,
                        i -> { if (i == 1) showOctoStreamScan(); });
                } else {
                    String[] labels = new String[found.size()];
                    for (int i = 0; i < found.size(); i++) {
                        String[] parts = found.get(i).split("\\|", 2);
                        labels[i] = parts[0] + "  ·  " + parts[1];
                    }
                    showInPlayerMenu("Enviar a OctoStream", labels, -1, i -> {
                        String ip = found.get(i).split("\\|", 2)[1];
                        sendPlayToOcto(ip);
                    });
                }
            });
        }).start();
    }

    // Devuelve entradas "modelo|ip" de cada OctoStream que responde /ping.
    private java.util.List<String> scanOctoDevices() {
        java.util.List<String> found = java.util.Collections.synchronizedList(new ArrayList<>());
        try {
            String localIp = localIpv4();
            if (localIp == null) {
                Log.w(TAG, "scanOctoDevices: no local IPv4 found");
                return found;
            }
            final String prefix = localIp.substring(0, localIp.lastIndexOf('.'));
            Log.d(TAG, "scanOctoDevices: localIp=" + localIp + " scanning " + prefix + ".1-254");
            java.util.concurrent.ExecutorService pool =
                    java.util.concurrent.Executors.newFixedThreadPool(48);
            java.util.List<java.util.concurrent.Future<?>> tasks = new ArrayList<>();
            final java.util.concurrent.atomic.AtomicInteger errCount = new java.util.concurrent.atomic.AtomicInteger();
            final java.util.concurrent.atomic.AtomicReference<String> firstErr = new java.util.concurrent.atomic.AtomicReference<>();
            for (int i = 1; i <= 254; i++) {
                final String host = prefix + "." + i;
                if (host.equals(localIp)) continue;
                tasks.add(pool.submit(() -> {
                    java.net.HttpURLConnection c = null;
                    try {
                        // NO_PROXY: el cloud-proxy (WARP) fija http.proxyHost a nivel JVM;
                        // las peticiones LAN deben ir directas o darían timeout.
                        c = (java.net.HttpURLConnection) new java.net.URL("http://" + host + ":8765/ping")
                                .openConnection(java.net.Proxy.NO_PROXY);
                        c.setConnectTimeout(900);
                        c.setReadTimeout(900);
                        if (c.getResponseCode() == 200) {
                            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                            java.io.InputStream in = c.getInputStream();
                            byte[] buf = new byte[512];
                            int n;
                            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
                            String model = new JSONObject(bos.toString("UTF-8")).optString("model", "OctoStream");
                            found.add(model + "|" + host);
                        }
                    } catch (Exception e) {
                        errCount.incrementAndGet();
                        firstErr.compareAndSet(null, e.getClass().getSimpleName() + ": " + e.getMessage());
                    } finally {
                        if (c != null) c.disconnect();
                    }
                }));
            }
            for (java.util.concurrent.Future<?> t : tasks) {
                try { t.get(12, TimeUnit.SECONDS); } catch (Exception ignored) {}
            }
            pool.shutdownNow();
            Log.d(TAG, "scanOctoDevices: found=" + found.size() + " errors=" + errCount.get()
                    + (firstErr.get() != null ? " first=" + firstErr.get() : ""));
        } catch (Exception e) {
            Log.e(TAG, "scanOctoDevices error: " + e.getMessage());
        }
        return found;
    }

    // POST /play {url,title,type,mode} → el otro dispositivo abre el reproductor.
    private void sendPlayToOcto(String ip) {
        final String url = currentUrl != null ? currentUrl : "";
        final String title = playerTitleView != null ? playerTitleView.getText().toString() : "OctoStream";
        final String mode = playerMode != null ? playerMode : "live";
        new Thread(() -> {
            boolean ok = false;
            boolean needsPair = false;
            java.net.HttpURLConnection c = null;
            try {
                c = (java.net.HttpURLConnection) new java.net.URL("http://" + ip + ":8765/play")
                        .openConnection(java.net.Proxy.NO_PROXY);
                c.setConnectTimeout(4000);
                c.setReadTimeout(4000);
                c.setRequestMethod("POST");
                c.setRequestProperty("Content-Type", "application/json");
                c.setDoOutput(true);
                JSONObject body = new JSONObject();
                body.put("url", url);
                body.put("title", title);
                body.put("type", url.contains(".mp4") ? "mp4" : "hls");
                body.put("mode", mode);
                c.getOutputStream().write(body.toString().getBytes("UTF-8"));
                int code = c.getResponseCode();
                ok = code == 200;
                needsPair = code == 403;
            } catch (Exception e) {
                Log.e(TAG, "sendPlayToOcto error: " + e.getMessage());
            } finally {
                if (c != null) c.disconnect();
            }
            final boolean sent = ok;
            final boolean pair = needsPair;
            mainHandler.post(() -> Toast.makeText(getContext(),
                sent ? "Enviado a OctoStream (" + ip + ")"
                     : pair ? "Acepta la solicitud en " + ip + " y reintenta"
                            : "No se pudo enviar a " + ip,
                Toast.LENGTH_SHORT).show());
        }).start();
    }

    // Devuelve la IPv4 de la LAN (Wi-Fi/Ethernet). Ignora interfaces de
    // VPN/túnel (tun*, wg*, ppp*) que reportarían la subred equivocada.
    private String localIpv4() {
        String fallback = null;
        try {
            java.util.Enumeration<java.net.NetworkInterface> nis = java.net.NetworkInterface.getNetworkInterfaces();
            while (nis != null && nis.hasMoreElements()) {
                java.net.NetworkInterface ni = nis.nextElement();
                try {
                    if (!ni.isUp() || ni.isLoopback()) continue;
                } catch (Exception ignored) { continue; }
                String name = ni.getName() != null ? ni.getName().toLowerCase() : "";
                boolean isTunnel = name.startsWith("tun") || name.startsWith("wg")
                        || name.startsWith("ppp") || name.startsWith("tap") || name.startsWith("rmnet");
                java.util.Enumeration<InetAddress> addrs = ni.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    InetAddress a = addrs.nextElement();
                    if (a instanceof java.net.Inet4Address && !a.isLoopbackAddress()) {
                        String ip = a.getHostAddress();
                        if (!isTunnel) return ip;
                        if (fallback == null) fallback = ip;
                    }
                }
            }
        } catch (Exception ignored) {}
        return fallback;
    }

    private void copyStreamUrlToClipboard() {
        try {
            android.content.Context ctx = getContext();
            if (ctx == null) return;
            android.content.ClipboardManager clipboard =
                    (android.content.ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
            android.content.ClipData clip = android.content.ClipData.newPlainText("Stream URL", currentUrl != null ? currentUrl : "");
            clipboard.setPrimaryClip(clip);
            Toast.makeText(ctx, "URL copiada al portapapeles", Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Log.e(TAG, "Cast: copy URL error: " + e.getMessage());
        }
    }

    private void openCastReceiverInBrowser() {
        try {
            android.content.Context ctx = getContext();
            if (ctx == null) return;
            String ip = localIpv4();
            String baseHost = ip != null ? "http://" + ip + ":5173" : "http://localhost:5173";
            String title = playerTitleView != null ? playerTitleView.getText().toString() : "OctoStream";
            String receiverUrl = baseHost + "/#/cast?url=" + java.net.URLEncoder.encode(currentUrl != null ? currentUrl : "", "UTF-8")
                    + "&title=" + java.net.URLEncoder.encode(title, "UTF-8");
            Intent browserIntent = new Intent(Intent.ACTION_VIEW, android.net.Uri.parse(receiverUrl));
            browserIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(browserIntent);
            Toast.makeText(ctx, "Abriendo en navegador...", Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Log.e(TAG, "Cast: open browser error: " + e.getMessage());
            Toast.makeText(getContext(), "No se pudo abrir el navegador", Toast.LENGTH_SHORT).show();
        }
    }

    // Abre el selector de dispositivos Cast del sistema.
    // MediaRouteButton necesita estar añadido a una vista visible para que
    // performClick() abra el diálogo. Lo añadimos temporalmente al
    // controlsOverlay, hacemos click, y lo eliminamos después.
    private void openCastDevicePicker() {
        try {
            android.content.Context ctx = getContext();
            if (ctx == null) return;
            if (controlsOverlay == null) {
                Log.e(TAG, "openCastDevicePicker: controlsOverlay is null");
                return;
            }
            // Crear un MediaRouteButton y configurarlo con CastButtonFactory
            androidx.mediarouter.app.MediaRouteButton routeButton =
                    new androidx.mediarouter.app.MediaRouteButton(ctx);
            routeButton.setVisibility(View.VISIBLE);
            routeButton.setAlpha(0f); // invisible pero presente en el layout
            CastButtonFactory.setUpMediaRouteButton(ctx, routeButton);
            // Añadir temporalmente al controlsOverlay
            controlsOverlay.addView(routeButton);
            // performClick() abre el diálogo del sistema para seleccionar dispositivo
            routeButton.performClick();
            // Eliminar el botón después de un breve delay (el diálogo se abre asíncrono)
            mainHandler.postDelayed(() -> {
                try {
                    if (routeButton.getParent() == controlsOverlay) {
                        controlsOverlay.removeView(routeButton);
                    }
                } catch (Exception ignored) {}
            }, 1000);
        } catch (Exception e) {
            Log.e(TAG, "openCastDevicePicker error: " + e.getMessage());
        }
    }

    // Carga la URL actual en la sesión Cast conectada.
    private void loadMediaOnCast(CastSession session) {
        if (session == null || currentUrl == null || currentUrl.isEmpty()) {
            Log.w(TAG, "loadMediaOnCast: session or url empty");
            return;
        }
        try {
            RemoteMediaClient client = session.getRemoteMediaClient();
            if (client == null) {
                Log.w(TAG, "loadMediaOnCast: RemoteMediaClient null");
                return;
            }
            String contentType = "application/vnd.apple.mpegurl"; // HLS por defecto
            if (currentUrl.contains(".mp4")) contentType = "video/mp4";
            else if (currentUrl.contains(".dash") || currentUrl.contains(".mpd")) contentType = "application/dash+xml";

            MediaMetadata metadata = new MediaMetadata(MediaMetadata.MEDIA_TYPE_MOVIE);
            String title = playerTitleView != null ? playerTitleView.getText().toString() : "OctoStream";
            metadata.putString(MediaMetadata.KEY_TITLE, title);

            com.google.android.gms.cast.MediaInfo mediaInfo =
                    new com.google.android.gms.cast.MediaInfo.Builder(currentUrl)
                            .setContentType(contentType)
                            .setStreamType(com.google.android.gms.cast.MediaInfo.STREAM_TYPE_BUFFERED)
                            .setMetadata(metadata)
                            .build();

            client.load(new com.google.android.gms.cast.MediaLoadRequestData.Builder()
                    .setMediaInfo(mediaInfo)
                    .build());
            Log.i(TAG, "loadMediaOnCast: loaded host=" + hostOf(currentUrl));
        } catch (Exception e) {
            Log.e(TAG, "loadMediaOnCast error: " + e.getMessage());
        }
    }

    private void showPlaybackSpeedMenu() {
        String[] labels = {"0.5x", "0.75x", "Normal (1x)", "1.25x", "1.5x", "2x"};
        float[] speeds = {0.5f, 0.75f, 1f, 1.25f, 1.5f, 2f};
        int selectedNow = 2;
        for (int i = 0; i < speeds.length; i++) {
            if (Math.abs(speeds[i] - currentSpeed) < 0.01f) { selectedNow = i; break; }
        }
        showInPlayerMenu("Velocidad de reproducción", labels, selectedNow, (selected) -> {
            currentSpeed = speeds[selected];
            if (player != null) player.setPlaybackParameters(new PlaybackParameters(currentSpeed));
            if (speedLabel != null) speedLabel.setText(formatSpeed(currentSpeed));
        });
    }

    private int dp(int value) {
        return Math.round(value * getContext().getResources().getDisplayMetrics().density);
    }

    private void adjustVolume(int direction) {
        AudioManager audioManager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (audioManager != null) {
            audioManager.adjustStreamVolume(AudioManager.STREAM_MUSIC, direction, AudioManager.FLAG_SHOW_UI);
        }
        showControls();
    }

    private void configureLoudnessEnhancer(int audioSessionId) {
        releaseLoudnessEnhancer();
        if (audioSessionId == C.AUDIO_SESSION_ID_UNSET) return;
        try {
            loudnessEnhancer = new LoudnessEnhancer(audioSessionId);
            applyVolumeBoost();
        } catch (Exception e) {
            Log.w(TAG, "Volume amplifier unavailable", e);
        }
    }

    private void applyVolumeBoost() {
        // 100% -> 0 mB (sin amplificación); 300% -> 2000 mB (20 dB, máximo razonable).
        int gainMilliBel = Math.max(0, boostPercent - 100) * 10;
        Log.i(TAG, "applyVolumeBoost: boostPercent=" + boostPercent + " gainmB=" + gainMilliBel
                + " enhancer=" + (loudnessEnhancer != null ? "yes" : "null"));
        if (loudnessEnhancer != null) {
            try {
                loudnessEnhancer.setTargetGain(gainMilliBel);
                loudnessEnhancer.setEnabled(boostPercent > 100);
            } catch (Exception e) {
                Log.w(TAG, "Could not change volume boost", e);
            }
        } else {
            // Intentar configurar el LoudnessEnhancer con el audio session actual
            // del player, por si onAudioSessionIdChanged no se disparó todavía.
            if (player != null) {
                int sessionId = player.getAudioSessionId();
                Log.i(TAG, "applyVolumeBoost: no enhancer, trying sessionId=" + sessionId);
                if (sessionId != C.AUDIO_SESSION_ID_UNSET) {
                    configureLoudnessEnhancer(sessionId);
                }
            }
        }
        if (boostButton != null) {
            boostButton.setContentDescription("Amplificador " + boostPercent + "%");
            boostButton.setAlpha(boostPercent > 100 ? 1f : 0.7f);
        }
    }

    private void releaseLoudnessEnhancer() {
        if (loudnessEnhancer != null) {
            try {
                loudnessEnhancer.setEnabled(false);
                loudnessEnhancer.release();
            } catch (Exception ignored) {
            }
            loudnessEnhancer = null;
        }
    }

    private Map<String, String> parseHeaders(JSONObject headersJson) {
        Map<String, String> headers = new HashMap<>();
        if (headersJson != null) {
            Iterator<String> keys = headersJson.keys();
            while (keys.hasNext()) {
                try {
                    String key = keys.next();
                    String value = headersJson.getString(key);
                    if (value != null && !value.isEmpty()) {
                        headers.put(key, value);
                    }
                } catch (Exception e) {
                    Log.w(TAG, "Failed to parse header", e);
                }
            }
        }
        return headers;
    }

    @PluginMethod
    public void pause(PluginCall call) {
        mainHandler.post(() -> {
            if (player != null) player.setPlayWhenReady(false);
            call.resolve();
        });
    }

    @PluginMethod
    public void resume(PluginCall call) {
        mainHandler.post(() -> {
            if (player != null) player.setPlayWhenReady(true);
            call.resolve();
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        mainHandler.post(() -> {
            // stop() se usa para limpiar el player desde React (cleanup,
            // fallback HLS o cambio de stream), no para una pulsación explícita
            // de Back/X. No emitir "closed" aquí: React lo interpretaría como
            // un cierre del usuario, navegaría atrás y podría volver a montar
            // LiveTV con el mismo canal.
            suppressClosedEvent = true;
            try {
                closePlayer();
            } finally {
                suppressClosedEvent = false;
            }
            call.resolve();
        });
    }

    // Miracast desde la UI web: busca una pantalla WiFi Display por MediaRouter
    // y conecta directo si aparece; si el dispositivo no tiene emisor Miracast
    // o no se ve ninguna pantalla, se abren los ajustes de proyección.
    @PluginMethod
    @SuppressWarnings("deprecation")
    public void openMiracast(PluginCall call) {
        if (!hasWfdScanPermission()) {
            // El escaneo P2P necesita permiso de runtime; se pide solo aquí.
            requestPermissionForAlias(
                    android.os.Build.VERSION.SDK_INT >= 33 ? "wfdScan33" : "wfdScanLegacy",
                    call, "miracastPermsResult");
            return;
        }
        openMiracastNow(call);
    }

    @PermissionCallback
    private void miracastPermsResult(PluginCall call) {
        // Concedido o no, se continúa: MediaRouter y los ajustes no lo exigen.
        openMiracastNow(call);
    }

    @SuppressWarnings("deprecation")
    private void openMiracastNow(PluginCall call) {
        Context ctx = getContext();
        final android.media.MediaRouter router = ctx != null
                && ctx.getPackageManager().hasSystemFeature(android.content.pm.PackageManager.FEATURE_WIFI_DIRECT)
                ? (android.media.MediaRouter) ctx.getSystemService(Context.MEDIA_ROUTER_SERVICE)
                : null;
        if (router != null) {
            android.media.MediaRouter.RouteInfo known = findMiracastRoute(router);
            if (known != null) {
                router.selectRoute(ROUTE_TYPE_REMOTE_DISPLAY, known);
                call.resolve(new com.getcapacitor.JSObject().put("connected", true).put("device", known.getName().toString()));
                return;
            }
            // Escaneo combinado: MediaRouter (rutas que el sistema ya conoce)
            // durante ~8s, y en paralelo un discoverPeers P2P real que sí
            // encuentra sinks Miracast aunque Android no los exponga como ruta.
            final android.media.MediaRouter.Callback scanCb = new android.media.MediaRouter.Callback() {
                @Override public void onRouteSelected(android.media.MediaRouter mr, int t, android.media.MediaRouter.RouteInfo i) {}
                @Override public void onRouteUnselected(android.media.MediaRouter mr, int t, android.media.MediaRouter.RouteInfo i) {}
                @Override public void onRouteAdded(android.media.MediaRouter mr, android.media.MediaRouter.RouteInfo i) {}
                @Override public void onRouteRemoved(android.media.MediaRouter mr, android.media.MediaRouter.RouteInfo i) {}
                @Override public void onRouteChanged(android.media.MediaRouter mr, android.media.MediaRouter.RouteInfo i) {}
                @Override public void onRouteGrouped(android.media.MediaRouter mr, android.media.MediaRouter.RouteInfo i, android.media.MediaRouter.RouteGroup g, int idx) {}
                @Override public void onRouteUngrouped(android.media.MediaRouter mr, android.media.MediaRouter.RouteInfo i, android.media.MediaRouter.RouteGroup g) {}
                @Override public void onRouteVolumeChanged(android.media.MediaRouter mr, android.media.MediaRouter.RouteInfo i) {}
            };
            router.addCallback(ROUTE_TYPE_REMOTE_DISPLAY, scanCb,
                    CALLBACK_FLAG_REQUEST_DISCOVERY | android.media.MediaRouter.CALLBACK_FLAG_PERFORM_ACTIVE_SCAN);
            scanWifiDirectPeers(peers -> mainHandler.post(() -> {
                // El sistema puede tardar 1-2s en publicar el peer P2P como
                // ruta MediaRouter tras descubrirlo: una re-comprobación
                // diferida permite que selectRoute conecte sin abrir ajustes.
                Runnable decide = () -> {
                    try { router.removeCallback(scanCb); } catch (Exception ignored) {}
                    android.media.MediaRouter.RouteInfo f = findMiracastRoute(router);
                    if (f != null) {
                        router.selectRoute(ROUTE_TYPE_REMOTE_DISPLAY, f);
                        call.resolve(new com.getcapacitor.JSObject().put("connected", true).put("device", f.getName().toString()));
                    } else {
                        openMiracastSettings();
                        com.getcapacitor.JSObject res = new com.getcapacitor.JSObject().put("connected", false);
                        if (!peers.isEmpty()) res.put("peers", new com.getcapacitor.JSArray(peers));
                        call.resolve(res);
                    }
                };
                if (!peers.isEmpty() && findMiracastRoute(router) == null) {
                    mainHandler.postDelayed(decide, 2500);
                } else {
                    decide.run();
                }
            }));
            return;
        }
        String[] actions = {
            "android.settings.WIRELESS_DISPLAY_SETTINGS",
            "android.settings.CAST_SETTINGS",
            android.provider.Settings.ACTION_DISPLAY_SETTINGS,
            android.provider.Settings.ACTION_SETTINGS,
        };
        for (String a : actions) {
            try {
                android.content.Intent i = new android.content.Intent(a);
                i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
                call.resolve(new com.getcapacitor.JSObject().put("connected", false));
                return;
            } catch (Exception ignored) {}
        }
        call.reject("No se pudo abrir la pantalla de proyección inalámbrica");
    }

    // Envía la URL a la primera TV DLNA (MediaRenderer) encontrada en la red.
    @PluginMethod
    public void openDlna(PluginCall call) {
        String mediaUrl = call.getString("url", "");
        String title = call.getString("title", "OctoStream");
        if (mediaUrl == null || mediaUrl.isEmpty()) {
            call.reject("Falta la URL del stream");
            return;
        }
        Uri parsedDlna = Uri.parse(mediaUrl);
        String dlnaScheme = parsedDlna.getScheme();
        if (dlnaScheme == null || !(dlnaScheme.equalsIgnoreCase("http") || dlnaScheme.equalsIgnoreCase("https"))) {
            call.reject("invalid url scheme: only http/https are allowed");
            return;
        }
        final String url = mediaUrl;
        final String t = title;
        new Thread(() -> {
            java.util.List<DlnaDevice> devs = scanDlnaRenderers();
            if (devs.isEmpty()) {
                call.resolve(new com.getcapacitor.JSObject().put("sent", false).put("reason", "no_devices"));
                return;
            }
            DlnaDevice d = devs.get(0);
            dlnaSend(d.controlUrl, url, t);
            call.resolve(new com.getcapacitor.JSObject().put("sent", true).put("device", d.name));
        }).start();
    }

    @PluginMethod
    public void setNextEpisode(PluginCall call) {
        String title = call.getString("title", "");
        String seriesName = call.getString("seriesName", "");
        int season = call.getInt("season", 0);
        int episode = call.getInt("episode", 0);
        String posterUrl = call.getString("poster", "");
        boolean autoPlay = call.getBoolean("autoPlay", true);
        mainHandler.post(() -> {
            nextEpTitle = title;
            nextEpSeriesName = seriesName;
            nextEpSeason = season;
            nextEpEpisode = episode;
            nextEpPosterUrl = posterUrl;
            nextEpAutoPlay = autoPlay;
            // Do NOT reset nextEpShown here — it's reset when a new stream
            // starts (openPlayer/closePlayer). Resetting it here while the
            // previous episode is still playing near its end causes the
            // position checker to immediately show a popup for the NEW next
            // episode, resulting in two popups for different episodes.
            dismissNextEpPopup();
            Log.i(TAG, "setNextEpisode: " + seriesName + " S" + season + "E" + episode + " title=" + title);
            call.resolve();
        });
    }

    private void showNextEpPopup() {
        if (nextEpPopupView != null || dialog == null) return;
        Context context = getContext();
        ViewGroup root = (ViewGroup) dialog.getWindow().getDecorView();
        if (root == null) return;

        // ===== Main card container (bottom-right, Netflix-style) =====
        FrameLayout card = new FrameLayout(context);
        FrameLayout.LayoutParams cardParams = new FrameLayout.LayoutParams(
                dp(360), ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM | Gravity.END);
        cardParams.setMargins(dp(20), dp(20), dp(20), dp(80));
        card.setLayoutParams(cardParams);
        card.setElevation(dp(12));
        card.setFocusable(false);
        card.setClipToOutline(true);
        android.graphics.drawable.GradientDrawable cardBg = new android.graphics.drawable.GradientDrawable();
        cardBg.setCornerRadius(dp(12));
        cardBg.setColor(0xF2121418);
        card.setBackground(cardBg);

        LinearLayout content = new LinearLayout(context);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(0, 0, 0, dp(16));
        content.setFocusable(false);
        card.addView(content);

        // ===== Thumbnail (16:9, full width) =====
        FrameLayout thumbContainer = new FrameLayout(context);
        thumbContainer.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(180)));
        thumbContainer.setFocusable(false);
        thumbContainer.setClipToOutline(true);
        android.graphics.drawable.GradientDrawable thumbBg = new android.graphics.drawable.GradientDrawable();
        thumbBg.setCornerRadius(dp(12));
        thumbBg.setColor(0xFF1A1A2E);
        thumbContainer.setBackground(thumbBg);

        // Placeholder while loading
        LinearLayout placeholder = new LinearLayout(context);
        placeholder.setOrientation(LinearLayout.VERTICAL);
        placeholder.setGravity(Gravity.CENTER);
        placeholder.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        placeholder.setFocusable(false);
        TextView phText = new TextView(context);
        phText.setText("E" + nextEpEpisode);
        phText.setTextColor(0xFFBB86FC);
        phText.setTextSize(28);
        phText.setTypeface(null, android.graphics.Typeface.BOLD);
        placeholder.addView(phText);
        thumbContainer.addView(placeholder);

        content.addView(thumbContainer);

        // ===== Info section =====
        LinearLayout infoSection = new LinearLayout(context);
        infoSection.setOrientation(LinearLayout.VERTICAL);
        infoSection.setPadding(dp(20), dp(16), dp(20), 0);
        infoSection.setFocusable(false);

        // "Siguiente episodio" label
        TextView nextLabel = new TextView(context);
        nextLabel.setText("SIGUIENTE EPISODIO");
        nextLabel.setTextColor(0xFFBB86FC);
        nextLabel.setTextSize(10);
        nextLabel.setTypeface(null, android.graphics.Typeface.BOLD);
        nextLabel.setPadding(0, 0, 0, dp(6));
        infoSection.addView(nextLabel);

        // Episode title
        TextView epTitle = new TextView(context);
        epTitle.setText(nextEpTitle != null ? nextEpTitle : "");
        epTitle.setTextColor(Color.WHITE);
        epTitle.setTextSize(16);
        epTitle.setTypeface(null, android.graphics.Typeface.BOLD);
        epTitle.setMaxLines(2);
        epTitle.setEllipsize(android.text.TextUtils.TruncateAt.END);
        epTitle.setPadding(0, 0, 0, dp(4));
        infoSection.addView(epTitle);

        // Series · Season · Episode
        TextView epInfo = new TextView(context);
        epInfo.setText(nextEpSeriesName + "  ·  T" + nextEpSeason + " E" + nextEpEpisode);
        epInfo.setTextColor(0xFF888888);
        epInfo.setTextSize(12);
        epInfo.setMaxLines(1);
        epInfo.setEllipsize(android.text.TextUtils.TruncateAt.END);
        infoSection.addView(epInfo);

        content.addView(infoSection);

        // ===== Buttons row =====
        LinearLayout bottomRow = new LinearLayout(context);
        bottomRow.setOrientation(LinearLayout.HORIZONTAL);
        bottomRow.setGravity(Gravity.CENTER_VERTICAL);
        bottomRow.setPadding(dp(20), dp(16), dp(20), 0);
        bottomRow.setFocusable(false);

        // "Siguiente" button
        Button playBtn = new Button(context);
        playBtn.setText("▶  Siguiente");
        playBtn.setTextColor(Color.WHITE);
        playBtn.setTextSize(13);
        playBtn.setTypeface(null, android.graphics.Typeface.BOLD);
        android.graphics.drawable.GradientDrawable playBg = new android.graphics.drawable.GradientDrawable();
        playBg.setCornerRadius(dp(8));
        playBg.setColor(0xFFBB86FC);
        playBtn.setBackground(playBg);
        playBtn.setPadding(dp(20), dp(10), dp(20), dp(10));
        playBtn.setFocusable(true);
        playBtn.setFocusableInTouchMode(true);
        playBtn.setOnClickListener(v -> {
            dismissNextEpPopup();
            notifyNextEpisodePlay();
        });
        applyFocusScale(playBtn);
        bottomRow.addView(playBtn);

        // "Cerrar" button
        Button closeBtn = new Button(context);
        closeBtn.setText("✕  Cerrar");
        closeBtn.setTextColor(0xFFCCCCCC);
        closeBtn.setTextSize(13);
        android.graphics.drawable.GradientDrawable closeBg = new android.graphics.drawable.GradientDrawable();
        closeBg.setCornerRadius(dp(8));
        closeBg.setColor(0xFF2A2A3E);
        closeBtn.setBackground(closeBg);
        closeBtn.setPadding(dp(20), dp(10), dp(20), dp(10));
        closeBtn.setFocusable(true);
        closeBtn.setFocusableInTouchMode(true);
        closeBtn.setOnClickListener(v -> {
            dismissNextEpPopup();
            if (nextEpCountdownRunnable != null) {
                mainHandler.removeCallbacks(nextEpCountdownRunnable);
                nextEpCountdownRunnable = null;
            }
        });
        applyFocusScale(closeBtn);
        LinearLayout.LayoutParams closeBtnParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        closeBtnParams.setMarginStart(dp(10));
        bottomRow.addView(closeBtn, closeBtnParams);

        // Countdown text
        final TextView countdownText = new TextView(context);
        countdownText.setTextColor(0xFFAAAAAA);
        countdownText.setTextSize(12);
        countdownText.setId(android.R.id.text1);
        countdownText.setGravity(Gravity.END);
        bottomRow.addView(countdownText, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        content.addView(bottomRow);

        root.addView(card);
        nextEpPopupView = card;
        playBtn.requestFocus();

        // ===== Load thumbnail asynchronously =====
        final FrameLayout finalThumbContainer = thumbContainer;
        final LinearLayout finalPlaceholder = placeholder;
        if (nextEpPosterUrl != null && !nextEpPosterUrl.isEmpty()) {
            new Thread(() -> {
                try {
                    java.net.URL url = new java.net.URL(nextEpPosterUrl);
                    java.net.HttpURLConnection conn = (java.net.HttpURLConnection) url.openConnection();
                    conn.setConnectTimeout(4000);
                    conn.setReadTimeout(4000);
                    conn.connect();
                    if (conn.getResponseCode() == 200) {
                        java.io.InputStream is = conn.getInputStream();
                        android.graphics.Bitmap bmp = android.graphics.BitmapFactory.decodeStream(is);
                        is.close();
                        conn.disconnect();
                        if (bmp != null) {
                            mainHandler.post(() -> {
                                if (nextEpPopupView == null) return;
                                ImageView posterView = new ImageView(context);
                                posterView.setImageBitmap(bmp);
                                posterView.setScaleType(ImageView.ScaleType.CENTER_CROP);
                                posterView.setLayoutParams(new FrameLayout.LayoutParams(
                                        ViewGroup.LayoutParams.MATCH_PARENT,
                                        ViewGroup.LayoutParams.MATCH_PARENT));
                                posterView.setFocusable(false);
                                finalThumbContainer.removeView(finalPlaceholder);
                                finalThumbContainer.addView(posterView, 0);
                            });
                        }
                    } else {
                        conn.disconnect();
                    }
                } catch (Exception e) {
                    Log.w(TAG, "Thumbnail load failed: " + e.getMessage());
                }
            }).start();
        }

        // Start countdown (10 seconds)
        nextEpCountdown = 10;
        countdownText.setText("Auto-play en " + nextEpCountdown + "s");
        nextEpCountdownRunnable = new Runnable() {
            @Override
            public void run() {
                nextEpCountdown--;
                if (nextEpCountdown <= 0) {
                    dismissNextEpPopup();
                    notifyNextEpisodePlay();
                    return;
                }
                countdownText.setText("Auto-play en " + nextEpCountdown + "s");
                mainHandler.postDelayed(this, 1000);
            }
        };
        mainHandler.postDelayed(nextEpCountdownRunnable, 1000);
    }

    private void dismissNextEpPopup() {
        if (nextEpPopupView != null && nextEpPopupView.getParent() instanceof ViewGroup) {
            ((ViewGroup) nextEpPopupView.getParent()).removeView(nextEpPopupView);
        }
        nextEpPopupView = null;
        if (nextEpCountdownRunnable != null) {
            mainHandler.removeCallbacks(nextEpCountdownRunnable);
            nextEpCountdownRunnable = null;
        }
    }

    private void notifyNextEpisodePlay() {
        JSObject event = new JSObject();
        event.put("state", "nextEpisode");
        notifyListeners("playbackState", event);
    }

    // Loading overlay shown when an episode ends and the next is being resolved.
    // Full-screen black background with OctoStream logo + spinner + text.
    private View nextEpLoadingView = null;
    private View streamLoadingView = null;

    // Overlay de carga de marca OctoStream: fondo negro + logo + spinner +
    // texto. Compartido por la carga inicial del stream y el siguiente
    // episodio.
    private View buildLoadingOverlay(String text) {
        Context context = getContext();

        // Full-screen black background
        FrameLayout bg = new FrameLayout(context);
        bg.setBackgroundColor(Color.BLACK);
        bg.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        bg.setFocusable(false);
        bg.setClickable(true);

        // Centered content
        LinearLayout content = new LinearLayout(context);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setGravity(Gravity.CENTER);
        content.setFocusable(false);
        content.setPadding(dp(40), 0, dp(40), 0);
        FrameLayout.LayoutParams contentParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
                Gravity.CENTER);
        bg.addView(content, contentParams);

        // ===== OctoStream logo image (titulo-logo.png) =====
        ImageView logo = new ImageView(context);
        logo.setImageResource(context.getResources().getIdentifier("octo_logo", "drawable", context.getPackageName()));
        logo.setScaleType(ImageView.ScaleType.FIT_CENTER);
        logo.setAdjustViewBounds(true);
        LinearLayout.LayoutParams logoParams = new LinearLayout.LayoutParams(
                dp(280), dp(40));
        logoParams.gravity = Gravity.CENTER;
        logoParams.bottomMargin = dp(32);
        content.addView(logo, logoParams);

        // Pulso suave sobre el logo (alpha 1 → 0.45 → 1 en bucle), como el
        // animate-warp-pulse del LogoLoader web.
        android.animation.ObjectAnimator pulse = android.animation.ObjectAnimator.ofFloat(logo, "alpha", 1f, 0.45f, 1f);
        pulse.setDuration(1400);
        pulse.setRepeatCount(android.animation.ValueAnimator.INFINITE);
        pulse.setInterpolator(new android.view.animation.AccelerateDecelerateInterpolator());
        pulse.start();

        // ===== Spinner with project color =====
        ProgressBar spinner = new ProgressBar(context, null, android.R.attr.progressBarStyleLarge);
        spinner.setIndeterminate(true);
        spinner.getIndeterminateDrawable().setColorFilter(
                0xFFa855f7, android.graphics.PorterDuff.Mode.SRC_IN);
        LinearLayout.LayoutParams spinnerParams = new LinearLayout.LayoutParams(dp(56), dp(56));
        spinnerParams.gravity = Gravity.CENTER;
        spinnerParams.bottomMargin = dp(20);
        content.addView(spinner, spinnerParams);

        // ===== Loading text =====
        TextView loadingText = new TextView(context);
        loadingText.setTag("octo_loading_text");
        loadingText.setText(text);
        loadingText.setTextColor(0xFFCCCCCC);
        loadingText.setTextSize(14);
        loadingText.setGravity(Gravity.CENTER);
        loadingText.setSingleLine(false);
        loadingText.setMaxLines(3);
        LinearLayout.LayoutParams textParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        textParams.gravity = Gravity.CENTER;
        content.addView(loadingText, textParams);

        return bg;
    }

    // Pantalla "Cargando enlace…" mientras el stream arranca: se muestra al
    // abrir el player y se quita con el primer STATE_READY (o al cerrar).
    private void showStreamLoading() {
        if (streamLoadingView != null || dialog == null) return;
        ViewGroup root = (ViewGroup) dialog.getWindow().getDecorView();
        if (root == null) return;
        View bg = buildLoadingOverlay(streamLoadingText);
        root.addView(bg);
        streamLoadingView = bg;
    }

    private void dismissStreamLoading() {
        if (streamLoadingView != null && streamLoadingView.getParent() instanceof ViewGroup) {
            ((ViewGroup) streamLoadingView.getParent()).removeView(streamLoadingView);
        }
        streamLoadingView = null;
    }

    // Actualiza el texto del overlay de carga (stream inicial o siguiente
    // episodio) sin recrearlo — lo usa JS para empujar el progreso del torrent.
    private void setOverlayLoadingText(View overlay, String text) {
        if (overlay == null || text == null) return;
        TextView tv = overlay.findViewWithTag("octo_loading_text");
        if (tv != null) tv.setText(text);
    }

    @PluginMethod
    public void setLoadingText(PluginCall call) {
        String text = call.getString("text");
        mainHandler.post(() -> {
            setOverlayLoadingText(streamLoadingView, text);
            setOverlayLoadingText(nextEpLoadingView, text);
            call.resolve();
        });
    }

    private void showNextEpLoading() {
        if (nextEpLoadingView != null || dialog == null) return;
        ViewGroup root = (ViewGroup) dialog.getWindow().getDecorView();
        if (root == null) return;
        View bg = buildLoadingOverlay("Cargando siguiente episodio...");
        root.addView(bg);
        nextEpLoadingView = bg;
        Log.i(TAG, "Showing next episode loading overlay");
    }

    private void dismissNextEpLoading() {
        if (nextEpLoadingView != null && nextEpLoadingView.getParent() instanceof ViewGroup) {
            ((ViewGroup) nextEpLoadingView.getParent()).removeView(nextEpLoadingView);
        }
        nextEpLoadingView = null;
    }

    @PluginMethod
    public void seekTo(PluginCall call) {
        Double position = call.getDouble("position", 0.0);
        mainHandler.post(() -> {
            if (player != null) {
                player.seekTo((long) (position * 1000));
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void setPlaybackRate(PluginCall call) {
        Double rate = call.getDouble("rate", 1.0);
        mainHandler.post(() -> {
            if (player != null) {
                player.setPlaybackParameters(new PlaybackParameters(rate.floatValue()));
            }
            call.resolve();
        });
    }

    private void closePlayer() {
        // Cancel any pending zap debounce so a stale channelZap event
        // doesn't fire after the player is gone.
        if (zapDebounceRunnable != null) {
            mainHandler.removeCallbacks(zapDebounceRunnable);
            zapDebounceRunnable = null;
        }
        pendingZapIndex = -1;
        // Cancel any pending buffering timeout
        cancelBufferingCheck();
        // Dismiss next episode popup if visible (but keep nextEpTitle so it
        // survives the closePlayer() call that openPlayer() makes when starting
        // a new episode — setNextEpisode is called BEFORE playStream, so
        // resetting nextEpTitle here would wipe it before the new player starts).
        dismissNextEpPopup();
        dismissNextEpLoading();
        dismissStreamLoading();
        nextEpShown = false;
        // Always destroy resolver WebView and its dialog before releasing playback.
        cleanupResolver();
        // Y el relay local (WebView oculto + servidor loopback) si estaba
        // sirviendo media de un embed con CDN bloqueado.
        stopEmbedRelay();
        pendingSeekMs = 0;
        if (embedDialog != null) {
            try { embedDialog.dismiss(); } catch (Exception ignored) {}
            embedDialog = null;
        }
        releaseLoudnessEnhancer();
        boostButton = null;
        boostSeek = null;
        boostPopup = null;
        boostValueTv = null;
        boostPercent = 100;
        subtitleOffsetUs = 0;
        currentUrl = "";
        // NO resetear channelIndex/liveChannels/currentChannelName/EPG aquí.
        // closePlayer() se llama dos veces dentro de openPlayer() (líneas 1645
        // y 1796) y resetear el estado del zap aquí hace que el segundo
        // closePlayer() pise el channelIndex que setChannels/openPlayer acaban
        // de configurar, causando que el zapping empiece desde el canal 0.
        // El estado del zap se gestiona exclusivamente en openPlayer/setChannels/
        // switchChannel. Solo limpiamos las vistas de canal (se recrean luego).
        channelListPanel = null;
        channelListContainer = null;
        episodeListPanel = null;
        episodeListContainer = null;
        octoEpisodesBtn = null;
        seekStreak = 0;
        lastSeekDir = 0;
        swipeGestureDetector = null;
        topBar = null;
        playerTitleView = null;
        playerSubtitleView = null;
        clockView = null;
        controlsOverlay = null;
        rootLayoutRef = null;
        octoSeek = null;
        octoPosition = null;
        octoDuration = null;
        octoLiveBadge = null;
        octoPlayBtn = null;
        octoStopBtn = null;
        octoChannelsBtn = null;
        octoLogo = null;
        currentLogoUrl = null;
        octoInfoRow = null;
        octoNowTv = null;
        octoNextTv = null;
        octoProg = null;
        octoEpgStartTv = null;
        octoEpgEndTv = null;
        octoCastBtn = null;
        octoPipBtn = null;
        // Limpiar listener de Cast
        if (castContext != null && castSessionListener != null) {
            try {
                castContext.getSessionManager().removeSessionManagerListener(castSessionListener, CastSession.class);
            } catch (Exception ignored) {}
        }
        castContext = null;
        castSessionListener = null;
        controlsSeeking = false;
        mainHandler.removeCallbacks(hideControlsRunnable);
        mainHandler.removeCallbacks(controlsTickRunnable);
        volumeSeek = null;
        volumePopup = null;
        speedLabel = null;
        currentSpeed = 1f;
        // Stop position updates and send final position
        if (positionUpdateRunnable != null) {
            mainHandler.removeCallbacks(positionUpdateRunnable);
            // Send final position before releasing — but NOT when this closePlayer
            // is an internal transition inside openPlayer() (suppressClosedEvent):
            // the final position of the OLD episode would reach JS after the new
            // episode's meta is active, marking the NEW episode as watched.
            if (!suppressClosedEvent && player != null) {
                long position = player.getCurrentPosition();
                long duration = player.getDuration();
                if (position > 0) {
                    JSObject event = new JSObject();
                    event.put("state", "position");
                    event.put("position", position);
                    event.put("duration", duration > 0 ? duration : 0);
                    notifyListeners("playbackState", event);
                }
            }
            positionUpdateRunnable = null;
        }
        if (player != null) {
            player.setPlayWhenReady(false);
            player.release();
            player = null;
        }
        lastMediaSource = null;
        bufferingRetries = 0;
        behindLiveRetries = 0;
        sourceErrorRetries = 0;
        lastSourceUsedWarp = false;
        if (playerView != null) {
            playerView.setPlayer(null);
            playerView = null;
        }
        if (dialog != null && dialog.isShowing()) {
            dialog.dismiss();
            dialog = null;
        }
        // Si el mini-player PiP vivía dentro del diálogo, re-anclarlo al
        // decorView para que siga visible sobre la app.
        if (pipPlayer != null) attachPipToBestParent();
        if (!suppressClosedEvent) {
            JSObject event = new JSObject();
            event.put("state", "closed");
            notifyListeners("playbackState", event);
        }
    }

    @Override
    protected void handleOnPause() {
        if (player != null) {
            player.setPlayWhenReady(false);
        }
        if (pipPlayer != null) {
            pipPlayer.setPlayWhenReady(false);
        }
        super.handleOnPause();
    }

    @Override
    protected void handleOnResume() {
        if (player != null && dialog != null && dialog.isShowing()) {
            player.setPlayWhenReady(true);
        }
        if (pipPlayer != null) {
            pipPlayer.setPlayWhenReady(true);
        }
        super.handleOnResume();
    }

    @Override
    protected void handleOnDestroy() {
        cleanupHeadless();
        stopPipInternal();
        closePlayer();
        logoCache.clear();
        super.handleOnDestroy();
    }

}
