/**
 * Simple reactive state store.
 * Holds application state and notifies subscribers on changes.
 */

type Listener<T> = (state: T) => void;

export interface Store<T> {
  getState(): T;
  setState(partial: Partial<T>): void;
  subscribe(listener: Listener<T>): () => void;
}

export function createStore<T extends object>(initialState: T): Store<T> {
  let state: T = { ...initialState };
  const listeners = new Set<Listener<T>>();

  function getState(): T {
    return state;
  }

  function setState(partial: Partial<T>): void {
    state = { ...state, ...partial };
    for (const listener of listeners) {
      listener(state);
    }
  }

  function subscribe(listener: Listener<T>): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return { getState, setState, subscribe };
}
