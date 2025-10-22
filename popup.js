document.addEventListener("DOMContentLoaded", function () {
  console.log("Loaded Blocknotes Extension Popup.");
  const notesList = document.getElementById("notes-list");
  const openButton = document.getElementById("home");
  const slashCheckbox = document.getElementById("check-5");
  const infoButton = document.getElementById("info");
  const setKeyButton = document.getElementById("setting-naming");
  const aiCard = document.getElementById("auto-name-setting");

  // Load settings
  chrome.storage.local.get("settings", (data) => {
    const settings = data.settings || {};
    slashCheckbox.checked = settings.useShiftSlash !== false; // Default true
  });

  // Toggle Shift+/ mode
  slashCheckbox.addEventListener("change", () => {
    const isEnabled = slashCheckbox.checked;
    chrome.storage.local.get("settings", (data) => {
      const updatedSettings = {
        ...(data.settings || {}),
        useShiftSlash: isEnabled,
      };
      chrome.storage.local.set({ settings: updatedSettings });
      console.log("Shift+/ mode:", isEnabled ? "Enabled" : "Disabled");
    });
  });

  // Info button
  infoButton.addEventListener("click", () => {
    window.open("https://ai.google.dev/", "_blank");
  });

  // Setup API key
  setKeyButton.addEventListener("click", () => {
    const existingContainer = document.querySelector(".oai-key-container");
    if (existingContainer) {
      existingContainer.remove();
      return;
    }

    const containerDiv = document.createElement("div");
    containerDiv.classList.add("setting-card", "oai-key-container");

    // Create header with title and close button
    const headerDiv = document.createElement("div");
    headerDiv.style.cssText =
      "display: flex; justify-content: space-between; align-items: center;";

    const titleH2 = document.createElement("h2");
    titleH2.textContent = "Setup Gemini API";
    titleH2.style.margin = "0";

    const closeButton = document.createElement("button");
    closeButton.innerHTML = "×";
    closeButton.className = "close-button";
    closeButton.onclick = () => containerDiv.remove();

    headerDiv.appendChild(titleH2);
    headerDiv.appendChild(closeButton);

    const inputField = document.createElement("input");
    inputField.type = "text";
    inputField.placeholder = "Enter Gemini API Key";

    const saveButton = document.createElement("button");
    saveButton.textContent = "Save";
    saveButton.classList.add("primary");

    containerDiv.appendChild(headerDiv);
    containerDiv.appendChild(inputField);
    containerDiv.appendChild(saveButton);
    aiCard.parentNode.insertBefore(containerDiv, aiCard.nextSibling);
    setTimeout(() => inputField.focus(), 100);

    saveButton.addEventListener("click", () => {
      const AIKEY = inputField.value.trim();
      if (!AIKEY) {
        inputField.style.borderColor = "#ff6b6b";
        setTimeout(() => {
          inputField.style.borderColor = "#d1d5db";
        }, 500);
        return;
      }

      chrome.storage.local.get("settings", (data) => {
        const updatedSettings = {
          ...(data.settings || {}),
          key: AIKEY,
        };
        chrome.storage.local.set({ settings: updatedSettings });

        saveButton.textContent = "✓ SAVED";
        saveButton.style.background = "#48dc00";

        setTimeout(() => {
          containerDiv.remove();
        }, 800);

        console.log("Set Gemini API Key");
      });
    });

    inputField.addEventListener("keypress", (e) => {
      if (e.key === "Enter") {
        saveButton.click();
      }
    });
  });

  // Open full page
  openButton.addEventListener("click", function () {
    chrome.tabs.create({ url: chrome.runtime.getURL("index.html") });
  });
});

function insertNoteIntoActiveTab(note) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs.length > 0) {
      chrome.tabs.sendMessage(tabs[0].id, {
        action: "pasteValue",
        value: note,
      });
    }
  });
}
