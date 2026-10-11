// Tooltip action: text plus an optional shortcut hint (SPEC §7.1: every icon button has both).
let el: HTMLDivElement | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

function show(target: HTMLElement, text: string, shortcut?: string): void {
  el ??= Object.assign(document.createElement('div'), { id: 'tip', role: 'tooltip' });
  el.replaceChildren(document.createTextNode(text));
  if (shortcut) el.appendChild(Object.assign(document.createElement('kbd'), { textContent: shortcut }));
  document.body.appendChild(el);
  const r = target.getBoundingClientRect();
  const w = el.offsetWidth;
  const below = r.bottom + 8 + el.offsetHeight < window.innerHeight;
  el.style.left = `${Math.max(6, Math.min(window.innerWidth - w - 6, r.left + r.width / 2 - w / 2))}px`;
  el.style.top = `${below ? r.bottom + 8 : r.top - el.offsetHeight - 8}px`;
}
function hide(): void {
  clearTimeout(timer);
  el?.remove();
}

export function tip(node: HTMLElement, value: string | [string, string | undefined] | undefined) {
  let current = value;
  const enter = (): void => {
    if (!current) return;
    const [text, key] = Array.isArray(current) ? current : [current, undefined];
    clearTimeout(timer);
    timer = setTimeout(() => show(node, text, key), 350);
  };
  node.addEventListener('pointerenter', enter);
  node.addEventListener('pointerleave', hide);
  node.addEventListener('pointerdown', hide);
  node.addEventListener('focus', enter);
  node.addEventListener('blur', hide);
  return {
    update(next: typeof value) {
      current = next;
    },
    destroy() {
      hide();
      node.removeEventListener('pointerenter', enter);
      node.removeEventListener('pointerleave', hide);
      node.removeEventListener('pointerdown', hide);
      node.removeEventListener('focus', enter);
      node.removeEventListener('blur', hide);
    },
  };
}
