// The Mac's power, for the hosts' indexing policy (key-desktop-host power.rs): on battery,
// the battery level and Low Power Mode. Only the app can tell, so it says
// (`store_power_state`) when a host starts and whenever that changes; the policy is the host's.
import { execFile } from "node:child_process";
import { powerMonitor } from "electron";
import type { HostRequest } from "./rust-bridge";

export interface PowerState {
  onBattery: boolean;
  /** 0–1, when known. */
  level: number | null;
  lowPower: boolean;
}

let state: PowerState = { onBattery: false, level: null, lowPower: false };

const pmset = (args: string[]) =>
  new Promise<string>((resolve) => {
    if (process.platform !== "darwin") return resolve("");
    execFile("/usr/bin/pmset", args, { timeout: 3000 }, (error, stdout) => resolve(error ? "" : String(stdout)));
  });

/** "Now drawing from 'Battery Power' … 42%; discharging" and "lowpowermode 1". */
export function parsePmset(batt: string, settings: string): Pick<PowerState, "level" | "lowPower"> {
  const percent = /(\d{1,3})%/.exec(batt);
  return { level: percent ? Math.min(100, Number(percent[1])) / 100 : null, lowPower: /^\s*lowpowermode\s+1\b/m.test(settings) };
}

async function read(): Promise<PowerState> {
  const [batt, settings] = await Promise.all([pmset(["-g", "batt"]), pmset(["-g"])]);
  return { onBattery: powerMonitor.isOnBatteryPower(), ...parsePmset(batt, settings) };
}

/** For a starting host's prelude. */
export function powerStateRequest(): HostRequest {
  return { command: "store_power_state", args: { ...state } };
}

/** Watches power, telling every running host when it changes. */
export function watchPowerState(broadcast: (command: string, args: Record<string, unknown>) => void) {
  let last = "";
  const check = async () => {
    state = await read().catch(() => state);
    const now = JSON.stringify(state);
    if (now !== last) {
      last = now;
      broadcast("store_power_state", { ...state });
    }
  };
  for (const event of ["on-battery", "on-ac", "resume", "speed-limit-change", "thermal-state-change"] as const) powerMonitor.on(event as "on-battery", () => void check());
  // The battery drains slowly; Low Power Mode has no event.
  setInterval(() => void check(), 60_000).unref();
  void check();
}
