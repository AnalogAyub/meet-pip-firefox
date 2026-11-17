// Runs before Meet's own scripts. Meet rearranges its page when it thinks the
// call is in Picture-in-Picture or the tab is hidden, so keep both from it:
// the PiP window should show the layout you left.
(() => {
  'use strict';
  if (window.__meetPipEarly) return;
  const early = window.__meetPipEarly = { onPip: null };

  // Capture listeners on window, registered first, run before any of Meet's.
  for (const type of ['enterpictureinpicture', 'leavepictureinpicture']) {
    window.addEventListener(type, e => {
      if (e.target?.id !== 'meet-pip-mirror') return;
      e.stopImmediatePropagation();
      early.onPip?.(type === 'enterpictureinpicture');
    }, true);
  }
  window.addEventListener('visibilitychange', e => e.stopImmediatePropagation(), true);

  // Firefox only: what the page's own scripts read.
  const page = document.wrappedJSObject;
  if (page && typeof exportFunction === 'function') {
    const fixed = (name, value) => {
      try {
        Object.defineProperty(page, name, { get: exportFunction(() => value, window), configurable: true });
      } catch (e) { /* ignore */ }
    };
    fixed('pictureInPictureElement', null);
    fixed('visibilityState', 'visible');
    fixed('hidden', false);
  }
})();
