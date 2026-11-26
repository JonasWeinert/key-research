// Milliseconds since process start at each startup step, for the benchmark and perf budget
// (scripts/bench-electron.cjs reads `globalThis.__keyStartup`). Imported first by index.ts.
const marks: Record<string, number> = {};
(globalThis as { __keyStartup?: Record<string, number> }).__keyStartup = marks;
export function startupMark(name: string) {
  marks[name] ??= Math.round(process.uptime() * 1000);
}
startupMark("main-module");
