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
    slashCheckbox.checked = data.settings?.useSlashWithCtrl ?? false;
  });

  // Toggle slash command mode
  slashCheckbox.addEventListener("change", () => {
    const isEnabled = slashCheckbox.checked;
    chrome.storage.local.get("settings", (data) => {
      const updatedSettings = {
        ...data.settings,
        useSlashWithCtrl: isEnabled,
      };
      chrome.storage.local.set({ settings: updatedSettings });
    });
  });

  // Info button - open Gemini docs
  infoButton.addEventListener("click", () => {
    window.open("https://ai.google.dev/", "_blank");
  });

  // Setup API key
  setKeyButton.addEventListener("click", () => {
    // Check if container already exists, if so, remove it
    const existingContainer = document.querySelector(".oai-key-container");
    if (existingContainer) {
      existingContainer.remove();
      return;
    }

    const containerDiv = document.createElement("div");
    containerDiv.classList.add("oai-key-container");

    const inputField = document.createElement("input");
    inputField.type = "text";
    inputField.placeholder = "Enter Gemini API Key";

    const saveButton = document.createElement("button");
    saveButton.textContent = "SAVE";

    containerDiv.appendChild(inputField);
    containerDiv.appendChild(saveButton);

    // Insert after AI card
    aiCard.parentNode.insertBefore(containerDiv, aiCard.nextSibling);

    // Focus the input
    setTimeout(() => inputField.focus(), 100);

    saveButton.addEventListener("click", () => {
      const AIKEY = inputField.value.trim();
      if (!AIKEY) {
        inputField.style.borderColor = "#ff6b6b";
        setTimeout(() => {
          inputField.style.borderColor = "#05060f";
        }, 500);
        return;
      }

      chrome.storage.local.get("settings", (data) => {
        const updatedSettings = {
          ...data.settings,
          key: AIKEY,
        };
        chrome.storage.local.set({ settings: updatedSettings });

        // Show success feedback
        saveButton.textContent = "✓ SAVED";
        saveButton.style.background = "#48dc00";

        setTimeout(() => {
          containerDiv.remove();
        }, 800);

        console.log("Set Gemini API Key");
      });
    });

    // Save on Enter key
    inputField.addEventListener("keypress", (e) => {
      if (e.key === "Enter") {
        saveButton.click();
      }
    });
  });

  // Open full page on home click
  openButton.addEventListener("click", function () {
    chrome.tabs.create({});
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
