// Pages and sheets that most sessions never open load on first use, so the shell parses and
// runs less script before it can paint. Each one suspends only itself (fallback: nothing).
import { lazy, Suspense, type ComponentType } from "react";

export function lazyComponent<P extends object>(load: () => Promise<ComponentType<P>>) {
  const Lazy = lazy(() => load().then((component) => ({ default: component })));
  let started: Promise<unknown> | undefined;
  const Component = (props: P) => (
    <Suspense fallback={null}>
      <Lazy {...props} />
    </Suspense>
  );
  /** Starts loading early (on hover, or when the page is idle). */
  Component.preload = () => (started ??= load().catch(() => (started = undefined)));
  return Component;
}
