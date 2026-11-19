// Start moving on the first wheel event. Subsequent deltas in the same gesture
// advance its destination, including the smaller pixel deltas from a trackpad.
export const wheelDays = (distance: number) => distance > 0 ? Math.max(1, Math.round(distance / 100)) : 0;

export function calendarScrollTarget(start: number, steps: number, stops: number[], viewportHeight: number): number {
  const direction = Math.sign(steps);
  if (direction < 0) stops = [...stops].reverse();
  let position = start, index = 0;
  for (let step = 0; step < Math.abs(steps); step++) {
    while (index < stops.length && (stops[index]! - position) * direction <= 1) index++;
    if (index === stops.length) break;
    // Page through a tall day so its later releases stay reachable.
    const heading = stops[index]!;
    position = Math.abs(heading - position) <= viewportHeight ? heading : position + direction * viewportHeight * 0.85;
  }
  return position;
}

export function bindCalendarWheel(page: HTMLElement, viewportTop: () => number) {
  const root = document.documentElement;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let frame = 0, previousFrame = 0, lastInput = -Infinity, direction = 0, distance = 0;
  // A loaded week stays in place in the DOM when earlier dates are prepended.
  // Keep the destination relative to it so it moves with those dates.
  let anchor: HTMLElement | null = null, offset = 0;
  const remaining = () => anchor ? anchor.getBoundingClientRect().top + offset : 0;
  const stop = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    anchor = null;
    lastInput = -Infinity;
  };
  const animate = (now: number) => {
    const delta = remaining();
    const fraction = 1 - Math.exp(-Math.max(1, now - previousFrame) / 50);
    previousFrame = now;
    const before = window.scrollY;
    window.scrollBy({top: Math.abs(delta) < 1 ? delta : Math.sign(delta) * Math.max(1, Math.abs(delta) * fraction), behavior: 'instant'});
    frame = Math.abs(delta) > 1 && window.scrollY !== before ? requestAnimationFrame(animate) : 0;
  };
  const wheel = (event: WheelEvent) => {
    if (!event.cancelable || event.defaultPrevented || event.ctrlKey || event.shiftKey || !event.deltaY ||
        Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    event.preventDefault();
    root.classList.add('calendar-wheel');
    const now = performance.now(), sign = Math.sign(event.deltaY);
    const reversed = sign !== direction;
    if (reversed || now - lastInput > 160) distance = 0;
    direction = sign;
    lastInput = now;
    const previous = wheelDays(distance);
    distance += Math.abs(event.deltaY) * (event.deltaMode === 1 ? 32 : event.deltaMode === 2 ? 100 : 1);
    const steps = wheelDays(distance) - previous;
    if (!steps) return;

    const top = viewportTop(), y = window.scrollY;
    const limit = Math.max(0, root.scrollHeight - window.innerHeight);
    const headings = page.querySelectorAll<HTMLElement>('.calendar-day,.calendar-empty-week,.calendar-more,[role="alert"],:scope > p');
    const stops = [0, ...Array.from(headings, el => Math.max(0, Math.min(limit, y + el.getBoundingClientRect().top - top))), limit];
    const start = frame && !reversed ? y + remaining() : y;
    const target = calendarScrollTarget(start, sign * steps, stops, Math.max(1, window.innerHeight - top));
    anchor = page.querySelector<HTMLElement>('[data-week]');
    if (!anchor) return;
    offset = target - y - anchor.getBoundingClientRect().top;
    if (reducedMotion.matches) {
      cancelAnimationFrame(frame);
      frame = 0;
      window.scrollTo({top: target, behavior: 'instant'});
    } else if (!frame) {
      previousFrame = now;
      frame = requestAnimationFrame(animate);
    }
  };
  const nativeInput = (event: PointerEvent | KeyboardEvent) => {
    stop();
    if (event instanceof KeyboardEvent || event.pointerType === 'touch') root.classList.remove('calendar-wheel');
  };
  page.addEventListener('wheel', wheel, {passive: false});
  window.addEventListener('pointerdown', nativeInput, true);
  window.addEventListener('keydown', nativeInput, true);
  return () => {
    stop();
    page.removeEventListener('wheel', wheel);
    window.removeEventListener('pointerdown', nativeInput, true);
    window.removeEventListener('keydown', nativeInput, true);
    root.classList.remove('calendar-wheel');
  };
}
