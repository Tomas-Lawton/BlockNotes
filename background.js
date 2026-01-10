import { getDate } from "./src/util.js";

// first time initialisation
chrome.runtime.onInstalled.addListener(() => {
  const date = getDate();

  // 3 colors for starter notes
  const COLOR_PURPLE = "#c4b5fd";
  const COLOR_TEAL = "#5eead4";
  const COLOR_CORAL = "#fda4af";

  chrome.storage.local.set({
    // 6 starter notes - renders newest first, so last in object appears first
    notes: {
      // FIRST in object = appears LAST visually
      0: {
        noteText: `Thanks for {{reason}}! Really appreciate your help on this.`,
        noteIndex: 0,
        date: date,
        displayIndex: 0,
        noteName: "Thank You",
        noteColor: COLOR_TEAL,
        usageCount: 0,
        lastUsedAt: null,
      },
      1: {
        noteText: `Hi {{name}},

Here's the snippet for {{feature}}:

\`\`\`javascript
const data = async () => {
  // TODO: implement
};
\`\`\`

Let me know if you have questions!`,
        noteIndex: 1,
        date: date,
        displayIndex: 1,
        noteName: "Code Share",
        noteColor: COLOR_TEAL,
        usageCount: 0,
        lastUsedAt: null,
      },
      2: {
        noteText: `Hi {{name}},

Following up on {{about}}. Would {{time}} work for a quick call?

Let me know what works best for you.`,
        noteIndex: 2,
        date: date,
        displayIndex: 2,
        noteName: "Follow Up",
        noteColor: COLOR_PURPLE,
        usageCount: 0,
        lastUsedAt: null,
      },
      3: {
        noteText: `Hi {{name}},

I came across {{company}} and was impressed by what you're building. I'd love to connect and share some ideas that might be valuable.

Would you be open to a brief chat?`,
        noteIndex: 3,
        date: date,
        displayIndex: 3,
        noteName: "Cold Outreach",
        noteColor: COLOR_PURPLE,
        usageCount: 0,
        lastUsedAt: null,
      },
      4: {
        noteText: `Star notes to add to Favorites. Use the Tags page to organize notes visually. Add an API key in Settings to auto-name notes. Use the tag view to manage your notes in groups.`,
        noteIndex: 4,
        date: date,
        displayIndex: 4,
        noteName: "Pro Tips",
        noteColor: COLOR_CORAL,
        usageCount: 0,
        lastUsedAt: null,
      },
      // Getting Started - LAST so appears FIRST
      5: {
        noteText: `Type "/" in any text field to search for a note and insert anywhere. Or, highlight text and click Note button to save it to your notes.`,
        noteIndex: 5,
        date: date,
        displayIndex: 5,
        noteName: "Getting Started",
        noteColor: COLOR_CORAL,
        usageCount: 0,
        lastUsedAt: null,
      },
    },
  });
  chrome.storage.local.set({ noteCounter: 6 });
  chrome.storage.local.set({ settings: { useShiftSlash: false, autoFillPlaceholders: false, autonameSelection: false, key: '' } });
  chrome.storage.local.set({ isInstalled: false });
  chrome.storage.local.set({ walkthroughComplete: false });
  console.log("Extension installed successfully.");
});

// Open BlockNotes in a new tab when extension icon is clicked
chrome.action.onClicked.addListener(async () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("index.html") });
});
