package com.octostream.youtube;

import org.schabi.newpipe.extractor.downloader.Downloader;
import org.schabi.newpipe.extractor.downloader.Request;
import org.schabi.newpipe.extractor.downloader.Response;
import org.schabi.newpipe.extractor.exceptions.ReCaptchaException;

import java.io.IOException;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import okhttp3.Interceptor;
import okhttp3.OkHttpClient;
import okhttp3.RequestBody;
import okhttp3.MediaType;

/**
 * OkHttp-based Downloader for NewPipeExtractor.
 * Adds the CONSENT cookie required by YouTube in EU countries to prevent
 * redirects to consent.youtube.com which break the parser.
 */
public class YoutubeDownloader extends Downloader {

    private final OkHttpClient client;

    public YoutubeDownloader() {
        // Interceptor that adds CONSENT cookie header for youtube.com requests
        Interceptor consentInterceptor = new Interceptor() {
            @Override
            public okhttp3.Response intercept(Chain chain) throws IOException {
                okhttp3.Request original = chain.request();
                String host = original.url().host();

                okhttp3.Request.Builder reqBuilder = original.newBuilder();
                // Add CONSENT cookie for youtube.com and googlevideo.com domains
                if (host.contains("youtube.com") || host.contains("googlevideo.com") || host.contains("google.com")) {
                    String existingCookie = original.header("Cookie");
                    String consentCookie = "CONSENT=PENDING+987; SOCS=CAISNQgDEitibmFuaW5nIHJlZ2lvbjItMjAxOTEyMzEtMC13ZWJsaW5rZWQtY29udHJvbGxlcnMCAQ";
                    if (existingCookie != null && !existingCookie.isEmpty()) {
                        // Append to existing cookies
                        reqBuilder.header("Cookie", existingCookie + "; " + consentCookie);
                    } else {
                        reqBuilder.header("Cookie", consentCookie);
                    }
                }

                return chain.proceed(reqBuilder.build());
            }
        };

        this.client = new OkHttpClient.Builder()
                .followRedirects(true)
                .followSslRedirects(true)
                .addInterceptor(consentInterceptor)
                .build();
    }

    @Override
    public Response execute(Request request) throws IOException, ReCaptchaException {
        String httpMethod = request.httpMethod();
        String url = request.url();
        Map<String, List<String>> headers = request.headers();
        byte[] data = request.dataToSend();

        try {
            okhttp3.Request.Builder reqBuilder = new okhttp3.Request.Builder()
                    .url(url);

            // Add headers
            if (headers != null) {
                for (Map.Entry<String, List<String>> entry : headers.entrySet()) {
                    if (entry.getValue() != null && !entry.getValue().isEmpty()) {
                        reqBuilder.header(entry.getKey(), entry.getValue().get(0));
                    }
                }
            }

            // Set method and body
            if ("POST".equalsIgnoreCase(httpMethod)) {
                MediaType mediaType = MediaType.parse("application/json");
                RequestBody body = data != null
                        ? RequestBody.create(data, mediaType)
                        : RequestBody.create(new byte[0], mediaType);
                reqBuilder.post(body);
            } else if ("GET".equalsIgnoreCase(httpMethod)) {
                reqBuilder.get();
            } else {
                reqBuilder.method(httpMethod, null);
            }

            okhttp3.Response response = client.newCall(reqBuilder.build()).execute();

            int statusCode = response.code();
            String responseBody = response.body() != null ? response.body().string() : "";

            // Check for captcha
            if (statusCode == 429) {
                throw new ReCaptchaException("reCaptcha challenge requested", url);
            }

            // Convert OkHttp headers to Map
            Map<String, List<String>> responseHeaders = new HashMap<>();
            for (String key : response.headers().names()) {
                responseHeaders.put(key, response.headers().values(key));
            }

            return new Response(statusCode, response.message(), responseHeaders, responseBody, url);

        } catch (ReCaptchaException e) {
            throw e;
        } catch (Exception e) {
            throw new IOException("Failed to execute request: " + e.getMessage(), e);
        }
    }
}
