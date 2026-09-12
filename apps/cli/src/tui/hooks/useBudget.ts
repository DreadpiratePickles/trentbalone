import { useState } from "react";
import { ConfigManager } from "@trent/core";

export function useBudget(configManager: ConfigManager) {
  const [dailySpent] = useState(0.12);
  const config = configManager.loadConfig();
  const dailyCap = config.budget?.daily_cap || 10.0;

  return {
    dailySpent,
    dailyCap,
    percentage: Math.min(100, Math.round((dailySpent / dailyCap) * 100)),
  };
}
