import { useEffect, useState } from "react";
import {
  checkDesktopUpdate,
  type DesktopUpdateEvent,
  getDesktopAppVersion,
  installDesktopUpdate,
  isDesktopPanel,
  isNativeShell,
  subscribeDesktopUpdate,
} from "../lib/connection";

interface UpdateControlsProps {
  className?: string;
}

function getUpdateLabel(status: DesktopUpdateEvent | null, appVersion: string | null): string {
  if (!status) return appVersion ? `v${appVersion}` : "UNKNOWN";
  if (status.state === "available") return `v${status.update?.version || status.latestVersion || "NEW"}`;
  if (status.state === "not-available") return "CURRENT";
  if (status.state === "downloading") {
    return typeof status.progress === "number" ? `${status.progress}%` : "DOWNLOADING";
  }
  if (status.state === "downloaded") return "READY";
  if (status.state === "installing") return "INSTALLING";
  if (status.state === "error") return "ERROR";
  return "CHECKING";
}

export function UpdateControls({ className = "" }: UpdateControlsProps) {
  const updateShell = isDesktopPanel() || isNativeShell();
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<DesktopUpdateEvent | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!updateShell) return;

    let cancelled = false;
    void getDesktopAppVersion()
      .then((version) => {
        if (!cancelled) setAppVersion(version);
      })
      .catch(() => {
        if (!cancelled) setAppVersion(null);
      });

    const unsubscribe = subscribeDesktopUpdate((event) => {
      setUpdateStatus(event);
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [updateShell]);

  if (!updateShell) return null;

  const updateAvailable =
    updateStatus?.state === "available" ||
    updateStatus?.state === "downloaded" ||
    updateStatus?.state === "downloading" ||
    updateStatus?.state === "installing";
  const label = getUpdateLabel(updateStatus, appVersion);

  const checkUpdate = async () => {
    setBusy(true);
    try {
      const result = await checkDesktopUpdate(false);
      if (result) setUpdateStatus(result);
    } finally {
      setBusy(false);
    }
  };

  const installUpdate = async () => {
    setBusy(true);
    try {
      const result = await installDesktopUpdate();
      if (result) setUpdateStatus(result);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`border border-hud-line bg-hud-bg/70 p-4 ${className}`}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="hud-label text-hud-primary">App Update</div>
          <div className="hud-value-sm">{label}</div>
        </div>
        {updateStatus?.state === "error" && (
          <div className="hud-value-sm max-w-[220px] text-right text-hud-warning">{updateStatus.message}</div>
        )}
      </div>

      {updateAvailable ? (
        <button
          type="button"
          className="hud-button w-full"
          onClick={() => {
            void installUpdate();
          }}
          disabled={busy || updateStatus?.state === "installing"}
        >
          {busy || updateStatus?.state === "downloading" ? "DOWNLOADING..." : "Install Update"}
        </button>
      ) : (
        <button
          type="button"
          className="hud-button w-full"
          onClick={() => {
            void checkUpdate();
          }}
          disabled={busy || updateStatus?.state === "checking"}
        >
          {busy || updateStatus?.state === "checking" ? "CHECKING..." : "Check Update"}
        </button>
      )}
    </div>
  );
}
