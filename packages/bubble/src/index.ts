import { mount } from './ui';

declare global {
  interface Window {
    __hivebubble?: boolean;
  }
}

(() => {
  // One bubble per page, and never inside iframes.
  if (window.top !== window || window.__hivebubble) return;
  window.__hivebubble = true;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
