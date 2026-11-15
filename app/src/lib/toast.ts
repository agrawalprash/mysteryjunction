// Short notices shown at the bottom of the screen (e.g. "From your phone: …").

export function toast(message: string) {
  window.dispatchEvent(new CustomEvent('wander-toast', { detail: message }));
}

export function onToast(fn: (message: string) => void): () => void {
  const h = (e: Event) => fn((e as CustomEvent<string>).detail);
  window.addEventListener('wander-toast', h);
  return () => window.removeEventListener('wander-toast', h);
}
