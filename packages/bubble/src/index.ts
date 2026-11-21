import { readConfig } from './config';
import { mount } from './ui';

declare global {
  interface Window {
    __hivebubble?: boolean;
  }
}

(() => {
  // Read while this script runs: currentScript is only set now.
  const config = readConfig(document.currentScript);
  // One bubble per page, and never inside iframes.
  if (window.top !== window || window.__hivebubble) return;
  window.__hivebubble = true;
  const start = () => mount(config);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
