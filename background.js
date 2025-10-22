import { getDate } from "./src/util.js";

// first time initialisation
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    // default note on first install
    notes: {
      0: {
        noteText: `Wow, your first BlockNote! In a new tab type "/" followed by First Note to paste it. Sttings can be customised in the browser toolbar.`,
        noteIndex: 0,
        date: getDate(),
        displayIndex: 0,
        noteName: "First BlockNote",
      },
    },
  });
  chrome.storage.local.set({ noteCounter: 1 });
  chrome.storage.local.set({ settings: { useSlashWithCtrl: false, key: '' } }); // Nested setting
  chrome.storage.local.set({ isInstalled: false });
  console.log("Extension installed successfully.");
});

chrome.action.onClicked.addListener(async (tab) => {
  console.log("Blocknote Extension Action.");
  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const oldIframe = document.getElementById("cm-frame");
      if (oldIframe) {
        oldIframe.remove();
        return;
      }

      const iframe = document.createElement("iframe");
      iframe.id = "cm-frame";
      iframe.style.cssText = `
          top: 10px;
          right: -400px; /* Start off-screen */
          width: 370px;
          height: 785px;
          z-index: 2147483650;
          border: none;
          position: fixed;
          border-radius: 1rem;
          overflow: hidden;
          background: none;
          transition: right 0.3s ease; /* Add transition for animation */
        `;
      iframe.src = chrome.runtime.getURL("popup.html"); // Ensure this file is accessible

      // Append the iframe first to make it part of the document
      document.body.appendChild(iframe);

      // Trigger the animation by changing the right property
      setTimeout(() => {
        iframe.style.right = "10px"; // Move into view
      }, 10); // Short delay to allow the iframe to be rendered first
    },
  });
});
