// Content script:
// - Tracks real user gestures and reports them to the background service worker.
// - Detects suspicious full-screen overlays that may steal clicks.
// - Extracts lightweight page content (URL, title, meta description, first ~500 chars of text)
//   when requested by the background script.

const GESTURE_EVENTS = ["mousedown", "click", "keydown"];
const GESTURE_THROTTLE_MS = 100;
let lastGestureSentAt = 0;
let overlayObserverStarted = false;

function sendUserGesture() {
  const now = Date.now();
  if (now - lastGestureSentAt < GESTURE_THROTTLE_MS) {
    return;
  }
  lastGestureSentAt = now;

  try {
    chrome.runtime.sendMessage({
      type: "user-gesture",
      timestamp: now
    });
  } catch (e) {
    // Best-effort only; ignore failures.
  }
}

function attachGestureListeners() {
  GESTURE_EVENTS.forEach((eventName) => {
    window.addEventListener(eventName, sendUserGesture, true);
  });
}

function isHardOverlayElement(element) {
  if (!(element instanceof Element)) return false;

  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  const vw = window.innerWidth || document.documentElement.clientWidth || 0;
  const vh = window.innerHeight || document.documentElement.clientHeight || 0;

  const isFixedOrAbsolute =
    style.position === "fixed" || style.position === "absolute";
  if (!isFixedOrAbsolute || vw <= 0 || vh <= 0) {
    return false;
  }

  const coversWidth = rect.width >= vw * 0.8;
  const coversHeight = rect.height >= vh * 0.8;
  const nearTopLeft = rect.top <= 5 && rect.left <= 5;
  if (!(coversWidth && coversHeight && nearTopLeft)) {
    return false;
  }

  const zIndexValue = parseInt(style.zIndex || "0", 10);
  if (Number.isNaN(zIndexValue) || zIndexValue <= 9999) {
    return false;
  }

  const opacity = parseFloat(style.opacity || "1");
  if (!(opacity >= 0 && opacity <= 0.1)) {
    return false;
  }

  if (style.pointerEvents === "none") {
    return false;
  }

  return true;
}

function computeOverlayScore(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) {
    return 0;
  }

  let score = 0;

  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  const vw = window.innerWidth || document.documentElement.clientWidth || 0;
  const vh = window.innerHeight || document.documentElement.clientHeight || 0;

  // Heuristic 1: extreme z-index values.
  let zIndexScore = 0;
  const zIndexValue = parseInt(style.zIndex || "0", 10);
  if (!Number.isNaN(zIndexValue)) {
    if (zIndexValue >= 2147483647 || zIndexValue > 999999) {
      zIndexScore = 2;
    }
  }
  score += zIndexScore;

  // Heuristic 2: full-screen fixed/absolute overlay.
  const isFixedOrAbsolute =
    style.position === "fixed" || style.position === "absolute";

  const coversWidth = vw > 0 && rect.width >= vw * 0.95;
  const coversHeight = vh > 0 && rect.height >= vh * 0.95;
  const nearTopLeft = rect.top <= 5 && rect.left <= 5;

  let fullScreenScore = 0;
  let isFullScreenOverlay = false;
  if (isFixedOrAbsolute && coversWidth && coversHeight && nearTopLeft) {
    isFullScreenOverlay = true;
    fullScreenScore = 2;
  }
  score += fullScreenScore;

  // Heuristic 3: injected as last <body> child post-load.
  let lastChildScore = 0;
  if (
    document.readyState === "complete" &&
    element.parentElement === document.body &&
    element === document.body.lastElementChild
  ) {
    lastChildScore = 1;
  }
  score += lastChildScore;

  // Heuristic 4: full-screen overlay that intercepts clicks.
  let pointerEventsScore = 0;
  if (isFullScreenOverlay && style.pointerEvents !== "none") {
    pointerEventsScore = 1;
  }
  score += pointerEventsScore;

  return score;
}

function startOverlayObserver() {
  if (overlayObserverStarted) return;
  overlayObserverStarted = true;

  if (!document.body) return;

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (!(node instanceof Element)) return;

        const score = computeOverlayScore(node);
        if (score >= 3) {
          try {
            chrome.runtime.sendMessage({
              type: "overlay-signal",
              score
            });
          } catch (e) {
            // Ignore failures.
          }
        }
      });
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}

function handleOverlayClick(event) {
  let node = event.target;
  while (node && node !== document.body) {
    if (node instanceof Element && isHardOverlayElement(node)) {
      try {
        chrome.runtime.sendMessage({
          type: "hard-overlay-click",
          timestamp: Date.now()
        });
      } catch (e) {
        // Ignore failures.
      }
      break;
    }
    node = node.parentElement;
  }
}

function extractPageInfo() {
  let title = "";
  let metaDescription = "";
  let textContent = "";

  try {
    title = document.title || "";
  } catch {
    title = "";
  }

  try {
    const meta = document.querySelector('meta[name="description"]');
    metaDescription = (meta && meta.getAttribute("content")) || "";
  } catch {
    metaDescription = "";
  }

  try {
    if (document.body) {
      textContent = document.body.textContent || "";
      // Normalize whitespace and trim down to ~500 characters to avoid over-scanning.
      textContent = textContent.replace(/\s+/g, " ").trim().slice(0, 500);
    }
  } catch {
    textContent = "";
  }

  let url = "";
  try {
    url = window.location.href || "";
  } catch {
    url = "";
  }

  return {
    url,
    title,
    metaDescription,
    textContent
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    return;
  }

  if (message.type === "extract-page-scan") {
    const data = extractPageInfo();
    try {
      chrome.runtime.sendMessage({
        type: "page-scan-result",
        ...data
      });
    } catch (e) {
      // Ignore send failures.
    }
  }
});

// Initialize immediately on script load.
attachGestureListeners();
startOverlayObserver();
window.addEventListener("click", handleOverlayClick, true);


