import { useState, useEffect } from "react";
import { FleetManager, type FleetStatusReport } from "@trent/core";

export function useFleet(fleetManager: FleetManager) {
  const [status, setStatus] = useState<FleetStatusReport>(() => fleetManager.getStatus());

  useEffect(() => {
    const interval = setInterval(() => {
      setStatus(fleetManager.getStatus());
    }, 2000);
    return () => clearInterval(interval);
  }, [fleetManager]);

  return status;
}
