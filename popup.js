// Popup script for the Shield extension toggle

const toggleButton = document.getElementById("toggleButton");
const buttonText = document.getElementById("buttonText");
const statusText = document.getElementById("statusText");
const markSpamButton = document.getElementById("markSpamButton");
const falsePositiveButton = document.getElementById("falsePositiveButton");

// Load the current enabled state from storage
async function loadState() {
  const result = await chrome.storage.local.get({ enabled: true });
  updateUI(result.enabled);
}

// Update the UI based on the enabled state
function updateUI(enabled) {
  if (enabled) {
    buttonText.textContent = "Turn Off";
    toggleButton.classList.remove("disabled");
    statusText.innerHTML = 'Extension is <strong>enabled</strong>';
  } else {
    buttonText.textContent = "Turn On";
    toggleButton.classList.add("disabled");
    statusText.innerHTML = 'Extension is <strong>disabled</strong>';
  }
}

// Toggle the extension state
toggleButton.addEventListener("click", async () => {
  const result = await chrome.storage.local.get({ enabled: true });
  const newState = !result.enabled;
  
  await chrome.storage.local.set({ enabled: newState });
  updateUI(newState);
  
  // Notify the background script of the state change
  chrome.runtime.sendMessage({ type: "toggle-enabled", enabled: newState });
});

// Mark current site as spam
if (markSpamButton) {
  markSpamButton.addEventListener("click", async () => {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs && tabs[0];
      if (!tab || !tab.url) {
        return;
      }
      let domain = "";
      try {
        domain = new URL(tab.url).hostname;
      } catch {
        domain = "";
      }
      if (!domain) return;

      chrome.runtime.sendMessage({
        type: "mark-spam",
        domain,
        url: tab.url
      });
    } catch (e) {
      // Ignore errors.
    }
  });
}

// Handle False Positive: reopen last auto-closed tab and mark its domain as safe.
if (falsePositiveButton) {
  falsePositiveButton.addEventListener("click", () => {
    chrome.runtime.sendMessage({
      type: "false-positive"
    });
  });
}

// Initialize the popup
loadState();

