/**
 * Modal 焦點鎖定與背景 inert 工具：
 * - Tab / Shift+Tab 循環限制在容器內
 * - 若 Modal 掛載於 #root 外部（如 Portal），暫時對 #root 設 inert 避免螢幕閱讀器與鍵盤逃逸到背景
 */
export function activateModalFocus(container: HTMLElement | null): () => void {
  if (!container) return () => {};
  const root = document.getElementById('root');
  const setInert = !!(root && !root.contains(container));
  const prevInert = root?.inert ?? false;
  if (setInert && root) root.inert = true;

  const focusables = () =>
    [...container.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter((el) => el.offsetParent !== null || el === document.activeElement);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const list = focusables();
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    if (e.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (document.activeElement === last || !container.contains(document.activeElement))) {
      e.preventDefault();
      first.focus();
    }
  };

  window.addEventListener('keydown', onKeyDown);
  return () => {
    window.removeEventListener('keydown', onKeyDown);
    if (setInert && root) root.inert = prevInert;
  };
}
