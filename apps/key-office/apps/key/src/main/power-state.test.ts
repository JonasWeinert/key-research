import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ powerMonitor: { isOnBatteryPower: () => false, on: () => undefined } }));
const { parsePmset } = await import("./power-state");

describe("parsePmset", () => {
  it("reads the battery level and Low Power Mode", () => {
    const batt = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1234)\t42%; discharging; 3:10 remaining present: true";
    expect(parsePmset(batt, "System-wide power settings:\nCurrently in use:\n lowpowermode         1\n sleep 1")).toEqual({ level: 0.42, lowPower: true });
    expect(parsePmset("Now drawing from 'AC Power'", " lowpowermode         0")).toEqual({ level: null, lowPower: false });
  });
});
