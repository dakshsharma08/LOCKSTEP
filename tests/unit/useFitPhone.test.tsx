// @vitest-environment jsdom
/**
 * The Studio's phone preview is sized to its box (src/features/studio/useFitPhone.ts).
 * Regression: on some first loads the box mounted AFTER the data was ready (the page shows a skeleton
 * until every database read has answered). The old effect had already run without a box and never ran
 * again, so the phone kept a default 300 px width and covered the title until the page was refreshed.
 */
import { act, render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fitPhoneWidth, useFitPhone } from '../../src/features/studio/useFitPhone';

const IPHONE = 2622 / 1206;
let boxSize = { width: 360, height: 400 };
const observers: { cb: () => void; el: Element }[] = [];

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private cb: () => void) {}
      observe(el: Element) {
        observers.push({ cb: this.cb, el });
      }
      disconnect() {
        for (let i = observers.length - 1; i >= 0; i--)
          if (observers[i]!.cb === this.cb) observers.splice(i, 1);
      }
    },
  );
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () =>
      ({ ...boxSize, x: 0, y: 0, top: 0, left: 0, right: boxSize.width, bottom: boxSize.height }) as DOMRect,
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Mirrors the Studio: the preview box only exists once `ready` (all data loaded). */
function Studio({ ready, aspect }: { ready: boolean; aspect: number | null }) {
  const { boxRef, width } = useFitPhone(aspect, false);
  if (!ready) return <p>loading…</p>;
  return (
    <div ref={boxRef} data-testid="box">
      {width === null ? 'unmeasured' : `phone ${width}`}
    </div>
  );
}

describe('useFitPhone', () => {
  it('measures the box even when it mounts AFTER the design/aspect is ready (the first-load race)', () => {
    boxSize = { width: 360, height: 400 };
    // 1st render: aspect known, box not mounted (skeleton). 2nd render: box mounts; nothing else changed.
    const { rerender, getByTestId } = render(<Studio ready={false} aspect={IPHONE} />);
    rerender(<Studio ready aspect={IPHONE} />);
    const w = fitPhoneWidth(boxSize, IPHONE, false);
    expect(getByTestId('box').textContent).toBe(`phone ${w}`);
    expect(w).not.toBe(300);
    // The whole frame (screen + 16 px bezel) fits the box height.
    expect(Math.round(w * IPHONE) + 16).toBeLessThanOrEqual(boxSize.height);
  });

  it('never renders the phone before it is measured (no flash at a wrong size)', () => {
    const { getByTestId } = render(<Studio ready aspect={null} />);
    expect(getByTestId('box').textContent).toBe('unmeasured');
  });

  it('re-measures when the box resizes and when the device aspect changes', () => {
    boxSize = { width: 360, height: 500 };
    const { rerender, getByTestId } = render(<Studio ready aspect={IPHONE} />);
    expect(getByTestId('box').textContent).toBe(`phone ${fitPhoneWidth(boxSize, IPHONE, false)}`);
    boxSize = { width: 360, height: 300 }; // the editor expanded
    act(() => observers.forEach((o) => o.cb()));
    expect(getByTestId('box').textContent).toBe(`phone ${fitPhoneWidth(boxSize, IPHONE, false)}`);
    rerender(<Studio ready aspect={2400 / 1080} />);
    expect(getByTestId('box').textContent).toBe(`phone ${fitPhoneWidth(boxSize, 2400 / 1080, false)}`);
  });

  it('stops observing when the box unmounts', () => {
    function Toggle() {
      const [on, setOn] = useState(true);
      return (
        <>
          <button onClick={() => setOn(false)}>hide</button>
          <Studio ready={on} aspect={IPHONE} />
        </>
      );
    }
    const { getByText } = render(<Toggle />);
    expect(observers).toHaveLength(1);
    act(() => getByText('hide').click());
    expect(observers).toHaveLength(0);
  });
});

describe('fitPhoneWidth', () => {
  it('mobile: the frame fits both ways, capped at 340, never below 40', () => {
    for (const box of [
      { width: 360, height: 300 },
      { width: 390, height: 364 },
      { width: 430, height: 900 },
      { width: 300, height: 90 },
    ]) {
      const w = fitPhoneWidth(box, IPHONE, false);
      expect(w).toBeLessThanOrEqual(340);
      expect(w).toBeGreaterThanOrEqual(40);
      if (w > 40) {
        expect(w + 16).toBeLessThanOrEqual(box.width);
        expect(w * IPHONE + 16).toBeLessThanOrEqual(box.height);
      }
    }
  });
  it('desktop: unchanged sizing', () => {
    expect(fitPhoneWidth({ width: 600, height: 780 }, IPHONE, true)).toBe(
      Math.floor(Math.max(180, Math.min(400, 600 - 24, (780 - 24) / IPHONE))),
    );
  });
});
