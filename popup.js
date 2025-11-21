// Popup script for the Shield extension toggle

const toggleButton = document.getElementById("toggleButton");
const buttonText = document.getElementById("buttonText");
const statusText = document.getElementById("statusText");

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

// Initialize the popup
loadState();

