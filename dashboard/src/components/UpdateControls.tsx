import clsx from "clsx";
import type { DesktopUpdateEvent } from "../lib/connection";

interface UpdateControlsProps {
  appVersion: string | null;
  updateStatus: DesktopUpdateEvent | null;
  updateBusy: boolean;
  className?: string;
  compact?: boolean;
  onCheckUpdate: () => void;
  onShowUpdateDetails: () => void;
}

function getUpdateLabel(status: DesktopUpdateEvent | null, appVersion: string | null): string {
  if (!status) return appVersion ? `v${appVersion}` : "UNKNOWN";
  if (status.state === "available") return `v${status.update?.version || status.latestVersion || "NEW"}`;
  if (status.state === "not-available") return `v${status.currentVersion || appVersion || status.latestVersion || "UNKNOWN"}`;
  if (status.state === "downloading") {
    return typeof status.progress === "number" ? `${status.progress}%` : "DOWNLOADING";
  }
  if (status.state === "downloaded") return "READY";
  if (status.state === "installing") return "INSTALLING";
  if (status.state === "error") return "ERROR";
  return "CHECKING";
}

export function UpdateControls({
  appVersion,
  updateStatus,
  updateBusy,
  className = "",
  compact = false,
  onCheckUpdate,
  onShowUpdateDetails,
}: UpdateControlsProps) {
  const updateAvailable =
    updateStatus?.state === "available" ||
    updateStatus?.state === "downloaded" ||
    updateStatus?.state === "downloading" ||
    updateStatus?.state === "installing";
  const label = getUpdateLabel(updateStatus, appVersion);

  return (
    <div
      className={clsx(
        "border border-hud-line bg-hud-bg/70",
        compact ? "flex flex-wrap items-center justify-between gap-3 p-3" : "p-4",
        className
      )}
    >
      <div className={clsx("flex items-center justify-between gap-3", !compact && "mb-3")}>
        <div>
          <div className="hud-label text-hud-primary">App Update</div>
          <div className="hud-value-sm">{label}</div>
        </div>
        {updateStatus?.state === "error" && (
          <div className={clsx("hud-value-sm text-right text-hud-warning", compact ? "max-w-[180px]" : "max-w-[220px]")}>
            {updateStatus.message}
          </div>
        )}
      </div>

      {updateAvailable ? (
        <button
          type="button"
          className={clsx("hud-button", compact ? "h-8 min-h-0 px-3 py-1.5 text-[10px]" : "w-full")}
          onClick={onShowUpdateDetails}
          disabled={updateBusy || updateStatus?.state === "installing"}
        >
          {updateBusy || updateStatus?.state === "downloading" ? "DOWNLOADING..." : "View Update"}
        </button>
      ) : (
        <button
          type="button"
          className={clsx("hud-button", compact ? "h-8 min-h-0 px-3 py-1.5 text-[10px]" : "w-full")}
          onClick={onCheckUpdate}
          disabled={updateBusy || updateStatus?.state === "checking"}
        >
          {updateBusy || updateStatus?.state === "checking" ? "CHECKING..." : "Check Update"}
        </button>
      )}
    </div>
  );
}
