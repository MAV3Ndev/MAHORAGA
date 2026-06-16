# Agent Notes

## Trade Review Logs

トレード分析や改善提案にログが必要な場合は、ユーザーに起動中のエージェントから次のエンドポイントを叩いて JSON を取得してもらうこと:

When you need logs to analyze or improve trading behavior, ask the user to download the trade review log from the running agent:

```text
GET /agent/trade-review?days=90&limit=500&include_snapshots=true
```

The response includes indexed decision rows from D1 and, when requested, detailed R2 snapshots for recent decisions. Use this instead of Durable Object runtime logs for trade analysis.

From the dashboard/desktop UI, use the **Download Logs** action in the remote link controls, choose the export parameters, then download the JSON payload.
