# Sentinel Android

`dashboard` をそのまま Android アプリとして包むために Capacitor を追加しています。

## セットアップ

```bash
cd dashboard
npm install
npx cap add android
```

## 開発フロー

```bash
cd dashboard
npm run build:android
npm run cap:open:android
```

初回起動時は Sentinel アプリ内で以下を入力してください。

- `API URL`: 公開中の `https://<worker>.workers.dev`
- `Bearer Token`: `MAHORAGA_API_TOKEN`

## メモ

- Android 版では `localhost:8787` を既定値にせず、明示的に Worker URL を設定します。
- UI 本体は既存の React/Vite dashboard を再利用します。
- 通知やネイティブ連携を増やす場合は、今後 `@capacitor/local-notifications` などを追加できます。
