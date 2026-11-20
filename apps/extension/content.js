// Hivebubble extension, on localhost pages: asks the background whether this page
// gets the bubble, and if so adds the engine's own bubble script, with the engine's
// address and pairing token. The bubble takes the token off the page once it reads it.
(async () => {
  if (window.top !== window) return;
  // Hivebubble's preview already has the bubble.
  if (document.querySelector('script[data-hivebubble], hivebubble-root')) return;
  let answer = null;
  try {
    answer = await chrome.runtime.sendMessage({ type: 'page' });
  } catch {
    return;
  }
  if (!answer || !/^http:\/\/127\.0\.0\.1:\d+$/.test(answer.engine)) return;
  const script = document.createElement('script');
  script.src = `${answer.engine}/__hivebubble/bubble.js`;
  script.dataset.hivebubble = '';
  script.dataset.hivebubbleEngine = answer.engine;
  script.dataset.hivebubbleToken = answer.token;
  (document.head || document.documentElement).append(script);
})();
