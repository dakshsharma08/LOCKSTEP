/**
 * Size the Studio's phone preview to the box it sits in.
 *
 * Why a callback ref (for learners): the box mounts only once EVERY database read has answered (the page
 * shows a skeleton until then), which can be several renders after the design is ready. The old code used
 * `useRef` plus an effect with hand-picked dependencies: when that effect ran while the skeleton was still
 * showing, it found no box and never ran again, so the phone kept a default 300 px width and covered the
 * title on some first loads (a refresh changed the timing and "fixed" it). Keeping the element in state
 * re-runs the measurement whenever the box actually mounts, whatever the order of the data.
 */
import { useLayoutEffect, useState } from 'react';

/** CSS width of the phone SCREEN for a box of this size (the frame adds an 8px bezel on every side). */
export function fitPhoneWidth(
  box: { width: number; height: number },
  aspect: number,
  desktop: boolean,
): number {
  if (desktop) {
    // Desktop: unchanged sizing (a large preview between the template rail and the properties panel).
    return Math.floor(Math.max(180, Math.min(400, box.width - 24, (box.height - 24) / aspect)));
  }
  // Mobile: fit the whole FRAME (+16) with a little air (+12). No minimum beyond a sliver: on a short
  // screen the phone gets smaller; it never spills over the title or the editor.
  const FRAME = 16;
  const AIR = 12;
  return Math.max(
    40,
    Math.floor(Math.min(340, box.width - FRAME - AIR, (box.height - FRAME - AIR) / aspect)),
  );
}

/**
 * `boxRef` goes on the preview box. `width` is null until the box has been measured (render the phone only
 * then, so it never appears at a wrong size). Re-measures on every resize and when the aspect or layout changes.
 */
export function useFitPhone(aspect: number | null, desktop: boolean) {
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!box || !aspect) return;
    const measure = () => setWidth(fitPhoneWidth(box.getBoundingClientRect(), aspect, desktop));
    measure(); // before the first paint
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
  }, [box, aspect, desktop]);
  return { boxRef: setBox, box, width };
}
