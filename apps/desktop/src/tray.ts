// Desktop System Tray Service
// Interacts with Tauri Rust backend system tray

export type TrayState = "active" | "idle" | "approval";

export class DesktopTrayService {
  private currentState: TrayState = "idle";

  public async setState(state: TrayState): Promise<void> {
    this.currentState = state;
    if (typeof window !== "undefined" && (window as any).__TAURI__) {
      try {
        const { invoke } = await import("@tauri-apps/api/tauri");
        await invoke("set_system_tray_state", { state });
      } catch (e) {
        console.warn("Tauri tray invocation fallback:", e);
      }
    }
  }

  public getState(): TrayState {
    return this.currentState;
  }
}

export const trayService = new DesktopTrayService();
