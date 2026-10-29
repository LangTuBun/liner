import { useEffect, useState, type RefObject } from "react";

const EDGE_TOLERANCE_PX = 4;

export interface ScrollEdges {
  atTop: boolean;
  atBottom: boolean;
}

function readEdges(el: HTMLElement): ScrollEdges {
  return {
    atTop: el.scrollTop <= EDGE_TOLERANCE_PX,
    atBottom:
      el.scrollHeight - el.clientHeight - el.scrollTop <= EDGE_TOLERANCE_PX,
  };
}

export function useScrollEdges(
  ref: RefObject<HTMLElement | null>,
  contentKey: unknown,
): ScrollEdges {
  const [edges, setEdges] = useState<ScrollEdges>({
    atTop: true,
    atBottom: false,
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const next = readEdges(el);
      setEdges((prev) =>
        prev.atTop === next.atTop && prev.atBottom === next.atBottom
          ? prev
          : next,
      );
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    el.addEventListener("braccato:lyrics-loaded", update);
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      el.removeEventListener("braccato:lyrics-loaded", update);
      observer?.disconnect();
    };
  }, [ref, contentKey]);

  return edges;
}
