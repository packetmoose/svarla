/**
 * Scroll-activity helper — reveals custom scrollbars only while a container is
 * actively scrolling (or hovered), then fades them out again after a short idle
 * delay. Pure CSS can style a scrollbar but cannot detect "actively scrolling",
 * so this adds a lightweight, capture-phase scroll listener that tags the
 * scrolled element with `data-scrolling="true"` for a brief window; the
 * scrollbar CSS keys its thumb visibility off that attribute (and `:hover`).
 *
 * A single delegated listener on the document (capture phase, so it also sees
 * scroll events from nested overflow containers, which don't bubble) keeps this
 * O(1) regardless of how many scroll areas exist. The attribute is cleared per
 * element after {@link IDLE_MS} of no further scrolling.
 */

/** How long after the last scroll event the scrollbar stays revealed. */
const IDLE_MS = 900;

/** Per-element idle timers so each scroller fades independently. */
const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>();

let installed = false;

function markScrolling(target: EventTarget | null): void {
  // Scroll events fire on Element (overflow containers) or Document (the page).
  // Normalize the document/page case to the scrolling element so the attribute
  // has somewhere to live.
  let el: Element | null = null;
  if (target instanceof Element) {
    el = target;
  } else if (target === document || target instanceof Document) {
    el = document.scrollingElement ?? document.documentElement;
  }
  if (!el) return;

  el.setAttribute("data-scrolling", "true");

  const existing = timers.get(el);
  if (existing !== undefined) clearTimeout(existing);
  timers.set(
    el,
    setTimeout(() => {
      el.removeAttribute("data-scrolling");
      timers.delete(el);
    }, IDLE_MS),
  );
}

/**
 * Install the global scroll-activity listener. Idempotent: a second call is a
 * no-op. Safe to call during app bootstrap.
 */
export function initScrollActivity(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;

  document.addEventListener(
    "scroll",
    (e) => markScrolling(e.target),
    // Capture so nested overflow-container scroll events (which don't bubble)
    // are still observed; passive since we never call preventDefault.
    { capture: true, passive: true },
  );
}
