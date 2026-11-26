// The hosts' feed pollers rest while the Mac is offline or saving power; only the app can
// tell, so it says (`feeds_environment`) when a host starts and whenever that changes.
// "Saving power" is running on battery while the system throttles the CPU or runs hot.
import { net, powerMonitor } from "electron";
import type { HostRequest } from "./rust-bridge";

let online = true;
let battery = false;
let throttled = false;

const state = () => ({ online, lowPower: battery && throttled });

/** For a starting host's prelude. */
export function feedsEnvironmentRequest(): HostRequest {
  return { command: "feeds_environment", args: state() };
}

/** Watches the network and power, telling every running host when either changes. */
export function watchFeedsEnvironment(broadcast: (command: string, args: Record<string, unknown>) => void) {
  let last = JSON.stringify(state());
  const check = () => {
    online = net.isOnline();
    battery = powerMonitor.isOnBatteryPower();
    const now = JSON.stringify(state());
    if (now !== last) {
      last = now;
      broadcast("feeds_environment", state());
    }
  };
  powerMonitor.on("on-battery", check);
  powerMonitor.on("on-ac", check);
  powerMonitor.on("resume", check);
  powerMonitor.on("thermal-state-change", (details: { state?: string }) => {
    throttled = details?.state === "serious" || details?.state === "critical";
    check();
  });
  powerMonitor.on("speed-limit-change", (details: { limit?: number }) => {
    throttled = typeof details?.limit === "number" && details.limit < 100;
    check();
  });
  setInterval(check, 60_000).unref();
  check();
}
