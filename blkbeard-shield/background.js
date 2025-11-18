// Background service worker (Manifest V3, module).
// Evaluates the three conditions and closes tabs when:
// Condition 1 (fake / no real user gesture) AND (Condition 2 OR Condition 3).

import { matchesSpamWordlists, urlHasAffiliateParams } from "./utils.js";

// Timestamp (ms) of last real user gesture observed anywhere.
let lastUserGesture = 0;

// Track the currently active tab and window focus to help evaluate Condition 1.
let currentActiveTabId = null;
let windowFocused = true;

// Track tabs that were suspicious at creation time (Condition 1 true).
// Map<tabId, { condition1: boolean, condition2: boolean, condition3: boolean, scanRequested: boolean }>
const suspiciousTabs = new Map();

function getTabUrl(tab) {
  if (!tab) return "";
  return tab.pendingUrl || tab.url || "";
}

function evaluateCondition1(tab) {
  // Condition 1: the tab was opened via a false user gesture.

  // 1) If tab.openerTabId exists but is not equal to the currently active tab, treat as suspicious.
  let openerSuspicious = false;
  if (typeof tab.openerTabId === "number") {
    if (currentActiveTabId !== null && tab.openerTabId !== currentActiveTabId) {
      openerSuspicious = true;
    }
  }

  // 2) If the browser window is not focused when the tab is created, treat as suspicious.
  const unfocusedSuspicious = !windowFocused;

  // 3) If Date.now() - lastUserGesture > 500 ms, treat as suspicious.
  const now = Date.now();
  const gestureSuspicious =
    lastUserGesture > 0 ? now - lastUserGesture > 500 : false;

  return openerSuspicious || unfocusedSuspicious || gestureSuspicious;
}

function maybeCloseTabIfRulesMatch(tabId, record) {
  if (!record || !record.condition1) {
    return;
  }

  if (record.condition2 || record.condition3) {
    // Condition 1 AND (Condition 2 OR Condition 3) -> close.
    chrome.tabs.remove(tabId);
  }
}

function handlePageScanResult(message, sender) {
  const tabId = sender?.tab?.id;
  if (!tabId) return;

  const record = suspiciousTabs.get(tabId);
  if (!record) {
    // If we never classified this tab as suspicious at creation time,
    // we must NOT close based solely on content or URL.
    return;
  }

  const url = message.url || getTabUrl(sender.tab);
  const title = message.title || "";
  const metaDescription = message.metaDescription || "";
  const textContent = message.textContent || "";

  const condition2 = matchesSpamWordlists({
    url,
    title,
    metaDescription,
    textContent
  });

  // Condition 3 can also be evaluated from the final resolved URL.
  const condition3FromUrl = urlHasAffiliateParams(url);

  record.condition2 = condition2;
  record.condition3 = record.condition3 || condition3FromUrl;

  maybeCloseTabIfRulesMatch(tabId, record);
  suspiciousTabs.delete(tabId);
}

// Listen for user gestures reported from content scripts.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    return;
  }

  if (message.type === "user-gesture") {
    // Update lastUserGesture with a fast in-memory value (no chrome.storage).
    lastUserGesture = Date.now();
  } else if (message.type === "page-scan-result") {
    handlePageScanResult(message, sender);
  }
});

// Track active tab for openerTabId comparisons.
chrome.tabs.onActivated.addListener((activeInfo) => {
  currentActiveTabId = activeInfo.tabId;
});

// Track whether any browser window is focused.
chrome.windows.onFocusChanged.addListener((windowId) => {
  windowFocused = windowId !== chrome.windows.WINDOW_ID_NONE;
});

// Evaluate tabs when they are created (Condition 1, 3 from initial URL).
chrome.tabs.onCreated.addListener((tab) => {
  const condition1 = evaluateCondition1(tab);
  if (!condition1) {
    return;
  }

  const initialUrl = getTabUrl(tab);
  const condition3 = urlHasAffiliateParams(initialUrl);

  // If Condition 1 AND Condition 3 are already true at creation, close immediately.
  if (condition3) {
    chrome.tabs.remove(tab.id);
    return;
  }

  // Otherwise, track this tab as suspicious and wait for content scan.
  suspiciousTabs.set(tab.id, {
    condition1: true,
    condition2: false,
    condition3,
    scanRequested: false
  });
});

// React to URL changes and load completion for suspicious tabs.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const record = suspiciousTabs.get(tabId);
  if (!record) {
    return;
  }

  // Re-check Condition 3 when URL changes.
  if (changeInfo.url) {
    if (urlHasAffiliateParams(changeInfo.url)) {
      record.condition3 = true;
      maybeCloseTabIfRulesMatch(tabId, record);
      if (!suspiciousTabs.has(tabId)) {
        return;
      }
    }
  }

  // Once the tab finishes loading, request a lightweight page scan via content script.
  if (changeInfo.status === "complete" && !record.scanRequested) {
    record.scanRequested = true;
    chrome.tabs.sendMessage(
      tabId,
      { type: "extract-page-scan" },
      () => {
        // Ignore errors (e.g., if content script cannot run on this URL).
        void chrome.runtime.lastError;
      }
    );
  }
});


