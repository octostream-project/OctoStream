package com.octostream.youtube;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.schabi.newpipe.extractor.NewPipe;
import org.schabi.newpipe.extractor.ServiceList;
import org.schabi.newpipe.extractor.StreamingService;
import org.schabi.newpipe.extractor.channel.ChannelExtractor;
import org.schabi.newpipe.extractor.channel.ChannelInfo;
import org.schabi.newpipe.extractor.channel.tabs.ChannelTabExtractor;
import org.schabi.newpipe.extractor.linkhandler.ListLinkHandler;
import org.schabi.newpipe.extractor.search.SearchExtractor;
import org.schabi.newpipe.extractor.services.youtube.YoutubeParsingHelper;
import org.schabi.newpipe.extractor.suggestion.SuggestionExtractor;
import org.schabi.newpipe.extractor.stream.StreamExtractor;
import org.schabi.newpipe.extractor.stream.StreamInfoItem;
import org.schabi.newpipe.extractor.stream.StreamType;
import org.schabi.newpipe.extractor.stream.VideoStream;
import org.schabi.newpipe.extractor.InfoItem;
import org.schabi.newpipe.extractor.ListExtractor;

import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

@CapacitorPlugin(name = "Youtube")
public class YoutubePlugin extends Plugin {

    private static final String TAG = "YoutubePlugin";
    private static final AtomicReference<YoutubeDownloader> downloader = new AtomicReference<>();

    private static synchronized YoutubeDownloader getDownloader() {
        if (downloader.get() == null) {
            downloader.set(new YoutubeDownloader());
            try {
                NewPipe.init(downloader.get());
                // Accept YouTube consent to get mixes and all results in EU countries
                YoutubeParsingHelper.setConsentAccepted(true);
            } catch (Exception e) {
                android.util.Log.w(TAG, "NewPipe init failed (may already be initialized)", e);
            }
        }
        return downloader.get();
    }

    @PluginMethod
    public void resolve(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("url is required");
            return;
        }

        // Run on background thread to avoid blocking UI
        new Thread(() -> {
            try {
                // Ensure NewPipe is initialized with our OkHttp downloader
                getDownloader();

                // Get YouTube service
                StreamingService youtube = ServiceList.YouTube;

                // Create StreamExtractor from URL
                StreamExtractor extractor = youtube.getStreamExtractor(url);
                extractor.fetchPage();

                // Get video title
                String title = extractor.getName();

                // Get video streams (progressive = muxed audio+video, ready to play)
                List<VideoStream> videoStreams = extractor.getVideoStreams();
                List<VideoStream> progressiveStreams = extractor.getVideoOnlyStreams();

                JSObject result = new JSObject();
                result.put("title", title != null ? title : "");

                org.json.JSONArray streamsArray = new org.json.JSONArray();

                // Add progressive (muxed) streams first - these can play directly
                if (videoStreams != null) {
                    for (VideoStream vs : videoStreams) {
                        JSObject streamObj = new JSObject();
                        streamObj.put("url", vs.getContent());
                        streamObj.put("mimeType", vs.getFormat() != null ? vs.getFormat().getMimeType() : "video/mp4");
                        streamObj.put("quality", vs.getResolution() != null ? vs.getResolution() : "");
                        streamObj.put("format", vs.isUrl() ? "mp4" : "mp4");
                        streamsArray.put(streamObj);
                    }
                }

                // Add video-only streams as fallback (higher quality but no audio)
                if (progressiveStreams != null) {
                    for (VideoStream vs : progressiveStreams) {
                        JSObject streamObj = new JSObject();
                        streamObj.put("url", vs.getContent());
                        streamObj.put("mimeType", vs.getFormat() != null ? vs.getFormat().getMimeType() : "video/webm");
                        streamObj.put("quality", vs.getResolution() != null ? vs.getResolution() : "");
                        streamObj.put("format", vs.isUrl() ? "mp4" : "mp4");
                        streamsArray.put(streamObj);
                    }
                }

                result.put("streams", streamsArray);

                // DASH MPD (VOD): todas las calidades + pistas de audio en un
                // manifest adaptativo → selector de calidad real en ExoPlayer.
                try {
                    String dash = extractor.getDashMpdUrl();
                    if (dash != null && !dash.isEmpty()) result.put("dashUrl", dash);
                } catch (Exception ignored) {}

                // HLS (directos en YouTube).
                try {
                    String hls = extractor.getHlsUrl();
                    if (hls != null && !hls.isEmpty()) result.put("hlsUrl", hls);
                } catch (Exception ignored) {}

                // Subtítulos del propio YouTube (TTML/VTT, manuales y
                // autogenerados). Se cargan side-loaded en ExoPlayer y salen
                // en el menú "Subtítulos" del player.
                org.json.JSONArray subsArray = new org.json.JSONArray();
                try {
                    // TTML es el formato nativo de YouTube y ExoPlayer lo
                    // soporta; getSubtitlesDefault() da el formato por defecto
                    // del servicio si TTML no existe.
                    List<org.schabi.newpipe.extractor.stream.SubtitlesStream> subs =
                            extractor.getSubtitles(org.schabi.newpipe.extractor.MediaFormat.TTML);
                    if (subs == null || subs.isEmpty()) subs = extractor.getSubtitlesDefault();
                    if (subs != null) {
                        for (org.schabi.newpipe.extractor.stream.SubtitlesStream s : subs) {
                            if (s == null || s.getContent() == null || s.getContent().isEmpty()) continue;
                            JSObject subObj = new JSObject();
                            subObj.put("url", s.getContent());
                            String tag = s.getLanguageTag();
                            subObj.put("language", tag != null ? tag : "");
                            String name = "";
                            try { name = s.getDisplayLanguageName(); } catch (Throwable ignored) {}
                            subObj.put("name", name != null ? name : "");
                            subObj.put("autoGenerated", s.isAutoGenerated());
                            String mime = "application/ttml+xml";
                            try {
                                if (s.getFormat() != null && s.getFormat().getMimeType() != null) {
                                    mime = s.getFormat().getMimeType();
                                }
                            } catch (Throwable ignored) {}
                            subObj.put("mimeType", mime);
                            subsArray.put(subObj);
                        }
                    }
                } catch (Exception ignored) {}
                result.put("subtitles", subsArray);

                android.util.Log.i(TAG, "Resolved " + url + " → " + streamsArray.length() + " streams, "
                        + subsArray.length() + " subs, dash=" + result.has("dashUrl") + ", title=" + title);
                call.resolve(result);

            } catch (Exception e) {
                android.util.Log.e(TAG, "Failed to resolve YouTube URL: " + url, e);
                call.reject("Failed to resolve: " + e.getMessage(), e);
            }
        }).start();
    }

    // Devuelve la URL de la imagen más cercana a la altura objetivo.
    private static String imageUrlNear(java.util.List<org.schabi.newpipe.extractor.Image> images, int targetHeight) {
        if (images == null || images.isEmpty()) return "";
        org.schabi.newpipe.extractor.Image best = null;
        int bestDiff = Integer.MAX_VALUE;
        for (org.schabi.newpipe.extractor.Image img : images) {
            if (img == null || img.getUrl() == null) continue;
            int d = Math.abs(img.getHeight() - targetHeight);
            if (d < bestDiff) { bestDiff = d; best = img; }
        }
        return best != null ? best.getUrl() : "";
    }

    // Devuelve la URL de la imagen de mayor resolución de la lista.
    private static String bestImageUrl(java.util.List<org.schabi.newpipe.extractor.Image> images) {
        if (images == null || images.isEmpty()) return "";
        org.schabi.newpipe.extractor.Image best = images.get(0);
        for (org.schabi.newpipe.extractor.Image img : images) {
            if (img != null && img.getHeight() > best.getHeight()) best = img;
        }
        return best.getUrl() != null ? best.getUrl() : "";
    }

    // ---------- Pagination helpers ----------

    private static JSObject pageToJson(org.schabi.newpipe.extractor.Page page) {
        if (page == null) return null;
        try {
            JSObject obj = new JSObject();
            if (page.getUrl() != null) obj.put("url", page.getUrl());
            if (page.getId() != null) obj.put("id", page.getId());
            if (page.getIds() != null) {
                org.json.JSONArray ids = new org.json.JSONArray();
                for (String s : page.getIds()) ids.put(s);
                obj.put("ids", ids);
            }
            if (page.getCookies() != null) {
                JSObject cookies = new JSObject();
                for (java.util.Map.Entry<String, String> e : page.getCookies().entrySet()) {
                    cookies.put(e.getKey(), e.getValue());
                }
                obj.put("cookies", cookies);
            }
            if (page.getBody() != null) {
                obj.put("body", android.util.Base64.encodeToString(page.getBody(), android.util.Base64.NO_WRAP));
            }
            return obj;
        } catch (Exception e) {
            return null;
        }
    }

    private static org.schabi.newpipe.extractor.Page pageFromJson(org.json.JSONObject data) {
        if (data == null) return null;
        try {
            String url = data.isNull("url") ? null : data.optString("url", null);
            String id = data.isNull("id") ? null : data.optString("id", null);
            List<String> ids = null;
            org.json.JSONArray idsArr = data.optJSONArray("ids");
            if (idsArr != null) {
                ids = new java.util.ArrayList<>();
                for (int i = 0; i < idsArr.length(); i++) ids.add(idsArr.optString(i));
            }
            java.util.Map<String, String> cookies = null;
            org.json.JSONObject cookiesObj = data.optJSONObject("cookies");
            if (cookiesObj != null) {
                cookies = new java.util.HashMap<>();
                java.util.Iterator<String> it = cookiesObj.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    cookies.put(k, cookiesObj.optString(k));
                }
            }
            byte[] body = null;
            String bodyB64 = data.isNull("body") ? null : data.optString("body", null);
            if (bodyB64 != null && !bodyB64.isEmpty()) {
                body = android.util.Base64.decode(bodyB64, android.util.Base64.DEFAULT);
            }
            return new org.schabi.newpipe.extractor.Page(url, id, ids, cookies, body);
        } catch (Exception e) {
            return null;
        }
    }

    // Serialize an InfoItemsPage into a plugin result (items + pagination).
    private static JSObject pageResult(ListExtractor.InfoItemsPage<InfoItem> page) {
        JSObject result = new JSObject();
        org.json.JSONArray itemsArray = new org.json.JSONArray();
        if (page != null && page.getItems() != null) {
            for (InfoItem item : page.getItems()) {
                if (item instanceof StreamInfoItem) {
                    StreamInfoItem stream = (StreamInfoItem) item;
                    JSObject itemObj = new JSObject();
                    itemObj.put("name", stream.getName() != null ? stream.getName() : "");
                    itemObj.put("url", stream.getUrl() != null ? stream.getUrl() : "");
                    itemObj.put("uploader", stream.getUploaderName() != null ? stream.getUploaderName() : "");
                    itemObj.put("duration", stream.getDuration()); // seconds, -1 if unknown/live
                    itemObj.put("views", stream.getViewCount());
                    String thumbUrl = "";
                    try {
                        thumbUrl = imageUrlNear(stream.getThumbnails(), 360);
                    } catch (Exception ignored) {}
                    itemObj.put("thumbnailUrl", thumbUrl);
                    itemObj.put("isLive", stream.getStreamType() == StreamType.LIVE_STREAM);
                    itemsArray.put(itemObj);
                }
            }
        }
        result.put("items", itemsArray);
        boolean hasNext = page != null && page.hasNextPage() && page.getNextPage() != null;
        result.put("hasNextPage", hasNext);
        if (hasNext) {
            JSObject np = pageToJson(page.getNextPage());
            if (np != null) result.put("nextPage", np);
        }
        return result;
    }

    @PluginMethod
    public void search(PluginCall call) {
        String query = call.getString("query");
        if (query == null || query.isEmpty()) {
            call.reject("query is required");
            return;
        }

        new Thread(() -> {
            try {
                getDownloader();

                StreamingService youtube = ServiceList.YouTube;
                // Use search with video filter to only get video results
                SearchExtractor extractor = youtube.getSearchExtractor(query);
                extractor.fetchPage();

                ListExtractor.InfoItemsPage<InfoItem> page = extractor.getInitialPage();
                JSObject result = pageResult(page);

                android.util.Log.i(TAG, "Search \"" + query + "\" → items=" + ((org.json.JSONArray) result.get("items")).length() + " hasNext=" + result.optBoolean("hasNextPage"));
                call.resolve(result);

            } catch (Exception e) {
                android.util.Log.e(TAG, "Search failed: " + query, e);
                call.reject("Search failed: " + e.getMessage(), e);
            }
        }).start();
    }

    @PluginMethod
    public void searchMore(PluginCall call) {
        String query = call.getString("query");
        JSObject nextPageData = call.getObject("nextPage");
        if (query == null || query.isEmpty() || nextPageData == null) {
            call.reject("query and nextPage are required");
            return;
        }

        new Thread(() -> {
            try {
                getDownloader();

                StreamingService youtube = ServiceList.YouTube;
                SearchExtractor extractor = youtube.getSearchExtractor(query);
                org.schabi.newpipe.extractor.Page nextPage = pageFromJson(nextPageData);
                if (nextPage == null) {
                    call.reject("invalid nextPage");
                    return;
                }
                // getPage builds the continuation request entirely from the Page;
                // no fetchPage() needed on the fresh extractor.
                ListExtractor.InfoItemsPage<InfoItem> page = extractor.getPage(nextPage);
                JSObject result = pageResult(page);

                android.util.Log.i(TAG, "SearchMore \"" + query + "\" → items=" + ((org.json.JSONArray) result.get("items")).length() + " hasNext=" + result.optBoolean("hasNextPage"));
                call.resolve(result);

            } catch (Exception e) {
                android.util.Log.e(TAG, "SearchMore failed: " + query, e);
                call.reject("SearchMore failed: " + e.getMessage(), e);
            }
        }).start();
    }

    @PluginMethod
    public void suggest(PluginCall call) {
        String query = call.getString("query");
        if (query == null || query.isEmpty()) {
            call.reject("query is required");
            return;
        }

        new Thread(() -> {
            try {
                getDownloader();

                StreamingService youtube = ServiceList.YouTube;
                SuggestionExtractor suggestionExtractor = youtube.getSuggestionExtractor();
                List<String> suggestions = suggestionExtractor.suggestionList(query);

                JSObject result = new JSObject();
                org.json.JSONArray suggestionsArray = new org.json.JSONArray();
                if (suggestions != null) {
                    for (String s : suggestions) {
                        suggestionsArray.put(s);
                    }
                }
                result.put("suggestions", suggestionsArray);
                android.util.Log.i(TAG, "Suggest \"" + query + "\" → " + suggestionsArray.length() + " suggestions");
                call.resolve(result);

            } catch (Exception e) {
                android.util.Log.e(TAG, "Suggest failed: " + query, e);
                call.reject("Suggest failed: " + e.getMessage(), e);
            }
        }).start();
    }

    @PluginMethod
    public void getChannelInfo(PluginCall call) {
        String channelId = call.getString("channelId");
        String channelUrl = call.getString("url");
        if ((channelId == null || channelId.isEmpty()) && (channelUrl == null || channelUrl.isEmpty())) {
            call.reject("channelId or url is required");
            return;
        }

        new Thread(() -> {
            try {
                getDownloader();

                StreamingService youtube = ServiceList.YouTube;
                String url;
                if (channelUrl != null && !channelUrl.isEmpty()) {
                    url = channelUrl;
                } else {
                    if (channelId.startsWith("@")) {
                        url = "https://www.youtube.com/" + channelId;
                    } else if (channelId.startsWith("UC")) {
                        url = "https://www.youtube.com/channel/" + channelId;
                    } else {
                        url = "https://www.youtube.com/c/" + channelId;
                    }
                }

                android.util.Log.i(TAG, "getChannelInfo: " + url);
                ChannelExtractor extractor = youtube.getChannelExtractor(url);
                extractor.fetchPage();

                JSObject result = new JSObject();
                result.put("name", extractor.getName() != null ? extractor.getName() : "");
                result.put("url", url);
                result.put("subscriberCount", extractor.getSubscriberCount());

                String avatarUrl = "";
                try {
                    avatarUrl = bestImageUrl(extractor.getAvatars());
                } catch (Exception ignored) {}
                result.put("avatarUrl", avatarUrl);

                call.resolve(result);
            } catch (Exception e) {
                android.util.Log.e(TAG, "getChannelInfo failed: " + (channelUrl != null ? channelUrl : channelId), e);
                call.reject("getChannelInfo failed: " + e.getMessage(), e);
            }
        }).start();
    }

    @PluginMethod
    public void getChannel(PluginCall call) {
        String channelId = call.getString("channelId");
        String channelUrl = call.getString("url");
        if ((channelId == null || channelId.isEmpty()) && (channelUrl == null || channelUrl.isEmpty())) {
            call.reject("channelId or url is required");
            return;
        }

        new Thread(() -> {
            try {
                getDownloader();

                StreamingService youtube = ServiceList.YouTube;
                String url;
                if (channelUrl != null && !channelUrl.isEmpty()) {
                    url = channelUrl;
                } else {
                    // Build channel URL from ID (@handle, UCxxxx, or custom)
                    if (channelId.startsWith("@")) {
                        url = "https://www.youtube.com/" + channelId;
                    } else if (channelId.startsWith("UC")) {
                        url = "https://www.youtube.com/channel/" + channelId;
                    } else {
                        url = "https://www.youtube.com/c/" + channelId;
                    }
                }

                android.util.Log.i(TAG, "getChannel: " + url);
                ChannelExtractor extractor = youtube.getChannelExtractor(url);
                extractor.fetchPage();

                JSObject result = new JSObject();
                result.put("name", extractor.getName() != null ? extractor.getName() : "");
                result.put("url", url);
                result.put("description", extractor.getDescription() != null ? extractor.getDescription() : "");
                result.put("subscriberCount", extractor.getSubscriberCount());

                // Avatar — con fallback al avatar del uploader del primer
                // vídeo (NewPipe a veces devuelve getAvatars() vacío)
                String avatarUrl = "";
                try {
                    avatarUrl = bestImageUrl(extractor.getAvatars());
                } catch (Exception ignored) {}

                // Banner
                String bannerUrl = "";
                try {
                    bannerUrl = bestImageUrl(extractor.getBanners());
                } catch (Exception ignored) {}
                result.put("bannerUrl", bannerUrl);

                // Videos from the channel's first tab (usually "Videos" tab)
                String firstUploaderAvatar = "";
                org.json.JSONArray itemsArray = new org.json.JSONArray();
                try {
                    java.util.List<ListLinkHandler> tabs = extractor.getTabs();
                    if (tabs != null && !tabs.isEmpty()) {
                        // Find the "videos" tab (default content filter), fallback to first tab
                        ListLinkHandler videosTab = null;
                        for (ListLinkHandler tab : tabs) {
                            if (tab.getContentFilters() != null && !tab.getContentFilters().isEmpty()) {
                                String filter = tab.getContentFilters().get(0);
                                if ("videos".equals(filter)) {
                                    videosTab = tab;
                                    break;
                                }
                            }
                        }
                        if (videosTab == null) videosTab = tabs.get(0);

                        ChannelTabExtractor tabExtractor = youtube.getChannelTabExtractor(videosTab);
                        tabExtractor.fetchPage();
                        ListExtractor.InfoItemsPage<InfoItem> page = tabExtractor.getInitialPage();
                        if (page != null && page.getItems() != null) {
                            for (InfoItem item : page.getItems()) {
                                if (item instanceof StreamInfoItem) {
                                    StreamInfoItem stream = (StreamInfoItem) item;
                                    if (firstUploaderAvatar.isEmpty()) {
                                        try { firstUploaderAvatar = bestImageUrl(stream.getUploaderAvatars()); } catch (Exception ignored) {}
                                    }
                                    JSObject itemObj = new JSObject();
                                    itemObj.put("name", stream.getName() != null ? stream.getName() : "");
                                    itemObj.put("url", stream.getUrl() != null ? stream.getUrl() : "");
                                    itemObj.put("uploader", stream.getUploaderName() != null ? stream.getUploaderName() : "");
                                    itemObj.put("duration", stream.getDuration());
                                    itemObj.put("views", stream.getViewCount());
                                    String thumbUrl = "";
                                    try {
                                        thumbUrl = imageUrlNear(stream.getThumbnails(), 360);
                                    } catch (Exception ignored) {}
                                    itemObj.put("thumbnailUrl", thumbUrl);
                                    itemObj.put("isLive", stream.getStreamType() == StreamType.LIVE_STREAM);
                                    itemsArray.put(itemObj);
                                }
                            }
                        }
                    }
                } catch (Exception tabErr) {
                    android.util.Log.w(TAG, "getChannel: failed to load tabs: " + tabErr.getMessage());
                }
                // Último fallback de avatar: el del uploader del primer vídeo
                if (avatarUrl.isEmpty() && !firstUploaderAvatar.isEmpty()) {
                    avatarUrl = firstUploaderAvatar;
                }
                result.put("avatarUrl", avatarUrl);
                result.put("items", itemsArray);
                android.util.Log.i(TAG, "getChannel: " + extractor.getName() + " → " + itemsArray.length() + " videos");
                call.resolve(result);

            } catch (Exception e) {
                android.util.Log.e(TAG, "getChannel failed: " + (channelUrl != null ? channelUrl : channelId), e);
                call.reject("getChannel failed: " + e.getMessage(), e);
            }
        }).start();
    }
}
