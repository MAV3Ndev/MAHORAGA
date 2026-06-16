# Sentinel Android

Sentinel Android は React/Vite dashboard を Capacitor WebView で包んだネイティブ shell です。Worker への接続、設定編集、データソース接続テストは Windows Sentinel と同じ UI を使います。

## 初回利用

- `API URL`: 公開中の `https://<worker>.workers.dev`
- `Bearer Token`: `MAHORAGA_API_TOKEN`

Android 版では `localhost:8787` を既定値にせず、必ず Worker URL を入力します。

## バージョンとアップデート

Android 版には `SentinelUpdatePlugin` が入っています。

- Android の `versionName` は `dashboard/android/app/build.gradle` で管理します。
- アプリ内の Remote Link panel に現在 version、更新確認、インストール操作が表示されます。
- 更新確認は GitHub Releases の `sentinel-v*` release を見に行き、`.apk` asset が現在 version より新しい場合に表示します。
- インストール時は APK を cache に download し、Android の package installer に渡します。

Android は同じ signing key で署名された APK でないと上書き更新できません。Release workflow で APK を配布する場合は、GitHub Secrets に以下を設定してください。

| Secret | Description |
| --- | --- |
| `SENTINEL_ANDROID_KEYSTORE_BASE64` | release keystore を base64 encode した値 |
| `SENTINEL_ANDROID_KEYSTORE_PASSWORD` | keystore password |
| `SENTINEL_ANDROID_KEY_ALIAS` | key alias |
| `SENTINEL_ANDROID_KEY_PASSWORD` | key password |

Secrets が未設定の場合、Windows artifact の release は継続しますが Android APK は添付されません。

## ローカルビルド

Capacitor dependency は dashboard package に常時固定していないため、Android を触るときだけ入れてください。

```bash
cd dashboard
npm install --no-save @capacitor/core @capacitor/cli @capacitor/android
npm run android:sync
cd android
./gradlew assembleDebug
```

Windows では最後の行を `gradlew.bat assembleDebug` に置き換えてください。

CI installs the same dependencies as `@capacitor/*@^7` before running `npx cap sync android`.

署名付き release APK を作る場合:

```bash
cd dashboard/android
SENTINEL_ANDROID_KEYSTORE_PATH=/path/to/sentinel-release.jks \
SENTINEL_ANDROID_KEYSTORE_PASSWORD=... \
SENTINEL_ANDROID_KEY_ALIAS=... \
SENTINEL_ANDROID_KEY_PASSWORD=... \
./gradlew assembleRelease
```

Windows では `gradlew.bat assembleRelease` を使います。

## メモ

- UI 本体は既存の React/Vite dashboard を再利用します。
- Native bridge は `window.Capacitor.Plugins.SentinelUpdate` から利用します。
- Android 8+ ではユーザーがこのアプリからの APK インストールを許可する必要があります。
