// Pages and sheets that most sessions never open load on first use, so the shell parses and
// runs less script before it can paint. Not React.lazy: Suspense holds a revealed boundary
// back for up to 300 ms, which made a first open feel slow; this renders nothing until the
// module is in (a few milliseconds from disk) and from then on renders synchronously.
import { useEffect, useState, type ComponentType } from "react";

export function lazyComponent<P extends object>(load: () => Promise<ComponentType<P>>) {
  let loaded: ComponentType<P> | null = null;
  let loading: Promise<ComponentType<P>> | null = null;
  const start = () => {
    loading ??= load().then(
      (component) => (loaded = component),
      (error) => {
        loading = null;
        throw error;
      },
    );
    return loading;
  };
  function Lazy(props: P) {
    const [Component, setComponent] = useState<ComponentType<P> | null>(() => loaded);
    useEffect(() => {
      if (Component) return;
      let live = true;
      start().then((c) => live && setComponent(() => c), (error) => console.error(error));
      return () => {
        live = false;
      };
    }, [Component]);
    return Component ? <Component {...props} /> : null;
  }
  /** Starts loading early (on hover, or when the page is idle). */
  Lazy.preload = () => void start().catch(() => {});
  return Lazy;
}
