import { useEffect, useRef, useState } from "react";

/**
 * Landing-page motion helpers. Everything here is dependency-free (no
 * framer-motion): a tiny IntersectionObserver wrapper for scroll-reveal and a
 * requestAnimationFrame count-up, both of which short-circuit to the final state
 * when the visitor has asked for reduced motion.
 */

/** True when the OS/browser requests reduced motion. SSR-safe. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

interface RevealOptions {
  /** Fraction of the element visible before it reveals (default 0.15). */
  threshold?: number;
  /** Observer rootMargin; defaults to revealing slightly before fully in view. */
  rootMargin?: string;
}

/**
 * Reveal-on-scroll: returns a ref to attach and a `visible` flag that flips true
 * the first time the element enters the viewport (then the observer disconnects,
 * so it never re-hides). When reduced motion is requested it returns visible
 * immediately so nothing is ever hidden behind an animation.
 */
export function useReveal<T extends HTMLElement = HTMLDivElement>(
  options: RevealOptions = {},
): { ref: React.RefObject<T | null>; visible: boolean } {
  const ref = useRef<T | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (prefersReducedMotion() || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      {
        threshold: options.threshold ?? 0.15,
        rootMargin: options.rootMargin ?? "0px 0px -10% 0px",
      },
    );

    observer.observe(el);
    return () => observer.disconnect();
    // Options are read once on mount; callers pass static values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { ref, visible };
}

/**
 * Animate a number from 0 to `target` while `active` is true (easeOutCubic).
 * Jumps straight to the target under reduced motion. Returns the current value;
 * callers format it (round, prefix, suffix) themselves.
 */
export function useCountUp(target: number, active: boolean, durationMs = 1400): number {
  const [value, setValue] = useState(0);

  useEffect(() => {
    if (!active) {
      setValue(0);
      return;
    }
    if (prefersReducedMotion()) {
      setValue(target);
      return;
    }

    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(target * eased);
      if (t < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        setValue(target);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, active, durationMs]);

  return value;
}
