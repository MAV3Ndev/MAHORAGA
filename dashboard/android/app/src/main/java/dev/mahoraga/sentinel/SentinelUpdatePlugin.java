package dev.mahoraga.sentinel;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;

@CapacitorPlugin(name = "SentinelUpdate")
public class SentinelUpdatePlugin extends Plugin {
    private static final String UPDATE_REPOSITORY = "MAV3Ndev/MAHORAGA";
    private static final String RELEASES_URL = "https://api.github.com/repos/" + UPDATE_REPOSITORY + "/releases";

    private JSObject latestUpdate;

    @PluginMethod
    public void getAppVersion(PluginCall call) {
        JSObject result = new JSObject();
        result.put("version", getVersionName());
        call.resolve(result);
    }

    @PluginMethod
    public void checkForUpdates(PluginCall call) {
        new Thread(() -> {
            JSObject result = checkForUpdatesInternal(!call.getBoolean("silent", false));
            call.resolve(result);
        }).start();
    }

    @PluginMethod
    public void installUpdate(PluginCall call) {
        new Thread(() -> {
            if (latestUpdate == null) {
                JSObject checked = checkForUpdatesInternal(false);
                if (!"available".equals(checked.optString("state"))) {
                    call.resolve(checked);
                    return;
                }
            }

            try {
                JSObject update = latestUpdate;
                notifyUpdate("downloading", update, -1, null);

                String assetUrl = update.getString("assetUrl");
                String assetName = sanitizeFileName(update.getString("assetName"));
                File target = new File(getContext().getCacheDir(), assetName);
                downloadFile(assetUrl, target, update);
                notifyUpdate("downloaded", update, 100, null);

                Uri apkUri = FileProvider.getUriForFile(
                    getContext(),
                    getContext().getPackageName() + ".fileprovider",
                    target
                );
                Intent installIntent = new Intent(Intent.ACTION_VIEW);
                installIntent.setDataAndType(apkUri, "application/vnd.android.package-archive");
                installIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                installIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                getContext().startActivity(installIntent);

                notifyUpdate("installing", update, -1, null);
                JSObject result = new JSObject();
                result.put("state", "installing");
                result.put("update", update);
                call.resolve(result);
            } catch (Exception error) {
                JSObject result = errorResult(error);
                call.resolve(result);
            }
        }).start();
    }

    private JSObject checkForUpdatesInternal(boolean emitChecking) {
        String currentVersion = getVersionName();
        if (emitChecking) {
            JSObject checking = new JSObject();
            checking.put("state", "checking");
            checking.put("currentVersion", currentVersion);
            notifyListeners("update", checking);
        }

        try {
            JSONArray releases = new JSONArray(fetchText(RELEASES_URL, "application/vnd.github+json"));
            JSONObject release = selectRelease(releases);
            if (release == null) {
                latestUpdate = null;
                JSObject result = new JSObject();
                result.put("state", "not-available");
                result.put("currentVersion", currentVersion);
                result.put("message", "No Android Sentinel release artifact found.");
                notifyListeners("update", result);
                return result;
            }

            String latestVersion = normalizeReleaseVersion(release.optString("tag_name", ""));
            JSONObject asset = selectAsset(release);
            boolean hasUpdate = compareVersions(latestVersion, currentVersion) > 0;

            JSObject result = new JSObject();
            result.put("currentVersion", currentVersion);
            if (hasUpdate) {
                latestUpdate = new JSObject();
                latestUpdate.put("version", latestVersion);
                latestUpdate.put("releaseName", release.optString("name", release.optString("tag_name", "")));
                latestUpdate.put("releaseUrl", release.optString("html_url", ""));
                latestUpdate.put("notes", release.optString("body", ""));
                latestUpdate.put("assetName", asset.optString("name", "MAHORAGA-SENTINEL.apk"));
                latestUpdate.put("assetUrl", asset.optString("browser_download_url", ""));
                result.put("state", "available");
                result.put("update", latestUpdate);
            } else {
                latestUpdate = null;
                result.put("state", "not-available");
                result.put("latestVersion", latestVersion);
            }

            notifyListeners("update", result);
            return result;
        } catch (Exception error) {
            return errorResult(error);
        }
    }

    private JSONObject selectRelease(JSONArray releases) {
        for (int index = 0; index < releases.length(); index += 1) {
            JSONObject release = releases.optJSONObject(index);
            if (release == null) continue;
            if (release.optBoolean("draft", false) || release.optBoolean("prerelease", false)) continue;
            if (!release.optString("tag_name", "").toLowerCase().startsWith("sentinel-v")) continue;
            if (selectAsset(release) != null) return release;
        }
        return null;
    }

    private JSONObject selectAsset(JSONObject release) {
        JSONArray assets = release.optJSONArray("assets");
        if (assets == null) return null;

        for (int index = 0; index < assets.length(); index += 1) {
            JSONObject asset = assets.optJSONObject(index);
            if (asset == null) continue;
            String name = asset.optString("name", "").toLowerCase();
            if (name.contains("sentinel") && name.endsWith(".apk")) return asset;
        }

        for (int index = 0; index < assets.length(); index += 1) {
            JSONObject asset = assets.optJSONObject(index);
            if (asset == null) continue;
            if (asset.optString("name", "").toLowerCase().endsWith(".apk")) return asset;
        }

        return null;
    }

    private void downloadFile(String rawUrl, File target, JSObject update) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(rawUrl).openConnection();
        connection.setRequestProperty("Accept", "application/octet-stream");
        connection.setRequestProperty("User-Agent", "MAHORAGA-SENTINEL/" + getVersionName());
        connection.connect();

        int status = connection.getResponseCode();
        if (status < 200 || status >= 300) {
            throw new IllegalStateException("Update download failed: HTTP " + status);
        }

        int totalBytes = connection.getContentLength();
        int downloadedBytes = 0;
        byte[] buffer = new byte[8192];
        try (
            BufferedInputStream input = new BufferedInputStream(connection.getInputStream());
            FileOutputStream output = new FileOutputStream(target)
        ) {
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
                downloadedBytes += read;
                if (totalBytes > 0) {
                    int progress = Math.min(100, Math.round((downloadedBytes * 100f) / totalBytes));
                    notifyUpdate("downloading", update, progress, null);
                }
            }
        } finally {
            connection.disconnect();
        }
    }

    private String fetchText(String rawUrl, String accept) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(rawUrl).openConnection();
        connection.setRequestProperty("Accept", accept);
        connection.setRequestProperty("User-Agent", "MAHORAGA-SENTINEL/" + getVersionName());
        connection.connect();

        int status = connection.getResponseCode();
        if (status < 200 || status >= 300) {
            throw new IllegalStateException("GitHub release check failed: HTTP " + status);
        }

        ByteArrayOutputStream result = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        try (BufferedInputStream input = new BufferedInputStream(connection.getInputStream())) {
            int read;
            while ((read = input.read(buffer)) != -1) {
                result.write(buffer, 0, read);
            }
        } finally {
            connection.disconnect();
        }
        return result.toString(StandardCharsets.UTF_8.name());
    }

    private String getVersionName() {
        try {
            PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            return info.versionName == null ? "0.0.0" : info.versionName;
        } catch (Exception ignored) {
            return "0.0.0";
        }
    }

    private int compareVersions(String left, String right) {
        String[] leftParts = left.replaceFirst("^[vV]", "").split("[.-]");
        String[] rightParts = right.replaceFirst("^[vV]", "").split("[.-]");
        int length = Math.max(leftParts.length, rightParts.length);
        for (int index = 0; index < length; index += 1) {
            int delta = parseVersionPart(leftParts, index) - parseVersionPart(rightParts, index);
            if (delta != 0) return delta > 0 ? 1 : -1;
        }
        return 0;
    }

    private int parseVersionPart(String[] parts, int index) {
        if (index >= parts.length) return 0;
        try {
            return Integer.parseInt(parts[index].replaceAll("[^0-9].*$", ""));
        } catch (Exception ignored) {
            return 0;
        }
    }

    private String normalizeReleaseVersion(String tag) {
        return tag.replaceFirst("(?i)^sentinel-v", "").replaceFirst("(?i)^v", "");
    }

    private String sanitizeFileName(String name) {
        String sanitized = name == null || name.trim().isEmpty() ? "MAHORAGA-SENTINEL.apk" : name;
        return sanitized.replaceAll("[^A-Za-z0-9._-]", "_");
    }

    private void notifyUpdate(String state, JSObject update, int progress, String message) {
        JSObject payload = new JSObject();
        payload.put("state", state);
        payload.put("currentVersion", getVersionName());
        if (update != null) payload.put("update", update);
        if (progress >= 0) payload.put("progress", progress);
        if (message != null) payload.put("message", message);
        notifyListeners("update", payload);
    }

    private JSObject errorResult(Exception error) {
        JSObject result = new JSObject();
        result.put("state", "error");
        result.put("currentVersion", getVersionName());
        result.put("message", error.getMessage() == null ? error.toString() : error.getMessage());
        notifyListeners("update", result);
        return result;
    }
}
