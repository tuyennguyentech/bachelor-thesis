import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * Returns false during the server render and the first client paint, then true
 * once the component has hydrated (event handlers attached). Implemented with
 * useSyncExternalStore — the server snapshot is false and the client snapshot is
 * true — so it is hydration-safe and avoids a setState-in-effect.
 *
 * Use it to disable a client `<form onSubmit>` submit button until the handler is
 * live, so a click during the hydration window can't trigger a native form POST
 * (page reload) that drops the action.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
