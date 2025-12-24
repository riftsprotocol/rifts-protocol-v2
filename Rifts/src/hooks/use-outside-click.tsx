import React, { useEffect } from "react";

export const useOutsideClick = (
  ref: React.RefObject<HTMLDivElement>,
  callback: (event: MouseEvent | TouchEvent) => void
) => {
  useEffect(() => {
    const listener = (event: MouseEvent | TouchEvent) => {
      try {
        // Some iOS 16 Safari touch events can have a null target; guard to avoid crashes
        const target = (event as any)?.target as Node | null;
        // DO NOTHING if no target or the element being clicked is the target element or their children
        if (!target || !ref.current || ref.current.contains(target)) {
          return;
        }
        callback(event);
      } catch (err) {
        // Swallow unexpected target errors on legacy iOS to keep UI responsive
        console.warn('useOutsideClick listener error', err);
      }
    };

    document.addEventListener("mousedown", listener);
    document.addEventListener("touchstart", listener);

    return () => {
      document.removeEventListener("mousedown", listener);
      document.removeEventListener("touchstart", listener);
    };
  }, [ref, callback]);
};
