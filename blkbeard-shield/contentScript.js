// Content script:
// - Tracks real user gestures and reports them to the background service worker.
// - Extracts lightweight page content (URL, title, meta description, first ~500 chars of text)
//   when requested by the background script.

const GESTURE_EVENTS = ["mousedown", "click", "keydown"];
const GESTURE_THROTTLE_MS = 100;
let lastGestureSentAt = 0;

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


