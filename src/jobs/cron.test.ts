import { describe, expect, it } from "vitest";
import { CRON_SCHEDULES, getCronJobName } from "./cron";

describe("cron registry", () => {
  it("maps configured cron schedules to named jobs", () => {
    expect(getCronJobName(CRON_SCHEDULES.eventIngestion)).toBe("event_ingestion");
    expect(getCronJobName(CRON_SCHEDULES.marketOpenPrep)).toBe("market_open_prep");
    expect(getCronJobName(CRON_SCHEDULES.marketCloseCleanup)).toBe("market_close_cleanup");
    expect(getCronJobName(CRON_SCHEDULES.midnightReset)).toBe("midnight_reset");
    expect(getCronJobName(CRON_SCHEDULES.hourlyCacheRefresh)).toBe("hourly_cache_refresh");
  });

  it("returns null for unknown schedules", () => {
    expect(getCronJobName("* * * * *")).toBeNull();
  });
});
