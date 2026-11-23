export const listeners: any = [];

let lastURL = "";

export const observer = new MutationObserver(() => {
  const curURL = location.href;
  if (lastURL !== curURL) {
    lastURL = curURL;
    listeners.forEach((fn: any) => fn());
  }
});

export function subscribe(fn: any) {
  listeners.push(fn);
}

// На document_start (runAt) document.body ещё null, а content script
// `sendPrintNum` запускается именно так. Без этой проверки
// observer.observe(null) бросает TypeError и скрипт умирает до main().
function observeBody() {
  if (document.body) {
    observer.observe(document.body, {
      subtree: true,
      childList: true,
    });
    return;
  }

  document.addEventListener("DOMContentLoaded", observeBody, { once: true });
  window.addEventListener("load", observeBody, { once: true });
}

observeBody();
