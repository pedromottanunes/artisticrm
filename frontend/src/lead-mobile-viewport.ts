// Scoped to the lead sheet; other dialogs and desktop retain their existing behavior.
export const leadMobileQuery = '(max-width: 760px), (max-width: 1024px) and (pointer: coarse)';

export function observeLeadViewport(dialog: HTMLDialogElement) {
  const mobile = window.matchMedia(leadMobileQuery);
  const viewport = window.visualViewport;
  let baseline = window.innerHeight;
  let width = window.innerWidth;
  let keyboard = false;
  let frame = 0;
  let settle = 0;

  const editable = (element: Element | null): element is HTMLInputElement | HTMLTextAreaElement =>
    ((element instanceof HTMLInputElement &&
      !['button', 'submit', 'checkbox', 'radio', 'hidden'].includes(element.type)) ||
      element instanceof HTMLTextAreaElement) &&
    !element.disabled &&
    !element.readOnly;

  const reveal = () => {
    if (!mobile.matches) return;
    const active = document.activeElement;
    if (!editable(active) || !dialog.contains(active)) return;
    const scroll = active.closest<HTMLElement>('.lead-form-scroll');
    if (!scroll) return;
    const bounds = scroll.getBoundingClientRect();
    const field = active.getBoundingClientRect();
    const label = active.labels?.[0]?.getBoundingClientRect();
    const top = Math.min(field.top, label?.top ?? field.top) - 12;
    const bottom = field.bottom + 12;
    if (top < bounds.top) scroll.scrollTop += top - bounds.top;
    else if (bottom > bounds.bottom) scroll.scrollTop += bottom - bounds.bottom;
  };

  const update = () => {
    const height = viewport?.height ?? window.innerHeight;
    if (Math.abs(window.innerWidth - width) > 80) {
      width = window.innerWidth;
      baseline = window.innerHeight;
    }
    const focused = editable(document.activeElement) && dialog.contains(document.activeElement);
    const loss =
      Math.max(baseline, window.innerHeight, document.documentElement.clientHeight) - height;
    // Focus alone isn't a keyboard (external keyboards and desktop touchscreens).
    // Keep the compact toolbar through focusout until the viewport actually recovers,
    // so a touch on Save doesn't disappear between pointerdown and click.
    keyboard =
      mobile.matches && (viewport?.scale ?? 1) <= 1.05 && loss > 120 && (focused || keyboard);
    if (!focused && !keyboard) baseline = window.innerHeight;
    dialog.dataset.keyboardOpen = String(keyboard);
    dialog.style.setProperty('--lead-viewport-height', `${height}px`);
    dialog.style.setProperty('--lead-viewport-top', `${viewport?.offsetTop ?? 0}px`);
    if (keyboard) dialog.querySelector('details.lead-mobile-menu')?.removeAttribute('open');
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(reveal);
  };
  const focus = () => {
    update();
    window.clearTimeout(settle);
    settle = window.setTimeout(update, 250);
  };

  update();
  viewport?.addEventListener('resize', update);
  viewport?.addEventListener('scroll', update);
  window.addEventListener('resize', update);
  mobile.addEventListener('change', update);
  dialog.addEventListener('focusin', focus);
  dialog.addEventListener('focusout', focus);
  return () => {
    cancelAnimationFrame(frame);
    window.clearTimeout(settle);
    viewport?.removeEventListener('resize', update);
    viewport?.removeEventListener('scroll', update);
    window.removeEventListener('resize', update);
    mobile.removeEventListener('change', update);
    dialog.removeEventListener('focusin', focus);
    dialog.removeEventListener('focusout', focus);
    delete dialog.dataset.keyboardOpen;
  };
}
