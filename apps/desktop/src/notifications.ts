// Desktop OS Native Notifications Service

export interface NotificationPayload {
  title: string;
  body: string;
  icon?: string;
}

export class DesktopNotificationService {
  private permissionGranted = false;

  public async requestPermission(): Promise<boolean> {
    if (typeof window !== "undefined" && (window as any).__TAURI__) {
      try {
        const { isPermissionGranted, requestPermission } = await import(
          "@tauri-apps/api/notification"
        );
        let permission = await isPermissionGranted();
        if (!permission) {
          const res = await requestPermission();
          permission = res === "granted";
        }
        this.permissionGranted = permission;
        return permission;
      } catch (err) {
        console.warn("Tauri notification error:", err);
      }
    }
    return false;
  }

  public async send(payload: NotificationPayload): Promise<void> {
    if (typeof window !== "undefined" && (window as any).__TAURI__) {
      try {
        const { sendNotification } = await import("@tauri-apps/api/notification");
        sendNotification({
          title: `Trent Fleet: ${payload.title}`,
          body: payload.body,
        });
        return;
      } catch (err) {
        console.warn("Tauri notification dispatch failed:", err);
      }
    }

    // Web Notification fallback if running in browser
    if (typeof window !== "undefined" && "Notification" in window) {
      if (Notification.permission === "granted") {
        new Notification(`Trent Fleet: ${payload.title}`, {
          body: payload.body,
        });
      }
    }
  }
}

export const notificationService = new DesktopNotificationService();
