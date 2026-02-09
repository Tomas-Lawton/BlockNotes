// Content script for BlockNotes Chrome Extension
// Updated: localStorage support + improved positioning

// ============================================
// STATE
// ============================================
const state = {
  lastFocusedElement: null,
  popupContainer: null,
  selectedIndex: 0,
  isPopupOpen: false,
  lastSlashDetected: false,
  previousValue: "",
  notes: {},
  isDragging: false,
  dragStartX: 0,
  dragStartY: 0,
  popupStartX: 0,
  popupStartY: 0,
  quickSaveButton: null,
  selectedText: "",
  isSaving: false, // Prevent button recreation during save
  savedRange: null, // Save selection range for contenteditable insertion
  isPasting: false, // Prevent popup reopen during paste
  crossFrameSource: null, // Source window for cross-frame popup requests
  isCrossFramePopup: false, // Whether current popup was triggered from a child frame
  googleDocsIframeDoc: null, // Reference to Google Docs iframe document for cleanup
};

// ============================================
// CROSS-FRAME MESSAGING (for Google Docs/Drive iframes)
// ============================================
const BLOCKNOTES_MESSAGE_TYPE = "BLOCKNOTES_CROSS_FRAME";

// Check if we're in an iframe that should delegate popup to parent
function shouldDelegateToParent() {
  // Not in an iframe
  if (window === window.top) return false;

  // Check if we're in a Google Docs text input iframe
  const isGoogleDocsInputIframe =
    window.location.hostname.includes("docs.google.com") ||
    document.body?.classList?.contains("docs-texteventtarget") ||
    document.querySelector(".docs-texteventtarget");

  // Check if we're in a tiny/hidden iframe (Google Docs uses these for text input)
  const isTinyIframe = window.innerWidth < 100 || window.innerHeight < 100;

  // Check if parent is Google Docs/Drive
  let parentIsGoogleDocs = false;
  try {
    parentIsGoogleDocs =
      window.parent.location.hostname.includes("docs.google.com") ||
      window.parent.location.hostname.includes("drive.google.com");
  } catch (e) {
    // Cross-origin, can't check - but if we're in a small iframe, likely should delegate
  }

  return isGoogleDocsInputIframe || isTinyIframe || parentIsGoogleDocs;
}

// Send message to parent frame to show popup
function requestPopupInParent() {
  try {
    window.parent.postMessage(
      {
        type: BLOCKNOTES_MESSAGE_TYPE,
        action: "showPopup",
      },
      "*",
    );
    return true;
  } catch (e) {
    return false;
  }
}

// Handle messages from child frames
function handleCrossFrameMessage(event) {
  // Validate message
  if (!event.data || event.data.type !== BLOCKNOTES_MESSAGE_TYPE) return;

  if (event.data.action === "showPopup") {
    // Store reference to source window for sending note back
    state.crossFrameSource = event.source;

    // Load notes and show popup in this (parent) frame
    chrome.storage.local.get(["settings", "notes"], (data) => {
      if (chrome.runtime.lastError) return;
      state.notes = data.notes || {};
      state.lastFocusedElement = null; // No specific element, will center popup
      state.isCrossFramePopup = true; // Flag to handle note selection differently
      showPopup();
    });
  }

  if (event.data.action === "insertNote") {
    // Received note text from parent frame - insert it
    const noteText = event.data.noteText;

    // Try to insert into the last focused element
    if (state.lastFocusedElement) {
      insertTextIntoElement(state.lastFocusedElement, noteText);
    } else {
      // Fallback: try to paste using execCommand
      document.execCommand("insertText", false, noteText);
    }
  }
}

// Helper to insert text into an element (extracted for cross-frame use)
function insertTextIntoElement(element, text) {
  if (!element) return false;

  try {
    if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
      const start = element.selectionStart || 0;
      const end = element.selectionEnd || 0;
      const value = element.value || "";
      element.value = value.substring(0, start) + text + value.substring(end);
      element.selectionStart = element.selectionEnd = start + text.length;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    } else if (element.isContentEditable) {
      element.focus();
      document.execCommand("insertText", false, text);
      return true;
    }
  } catch (e) {
    // Insertion failed
  }
  return false;
}

// Send selected note to child frame
function sendNoteToChildFrame(noteText) {
  if (state.crossFrameSource) {
    try {
      state.crossFrameSource.postMessage(
        {
          type: BLOCKNOTES_MESSAGE_TYPE,
          action: "insertNote",
          noteText: noteText,
        },
        "*",
      );
      return true;
    } catch (e) {
      // Failed to send note to child frame
    }
  }
  return false;
}

// ============================================
// AI AUTO-NAMING
// ============================================
async function generateNoteName(noteText, provider, model, apiKey, customBaseUrl = "") {
  const prompt = `Suggest a concise and meaningful title for the following note content:\n"${noteText}".
    IT IS VERY CRITICALLY IMPORTANT YOU ANSWER WITH ONLY ONE NAME.
    Do your best to capture what the note actually contains so it is easy to remember what it was about later.
    Maximum 5 words suggested name.
    If the note text is not understandable just combine a random color with a random animal and a random 2-digit number.
    IT IS VERY CRITICALLY IMPORTANT YOU ANSWER DIRECTLY WITH ONLY ONE NAME.`;

  const stripQuotes = (s) => s.replace(/^["'`]+|["'`]+$/g, '');

  try {
    switch (provider) {
      case "gemini": {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-goog-api-key": apiKey,
            },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
            }),
          },
        );
        const data = await response.json();
        if (!response.ok || !data.candidates || !data.candidates[0]) {
          throw new Error("Gemini API error");
        }
        return stripQuotes(data.candidates[0].content.parts[0].text.trim());
      }

      case "openai": {
        const response = await fetch(
          "https://api.openai.com/v1/chat/completions",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model: model,
              messages: [{ role: "user", content: prompt }],
              max_tokens: 20,
              temperature: 0.7,
            }),
          },
        );
        const data = await response.json();
        if (!response.ok || !data.choices || !data.choices[0]) {
          throw new Error("OpenAI API error");
        }
        return stripQuotes(data.choices[0].message.content.trim());
      }

      case "anthropic": {
        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true",
          },
          body: JSON.stringify({
            model: model,
            max_tokens: 20,
            messages: [{ role: "user", content: prompt }],
          }),
        });
        const data = await response.json();
        if (!response.ok || !data.content || !data.content[0]) {
          throw new Error("Anthropic API error");
        }
        return stripQuotes(data.content[0].text.trim());
      }

      case "groq": {
        const response = await fetch(
          "https://api.groq.com/openai/v1/chat/completions",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model: model,
              messages: [{ role: "user", content: prompt }],
              max_tokens: 20,
              temperature: 0.7,
            }),
          },
        );
        const data = await response.json();
        if (!response.ok || !data.choices || !data.choices[0]) {
          throw new Error("Groq API error");
        }
        return stripQuotes(data.choices[0].message.content.trim());
      }

      case "custom": {
        const baseUrl = customBaseUrl.replace(/\/+$/, '');
        const endpoint = `${baseUrl}/v1/chat/completions`;
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: model,
            messages: [{ role: "user", content: prompt }],
            max_tokens: 20,
            temperature: 0.7,
          }),
        });
        const data = await response.json();
        if (!response.ok || !data.choices || !data.choices[0]) {
          throw new Error("Custom API error");
        }
        return stripQuotes(data.choices[0].message.content.trim());
      }

      default:
        throw new Error(`Unknown provider: ${provider}`);
    }
  } catch (error) {
    console.error(`BlockNotes: Error with ${provider}:`, error);
    throw error;
  }
}

// ============================================
// INIT
// ============================================
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

function init() {
  // Load font
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href =
    "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap";
  document.head.appendChild(link);

  // Setup listeners
  document.addEventListener("focus", handleFocus, true);
  document.addEventListener("input", handleInput, true);
  document.addEventListener("keydown", handleGlobalKeydown);
  document.addEventListener("keyup", handleGlobalKeyup);
  document.addEventListener("mouseup", handleTextSelection);
  document.addEventListener("mousedown", handleMouseDown);
  chrome.runtime.onMessage.addListener(handleMessage);

  // Listen for cross-frame messages (for Google Docs/Drive iframe popup delegation)
  window.addEventListener("message", handleCrossFrameMessage);

  // Log iframe context for debugging
  const inIframe = window !== window.top;
  const isSandboxed =
    document.origin === "null" || document.origin === "about:blank";
  const isGoogleDocs = window.location.hostname.includes("docs.google.com");

}

// ============================================
// FOCUS TRACKING
// ============================================
function handleFocus(event) {
  if (isInput(event.target)) {
    state.lastFocusedElement = event.target;
    state.previousValue = getValue(event.target);
  }
}

function isInput(el) {
  if (!el) return false;

  // Standard inputs
  if (el.tagName === "TEXTAREA") return true;
  if (
    el.tagName === "INPUT" &&
    ["text", "search", "email", "url", ""].includes(el.type || "")
  ) {
    return true;
  }
  if (el.isContentEditable) return true;

  // Check for contenteditable attribute explicitly (Google Docs uses this)
  if (el.getAttribute && el.getAttribute("contenteditable") === "true") {
    return true;
  }

  // Check for common rich text editor classes
  if (el.className && typeof el.className === "string") {
    const editorClasses = [
      "ql-editor",
      "tox-edit-area",
      "kix-lineview",
      "kix-cursor",
      "kix-page",
      "kix-appview-editor",
      "docs-texteventtarget",
      "docs-texteventtarget-iframe",
      // Gmail compose body
      "Am",
      "editable",
      "gmail_default",
    ];
    if (editorClasses.some((cls) => el.className.includes(cls))) {
      return true;
    }
  }

  // Check for role="textbox"
  if (el.getAttribute && el.getAttribute("role") === "textbox") {
    return true;
  }

  // Check ARIA labels for Google Docs
  if (el.getAttribute) {
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel && ariaLabel.toLowerCase().includes("document")) {
      return true;
    }
    // Gmail compose body aria-label
    if (ariaLabel && ariaLabel.toLowerCase().includes("message body")) {
      return true;
    }
  }

  // Gmail compose - check for specific Gmail elements (multiple selectors for robustness)
  if (el.closest && el.closest('[aria-label="Message Body"]')) return true;
  if (el.closest && el.closest('[aria-label="Message body"]')) return true;
  if (el.closest && el.closest('.editable[contenteditable="true"]'))
    return true;
  if (el.closest && el.closest('[role="textbox"][contenteditable="true"]'))
    return true;
  if (
    el.closest &&
    el.closest('div[contenteditable="true"][aria-multiline="true"]')
  )
    return true;
  if (el.closest && el.closest('[g_editable="true"]')) return true; // Gmail specific
  if (el.closest && el.closest(".Am")) return true; // Gmail compose area class
  if (el.closest && el.closest('[contenteditable="true"]')) return true;

  return false;
}

// ============================================
// INPUT DETECTION
// ============================================
function handleInput(event) {
  // Better paste detection: check inputType property for modern browsers
  const isPasteEvent = event.inputType === 'insertFromPaste' || 
                       event.inputType === 'insertReplacementText' ||
                       event.data?.length > 1; // Multiple characters pasted at once
  
  // Ignore input events during paste OR if it's a paste event
  if (state.isPasting || isPasteEvent) return;

  if (!isInput(event.target)) return;

  const value = getValue(event.target);
  const previousValue = state.previousValue;
  state.previousValue = value;

  const lastChar = value[value.length - 1];
  const prevLastChar = previousValue[previousValue.length - 1];

  // --- Close popup if space typed right after slash OR backspace removes slash ---
  if (state.isPopupOpen) {
    const lastSlashIndex = value.lastIndexOf("/");
    const lastSpaceIndex = value.lastIndexOf(" ");

    // Close if space typed right after slash
    if (lastSlashIndex >= 0 && lastSpaceIndex === lastSlashIndex + 1) {
      closePopup();
      return;
    }

    // Close if slash was removed (backspace)
    // Check if previous value had "/" but current doesn't
    if (previousValue.includes("/") && !value.includes("/")) {
      closePopup();
      return;
    }

    // Close if no slash found at all
    if (!value.includes("/")) {
      closePopup();
      return;
    }

    return;
  }

  // --- Detect fresh slash ---
  // Count slashes to detect if a new one was added (works even if not at end)
  const currentSlashCount = (value.match(/\//g) || []).length;
  const prevSlashCount = (previousValue.match(/\//g) || []).length;
  const newSlashAdded = currentSlashCount > prevSlashCount;

  // Also check the simple case: "/" typed at end
  const justTypedSlash = lastChar === "/" && prevLastChar !== "/";

  // Fallback: if previousValue is empty/stale but current value ends with "/", treat as new slash
  const fallbackSlashDetection = !previousValue && lastChar === "/";

  if (newSlashAdded || justTypedSlash || fallbackSlashDetection) {
    state.lastSlashDetected = true;
    state.lastFocusedElement = event.target;

    // Check if we should delegate to parent frame (e.g., Google Docs iframe)
    if (shouldDelegateToParent()) {
      requestPopupInParent();
      return;
    }

    setTimeout(() => {
      chrome.storage.local.get(["settings", "notes"], (data) => {
        state.notes = data.notes || {};
        showPopup();
      });
    }, 50);
  }
}

// Handle special keys
function handleGlobalKeydown(event) {
  const isGoogleDocs = window.location.hostname.includes("docs.google.com");

  // Special handler for "/" key - especially for Gmail and contenteditable elements
  if (
    event.key === "/" &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !state.isPopupOpen &&
    !state.isPasting
  ) {
    const target = event.target;
    const isGmail = window.location.hostname.includes("mail.google.com");

    // Find the actual contenteditable container (Gmail nests divs inside it)
    let contentEditableContainer =
      target.closest?.('[contenteditable="true"]') ||
      (target.isContentEditable ? target : null) ||
      (target.parentElement?.isContentEditable ? target.parentElement : null);

    // For Gmail, also check the active element since target might be a nested div
    if (!contentEditableContainer && document.activeElement) {
      contentEditableContainer =
        document.activeElement.closest?.('[contenteditable="true"]') ||
        (document.activeElement.isContentEditable
          ? document.activeElement
          : null);
    }

    // Gmail-specific: Check for Gmail's compose body more aggressively
    const gmailComposeBody =
      isGmail &&
      (target.closest?.('[aria-label="Message Body"]') ||
        target.closest?.('[aria-label="Message body"]') ||
        target.closest?.('[g_editable="true"]') ||
        target.closest?.('.editable[contenteditable="true"]') ||
        target.closest?.(".Am.Al.editable") ||
        target.closest?.('div[aria-multiline="true"]') ||
        document.activeElement?.closest?.('[aria-label="Message Body"]') ||
        document.activeElement?.closest?.('[aria-label="Message body"]') ||
        document.activeElement?.closest?.('[g_editable="true"]') ||
        document.activeElement?.closest?.('.editable[contenteditable="true"]'));

    // For Gmail, be more permissive - if we're on Gmail and "/" is pressed in any div, try to open
    const isInGmailCompose =
      isGmail &&
      (contentEditableContainer ||
        gmailComposeBody ||
        target.tagName === "DIV" ||
        target.closest?.(".editable") ||
        target.closest?.('[role="textbox"]') ||
        target.closest?.(".Am") ||
        target.closest?.(".aoI") || // Gmail compose container
        document.activeElement?.isContentEditable ||
        document.activeElement?.closest?.('[contenteditable="true"]'));

    // For other sites, use standard contenteditable detection
    const isInContentEditable =
      contentEditableContainer || target.isContentEditable;

    if (isInGmailCompose || isInContentEditable) {
      // Use the Gmail compose body, contenteditable container, or the target
      const focusElement =
        gmailComposeBody ||
        contentEditableContainer ||
        document.activeElement ||
        target;

      state.lastSlashDetected = true;
      state.lastFocusedElement = focusElement;

      // Check if we should delegate to parent frame (e.g., Google Docs iframe)
      if (shouldDelegateToParent()) {
        requestPopupInParent();
        return;
      }

      setTimeout(() => {
        try {
          chrome.storage.local.get(["settings", "notes"], (data) => {
            if (chrome.runtime.lastError) return;
            state.notes = data.notes || {};
            showPopup();
          });
        } catch (error) {
          // Extension context invalidated
        }
      }, 100);
    }

    // Google Docs specific handling - it uses a hidden iframe for text input
    if (isGoogleDocs) {
      // Try to find the text event target (Google Docs uses this for text input)
      const docsTextTarget = document.querySelector(
        ".docs-texteventtarget-iframe",
      );
      const docsEditor = document.querySelector(".kix-appview-editor");
      const docsPage = document.querySelector(".kix-page");

      // If we haven't already triggered the popup via contenteditable detection
      if (!isInContentEditable && !state.isPopupOpen) {
        // Use whichever element we can find
        const focusElement = docsEditor || docsPage || target;

        state.lastSlashDetected = true;
        state.lastFocusedElement = focusElement;

        // Check if we should delegate to parent frame (e.g., Google Docs iframe)
        if (shouldDelegateToParent()) {
          requestPopupInParent();
          return;
        }

        setTimeout(() => {
          try {
            chrome.storage.local.get(["settings", "notes"], (data) => {
              if (chrome.runtime.lastError) return;
              state.notes = data.notes || {};
              showPopup();
            });
          } catch (error) {
            // Extension context invalidated
          }
        }, 100);
      }
    }
  }

  // Handle Ctrl/Meta + Shift + / as a force-open shortcut (works everywhere)
  if (event.key === "/" && (event.ctrlKey || event.metaKey) && event.shiftKey) {
    event.preventDefault();

    // Find focused input or use last focused
    let target = document.activeElement;

    // If no valid input focused, try to find one in the document
    if (!isInput(target)) {
      // Try common editor selectors for Google Docs, etc.
      const selectors = [
        '[contenteditable="true"]',
        '[role="textbox"]',
        "textarea:not([disabled])",
        'input[type="text"]:not([disabled])',
        ".kix-lineview", // Google Docs
        ".kix-cursor", // Google Docs cursor area
        ".kix-page", // Google Docs page
        ".docs-texteventtarget", // Google Docs text target
        ".docs-texteventtarget-iframe", // Google Docs iframe
        '[aria-label*="Document content"]', // Google Docs ARIA label
        '[aria-label*="document"]',
        ".kix-appview-editor", // Google Docs editor
      ];

      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element && isInput(element)) {
          target = element;
          target.focus();
          break;
        }
      }
    }

    if (isInput(target)) {
      state.lastFocusedElement = target;

      if (state.isPopupOpen) {
        closePopup();
      } else {
        // Check if we should delegate to parent frame (e.g., Google Docs iframe)
        if (shouldDelegateToParent()) {
          requestPopupInParent();
          return;
        }

        try {
          chrome.storage.local.get(["settings", "notes"], (data) => {
            if (chrome.runtime.lastError) return;
            state.notes = data.notes || {};
            showPopup();
          });
        } catch (error) {
          // Extension context invalidated
        }
      }
    } else {
      // If not in a valid input but in an iframe, try delegating to parent
      if (shouldDelegateToParent()) {
        requestPopupInParent();
        return;
      }
    }
    return;
  }

  if (state.isPopupOpen) {
    handlePopupKeydown(event);
  }
}

function handleGlobalKeyup(event) {
  if (event.key === "/") {
    state.lastSlashDetected = true;
  }
}

function getValue(el) {
  if (!el) return "";
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA"
    ? el.value
    : el.textContent;
}

// ============================================
// DRAG FUNCTIONALITY
// ============================================
function handleDragStart(event, header) {
  if (event.button !== 0) return;

  event.preventDefault();
  event.stopPropagation();

  state.isDragging = true;
  state.dragStartX = event.clientX;
  state.dragStartY = event.clientY;

  const rect = state.popupContainer.getBoundingClientRect();
  state.popupStartX = rect.left;
  state.popupStartY = rect.top;

  header.style.cursor = "grabbing";

  document.addEventListener("mousemove", handleDragMove);
  document.addEventListener("mouseup", handleDragEnd);
}

function handleDragMove(event) {
  if (!state.isDragging) return;

  const deltaX = event.clientX - state.dragStartX;
  const deltaY = event.clientY - state.dragStartY;

  const newX = state.popupStartX + deltaX;
  const newY = state.popupStartY + deltaY;

  state.popupContainer.style.left = `${newX}px`;
  state.popupContainer.style.top = `${newY}px`;
}

function handleDragEnd() {
  if (!state.isDragging) return;

  state.isDragging = false;

  // Restore cursor
  const header = state.popupContainer?.querySelector(".blocknotes-header");
  if (header) {
    header.style.cursor = "grab";
  }

  // Remove listeners
  document.removeEventListener("mousemove", handleDragMove);
  document.removeEventListener("mouseup", handleDragEnd);
}

function showPopup() {
  // Safety check: if isPopupOpen is true but container doesn't exist, reset state
  if (state.isPopupOpen && !state.popupContainer) {
    state.isPopupOpen = false;
  }

  if (state.isPopupOpen) return;

  // Allow showing popup even if no element is focused (will center it)
  const hasTarget = !!state.lastFocusedElement;
  const isGoogleDocs = window.location.hostname.includes("docs.google.com");

  // Save the current selection range for contenteditable elements (like Gmail)
  // This must happen BEFORE the popup steals focus
  const selection = window.getSelection();
  if (selection.rangeCount > 0) {
    state.savedRange = selection.getRangeAt(0).cloneRange();
  } else {
    state.savedRange = null;
  }

  state.isPopupOpen = true;
  state.selectedIndex = 0;
  state.popupSearchQuery = ""; // Track typed query for Google Docs (no input events)

  // Create popup
  const popup = document.createElement("div");
  popup.className = "blocknotes-popup";
  popup.style.cssText = getPopupStyles(hasTarget);

  // Create list
  const list = document.createElement("ul");
  list.className = "blocknotes-list";
  list.style.cssText = getListStyles();

  // Add minimalist title with close button
  const header = document.createElement("div");
  header.className = "blocknotes-header";
  header.style.cssText = `
    padding: 10px 14px;
    border-bottom: 1px solid #3f3f46;
    font-size: 11px;
    font-weight: 700;
    color: #fafafa;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    cursor: grab;
    user-select: none;
    background: linear-gradient(135deg, #3f3f46 0%, #27272a 100%);
    border-radius: 14px 14px 0 0;
    flex-shrink: 0;
  `;

  const title = document.createElement("span");
  title.textContent = "BlockNotes";

  const closeBtn = document.createElement("button");
  closeBtn.innerHTML = "×";
  closeBtn.style.cssText = `
    background: transparent;
    border: none;
    font-size: 20px;
    font-weight: 700;
    color: #94a3b8;
    cursor: pointer;
    padding: 0;
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    transition: all 0.15s ease;
    line-height: 1;
  `;

  closeBtn.addEventListener("mouseenter", () => {
    closeBtn.style.background = "#475569";
    closeBtn.style.color = "#f1f5f9";
  });

  closeBtn.addEventListener("mouseleave", () => {
    closeBtn.style.background = "transparent";
    closeBtn.style.color = "#94a3b8";
  });

  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    closePopup();
  });

  // Add drag functionality to header
  header.addEventListener("mousedown", (e) => handleDragStart(e, header));

  header.appendChild(title);
  header.appendChild(closeBtn);

  // Filter and sort toggle bar
  const filterBar = document.createElement("div");
  filterBar.style.cssText = `
    padding: 6px 10px;
    background: #27272a;
    display: flex;
    align-items: center;
    gap: 4px;
    border-bottom: 1px solid #3f3f46;
    flex-shrink: 0;
  `;

  // Initialize popup filter/sort state
  state.popupFilterType = "both";
  state.popupSortType = null;

  function createToggleBtn(label, group, value) {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.dataset.group = group;
    btn.dataset.value = value;
    btn.style.cssText = `
      padding: 3px 8px;
      border: 1px solid #3f3f46;
      border-radius: 6px;
      background: transparent;
      color: #94a3b8;
      font-size: 10px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s ease;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    `;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const isActive = btn.dataset.active === "true";
      // Deactivate all buttons in the same group
      filterBar.querySelectorAll(`button[data-group="${group}"]`).forEach((b) => {
        b.dataset.active = "false";
        b.style.background = "transparent";
        b.style.color = "#94a3b8";
        b.style.borderColor = "#3f3f46";
      });
      if (!isActive) {
        btn.dataset.active = "true";
        btn.style.background = "#334155";
        btn.style.color = "#f1f5f9";
        btn.style.borderColor = "#818cf8";
        if (group === "filter") state.popupFilterType = value;
        if (group === "sort") state.popupSortType = value;
      } else {
        if (group === "filter") state.popupFilterType = "both";
        if (group === "sort") state.popupSortType = null;
      }
      updateResults();
    });
    btn.addEventListener("mouseenter", () => {
      if (btn.dataset.active !== "true") {
        btn.style.background = "#334155";
        btn.style.color = "#e2e8f0";
      }
    });
    btn.addEventListener("mouseleave", () => {
      if (btn.dataset.active !== "true") {
        btn.style.background = "transparent";
        btn.style.color = "#94a3b8";
      }
    });
    return btn;
  }

  // Filter buttons
  filterBar.appendChild(createToggleBtn("Name", "filter", "name"));
  filterBar.appendChild(createToggleBtn("Content", "filter", "content"));

  // Divider
  const divider = document.createElement("span");
  divider.style.cssText = `
    width: 1px;
    height: 14px;
    background: #3f3f46;
    margin: 0 2px;
  `;
  filterBar.appendChild(divider);

  // Sort buttons
  filterBar.appendChild(createToggleBtn("Newest", "sort", "newest"));
  filterBar.appendChild(createToggleBtn("A-Z", "sort", "alpha"));

  popup.appendChild(header);
  popup.appendChild(filterBar);
  popup.appendChild(list);
  document.body.appendChild(popup);

  state.popupContainer = popup;

  // Setup listeners
  if (hasTarget) {
    state.lastFocusedElement.addEventListener("input", updateResults);
  }
  document.addEventListener("click", handleClickOutside);
  // Use window-level capture to intercept keys before Google Docs iframe
  window.addEventListener("keydown", handlePopupKeydown, true);

  // For Google Docs: also add listener to the iframe where typing happens
  if (isGoogleDocs) {
    const docsTextTarget = document.querySelector(
      ".docs-texteventtarget-iframe",
    );
    if (docsTextTarget) {
      try {
        const iframeDoc =
          docsTextTarget.contentDocument ||
          docsTextTarget.contentWindow?.document;
        if (iframeDoc) {
          iframeDoc.addEventListener("keydown", handlePopupKeydown, true);
          state.googleDocsIframeDoc = iframeDoc; // Save reference for cleanup
        }
      } catch (e) {
        // Could not access Google Docs iframe (cross-origin)
      }
    }
  }

  // Initial render
  updateResults();

  // Add styles
  addStyles();
}

function getPopupStyles(hasTarget = true) {
  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;
  const maxHeight = 400;
  const width = Math.min(380, viewportWidth - 40);
  const spacing = 8;

  // If no target element, center the popup
  if (!hasTarget) {
    return `
      position: fixed !important;
      width: ${width}px !important;
      background: #27272a !important;
      border: 1px solid #3f3f46 !important;
      border-radius: 16px !important;
      box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5), 0 4px 12px rgba(0, 0, 0, 0.3) !important;
      z-index: 2147483647 !important;
      overflow: hidden !important;
      max-height: ${maxHeight}px !important;
      top: 50% !important;
      left: 50% !important;
      transform: translate(-50%, -50%) !important;
      display: flex !important;
      flex-direction: column !important;
      visibility: visible !important;
      opacity: 1 !important;
    `;
  }

  const rect = state.lastFocusedElement.getBoundingClientRect();

  // Always start from the input's actual position
  let cursorX = rect.left;
  let cursorY = rect.bottom; // Use bottom of input as reference

  // Try to get precise cursor position for inputs
  if (state.lastFocusedElement.tagName === "INPUT") {
    const el = state.lastFocusedElement;
    const cursorPos = el.selectionStart || 0;

    // Measure horizontal cursor position
    const span = document.createElement("span");
    span.style.cssText = `
      position: absolute;
      visibility: hidden;
      white-space: pre;
      font: ${window.getComputedStyle(el).font};
    `;
    span.textContent = el.value.substring(0, cursorPos);
    document.body.appendChild(span);
    const spanWidth = span.getBoundingClientRect().width;
    document.body.removeChild(span);

    const paddingLeft = parseInt(
      window.getComputedStyle(el).paddingLeft || "0",
    );
    // cursorX = rect.left + spanWidth + paddingLeft;
    cursorX = rect.left;
  }

  // Default: position below input
  let top = cursorY + spacing;
  let left = cursorX;

  // Check if there's enough space below
  const spaceBelow = viewportHeight - top;

  // If not enough space below, position directly above input
  if (spaceBelow < 200) {
    // Position so bottom of popup touches top of input
    top = rect.top - 130; // Just above input with small spacing

    // If that's too high, keep it below
    if (top < 20) {
      top = cursorY + spacing;
    }
  }

  // Keep popup in horizontal bounds
  if (left + width > viewportWidth - 20) {
    left = viewportWidth - width - 20;
  }
  if (left < 20) {
    left = 20;
  }

  return `
    position: fixed !important;
    top: ${top}px !important;
    left: ${left}px !important;
    width: ${width}px !important;
    max-height: ${maxHeight}px !important;
    background: #27272a !important;
    border: 1px solid #3f3f46 !important;
    border-radius: 16px !important;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5), 0 4px 12px rgba(0, 0, 0, 0.3) !important;
    z-index: 2147483647 !important;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif !important;
    overflow: hidden !important;
    transition: opacity 0.15s ease !important;
    display: flex !important;
    flex-direction: column !important;
    visibility: visible !important;
    opacity: 1 !important;
  `;
}

function getListStyles() {
  return `
    margin: 0;
    padding: 3px;
    list-style: none;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  `;
}

// ============================================
// UPDATE & RENDER
// ============================================
// function updateResults() {
//   if (!state.popupContainer) return;

//   const list = state.popupContainer.querySelector(".blocknotes-list");
//   if (!list) return;

//   const query = extractQuery();
//   const matches = filterNotes(query);

//   renderResults(list, matches);
// }

function updateResults() {
  if (!state.popupContainer) return;

  const list = state.popupContainer.querySelector(".blocknotes-list");
  if (!list) return;

  const query = extractQuery();
  const filterType = state.popupFilterType || "both";
  const sortType = state.popupSortType || null;
  const matches = filterNotes(query, filterType, sortType);

  // Reset selected index to 0 when search query changes
  state.selectedIndex = 0;

  renderResults(list, matches, query);

  // Auto-scroll to the first result if there are any matches
  if (matches.length > 0 && list.children.length > 0) {
    list.children[0].scrollIntoView({ block: "nearest" });
  }
}

function extractQuery() {
  // For Google Docs, use tracked query since standard input events don't fire
  if (
    window.location.hostname.includes("docs.google.com") &&
    state.popupSearchQuery !== undefined
  ) {
    return state.popupSearchQuery;
  }

  const value = getValue(state.lastFocusedElement);
  const lastSlash = value.lastIndexOf("/");

  // Return everything after the last slash, keep spaces and numbers
  if (lastSlash >= 0) {
    return value.substring(lastSlash + 1).trim();
  }
  return "";
}

function filterNotes(query, filterType = "both", sortType = null) {
  // Normalize query for better matching
  const normalizedQuery = query.toLowerCase();

  return Object.values(state.notes)
    .filter((note) => {
      if (!normalizedQuery) return true;

      const name = (note.noteName || "").toLowerCase();
      const text = (note.noteText || "").toLowerCase();

      // Match based on filter type
      if (filterType === "name") return name.includes(normalizedQuery);
      if (filterType === "content") return text.includes(normalizedQuery);
      return name.includes(normalizedQuery) || text.includes(normalizedQuery);
    })
    .sort((a, b) => {
      // If an explicit sort is selected, use it
      if (sortType === "newest") {
        return (b.timestamp || 0) - (a.timestamp || 0);
      }
      if (sortType === "alpha") {
        const aName = (a.noteName || "").toLowerCase();
        const bName = (b.noteName || "").toLowerCase();
        return aName.localeCompare(bName);
      }

      // When no search query, sort by usage count (most used first)
      if (!normalizedQuery) {
        const aUsage = a.usageCount || 0;
        const bUsage = b.usageCount || 0;
        if (aUsage !== bUsage) return bUsage - aUsage;
        // Tiebreaker: most recently used
        const aLastUsed = a.lastUsedAt || 0;
        const bLastUsed = b.lastUsedAt || 0;
        return bLastUsed - aLastUsed;
      }

      const aName = (a.noteName || "").toLowerCase();
      const bName = (b.noteName || "").toLowerCase();
      const aText = (a.noteText || "").toLowerCase();
      const bText = (b.noteText || "").toLowerCase();

      // Prioritize exact name matches
      const aNameMatch = aName.includes(normalizedQuery);
      const bNameMatch = bName.includes(normalizedQuery);

      if (aNameMatch && !bNameMatch) return -1;
      if (!aNameMatch && bNameMatch) return 1;

      // Then prioritize name matches that start with query
      const aNameStarts = aName.startsWith(normalizedQuery);
      const bNameStarts = bName.startsWith(normalizedQuery);

      if (aNameStarts && !bNameStarts) return -1;
      if (!aNameStarts && bNameStarts) return 1;

      // Finally by usage count
      return (b.usageCount || 0) - (a.usageCount || 0);
    });
}

function renderResults(list, matches, query = "") {
  list.innerHTML = "";

  if (matches.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "No notes found";
    empty.style.cssText = `
      padding: 16px;
      text-align: center;
      color: #94a3b8;
      font-size: 14px;
    `;
    list.appendChild(empty);
    return;
  }

  const hasQuery = query.trim().length > 0;

  // Split into recently used and other notes when no search query
  let recentlyUsed = [];
  let otherNotes = [];
  if (!hasQuery) {
    recentlyUsed = matches.filter((n) => (n.usageCount || 0) > 0);
    otherNotes = matches.filter((n) => (n.usageCount || 0) === 0);
  }

  // Helper to create a section header
  function addSectionHeader(text) {
    const header = document.createElement("li");
    header.textContent = text;
    header.style.cssText = `
      padding: 6px 10px 4px;
      font-size: 10px;
      font-weight: 700;
      color: #64748b;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      pointer-events: none;
      user-select: none;
    `;
    header.dataset.sectionHeader = "true";
    list.appendChild(header);
  }

  // Track selectable item index (excludes headers)
  let selectableIndex = 0;

  function addNoteItem(note) {
    const li = document.createElement("li");
    li.className = "blocknotes-item";

    const name = note.noteName || `Note ${(note.displayIndex || 0) + 1}`;
    const rawPreview =
      note.noteText.length > 50
        ? note.noteText.substring(0, 50) + "..."
        : note.noteText;
    const noteColor = note.noteColor || "#c4b5fd";
    const placeholders = extractPlaceholders(note.noteText);
    const hasPlaceholders = placeholders.length > 0;

    // Build placeholder badge
    const placeholderBadge = hasPlaceholders
      ? `<span style="font-size: 9px; padding: 1px 5px; background: #334155; color: #818cf8; border-radius: 4px; font-weight: 600; margin-left: 4px; flex-shrink: 0;">{ }</span>`
      : "";

    // Highlight {{placeholders}} in preview text
    const previewHtml = escapeHtml(rawPreview).replace(
      /\{\{([^}]+)\}\}/g,
      '<span style="color: #818cf8; font-weight: 600;">{{$1}}</span>'
    );

    li.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 2px;">
        <span style="width: 10px; height: 10px; border-radius: 3px; background: ${noteColor}; flex-shrink: 0;"></span>
        <span style="font-weight: 600; font-size: 13px; color: #f1f5f9;">${escapeHtml(name)}</span>
        ${placeholderBadge}
      </div>
      <div style="font-size: 12px; color: #94a3b8; line-height: 1.3; margin-left: 18px;">${previewHtml}</div>
    `;

    const currentIndex = selectableIndex;
    li.style.cssText = getItemStyles(currentIndex === state.selectedIndex);

    li.addEventListener("mouseenter", () => selectItem(currentIndex));
    li.addEventListener("click", () => {
      // Save state before closePopup clears it
      const savedElement = state.lastFocusedElement;
      const savedRange = state.savedRange;
      // Close popup BEFORE handling note insertion to prevent focus conflicts
      closePopup();
      // Restore state for handleNoteInsertion
      state.lastFocusedElement = savedElement;
      state.savedRange = savedRange;
      handleNoteInsertion(note.noteText);
      incrementNoteUsage(note.noteIndex);
    });

    list.appendChild(li);
    selectableIndex++;
  }

  if (!hasQuery && recentlyUsed.length > 0) {
    addSectionHeader("Recently Used");
    recentlyUsed.forEach(addNoteItem);
    if (otherNotes.length > 0) {
      addSectionHeader("All Notes");
      otherNotes.forEach(addNoteItem);
    }
  } else {
    matches.forEach(addNoteItem);
  }

  // Ensure selected is visible
  const selectableItems = list.querySelectorAll(".blocknotes-item");
  const selected = selectableItems[state.selectedIndex];
  if (selected) {
    selected.scrollIntoView({ block: "nearest" });
  }
}

function getItemStyles(isSelected) {
  return `
    padding: 7px 10px;
    margin: 1px 0;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.15s ease;
    background: ${isSelected ? "#334155" : "#1e293b"};
    border-left: ${isSelected ? "2px solid #818cf8" : "2px solid transparent"};
  `;
}

function selectItem(index) {
  state.selectedIndex = index;
  const list = state.popupContainer?.querySelector(".blocknotes-list");
  if (!list) return;

  const selectableItems = list.querySelectorAll(".blocknotes-item");
  selectableItems.forEach((item, i) => {
    item.style.cssText = getItemStyles(i === index);
  });
}

function handlePopupKeydown(event) {
  if (!state.popupContainer) return;

  const list = state.popupContainer.querySelector(".blocknotes-list");
  const selectableItems = list?.querySelectorAll(".blocknotes-item") || [];
  const max = selectableItems.length - 1;

  switch (event.key) {
    case "ArrowDown":
      event.preventDefault();
      event.stopImmediatePropagation(); // Prevent Google Docs from handling
      selectItem(state.selectedIndex < max ? state.selectedIndex + 1 : 0);
      break;

    case "ArrowUp":
      event.preventDefault();
      event.stopImmediatePropagation(); // Prevent Google Docs from handling
      selectItem(state.selectedIndex > 0 ? state.selectedIndex - 1 : max);
      break;

    case "Enter":
      event.preventDefault();
      event.stopImmediatePropagation(); // Prevent Google Docs from handling
      const enterQuery = extractQuery();
      const enterFilterType = state.popupFilterType || "both";
      const enterSortType = state.popupSortType || null;
      const matches = filterNotes(enterQuery, enterFilterType, enterSortType);
      if (matches[state.selectedIndex]) {
        const noteText = matches[state.selectedIndex].noteText;
        const noteIndex = matches[state.selectedIndex].noteIndex;
        // Save state before closePopup clears it
        const savedElement = state.lastFocusedElement;
        const savedRange = state.savedRange;
        // Close popup BEFORE handling note insertion to prevent focus conflicts
        closePopup();
        // Restore state for handleNoteInsertion
        state.lastFocusedElement = savedElement;
        state.savedRange = savedRange;
        handleNoteInsertion(noteText);
        incrementNoteUsage(noteIndex);
      }
      break;

    case "Escape":
      event.preventDefault();
      event.stopImmediatePropagation(); // Prevent Google Docs from handling
      closePopup();
      break;

    case "Backspace":
      // For Google Docs: update tracked search query
      if (window.location.hostname.includes("docs.google.com")) {
        if (state.popupSearchQuery && state.popupSearchQuery.length > 0) {
          state.popupSearchQuery = state.popupSearchQuery.slice(0, -1);
          updateResults();
        } else {
          // Query is empty, backspace would delete the "/" — close popup
          closePopup();
        }
        break;
      }
      // Check if backspace would delete the "/" character
      const el = state.lastFocusedElement;
      if (el) {
        const currentValue = getValue(el);
        const lastSlashPos = currentValue.lastIndexOf("/");

        // Get cursor position
        let cursorPos;
        if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
          cursorPos = el.selectionStart;
        } else {
          // For contenteditable, get selection
          const selection = window.getSelection();
          if (selection.rangeCount > 0) {
            const range = selection.getRangeAt(0);
            cursorPos = range.startOffset;
          }
        }

        // If cursor is right after the slash, close popup
        if (
          cursorPos !== undefined &&
          lastSlashPos >= 0 &&
          cursorPos === lastSlashPos + 1
        ) {
          // The next backspace will delete the slash
          closePopup();
        }
      }
      break;

    default:
      // For Google Docs: track typed characters for search since input events don't fire
      if (
        event.key.length === 1 &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        window.location.hostname.includes("docs.google.com")
      ) {
        if (event.key === " " && state.popupSearchQuery === "") {
          // Space right after "/" — close popup
          closePopup();
        } else {
          state.popupSearchQuery += event.key;
          updateResults();
        }
      }
      break;
  }
}

function handleClickOutside(event) {
  if (!state.popupContainer) return;
  if (state.popupContainer.contains(event.target)) return;
  if (state.lastFocusedElement === event.target) return;
  // Don't close when clicking back into the editor area (e.g. Google Docs child elements)
  if (state.lastFocusedElement?.contains?.(event.target)) return;
  closePopup();
}

function closePopup() {
  // Always clean up listeners and reset state, even if popupContainer is already null
  // (prevents stuck state if container was removed externally)
  state.lastFocusedElement?.removeEventListener("input", updateResults);
  document.removeEventListener("click", handleClickOutside);
  window.removeEventListener("keydown", handlePopupKeydown, true);
  document.removeEventListener("mousemove", handleDragMove);
  document.removeEventListener("mouseup", handleDragEnd);

  // Clean up Google Docs iframe listener
  if (state.googleDocsIframeDoc) {
    try {
      state.googleDocsIframeDoc.removeEventListener(
        "keydown",
        handlePopupKeydown,
        true,
      );
    } catch (e) {
      // Ignore errors if iframe is no longer accessible
    }
    state.googleDocsIframeDoc = null;
  }

  if (state.popupContainer) {
    state.popupContainer.remove();
  }

  // Restore focus to the original input element
  const isGoogleDocs = window.location.hostname.includes("docs.google.com");
  const targetElement = state.lastFocusedElement;

  state.popupContainer = null;
  state.isPopupOpen = false;
  state.lastSlashDetected = false;
  state.selectedIndex = 0;
  state.isDragging = false;
  state.savedRange = null;
  state.isPasting = false; // Reset just in case
  state.crossFrameSource = null; // Reset cross-frame state
  state.isCrossFramePopup = false;
  state.popupFilterType = "both"; // Reset filter state
  state.popupSortType = null; // Reset sort state
  state.popupSearchQuery = ""; // Reset search query

  // Restore focus after state cleanup
  if (isGoogleDocs) {
    // For Google Docs, focus the text event target iframe
    // Note: Don't dispatch mouse events as they move the cursor to wrong position
    const docsTextTargetIframe = document.querySelector(
      ".docs-texteventtarget-iframe",
    );

    const restoreFocusToGoogleDocs = () => {
      if (docsTextTargetIframe) {
        try {
          const iframeDoc =
            docsTextTargetIframe.contentDocument ||
            docsTextTargetIframe.contentWindow?.document;
          if (iframeDoc) {
            const iframeBody = iframeDoc.body;
            const iframeEditable =
              iframeDoc.querySelector('[contenteditable="true"]') || iframeBody;
            if (iframeEditable) {
              iframeEditable.focus();
              return;
            }
          }
        } catch (e) {
          // Cross-origin fallback
        }
        docsTextTargetIframe.focus();
      }
    };

    // Multiple attempts to combat focus issues
    restoreFocusToGoogleDocs();
    setTimeout(restoreFocusToGoogleDocs, 50);
    setTimeout(restoreFocusToGoogleDocs, 150);
  } else if (targetElement) {
    // For other sites, focus the original element
    targetElement.focus();
  }
}

// ============================================
// DYNAMIC VALUE INJECTION
// ============================================
function extractPlaceholders(text) {
  // Match {{placeholder}} pattern
  const regex = /\{\{([^}]+)\}\}/g;
  const placeholders = [];
  let match;

  while ((match = regex.exec(text)) !== null) {
    const placeholder = match[1].trim();
    if (!placeholders.includes(placeholder)) {
      placeholders.push(placeholder);
    }
  }

  return placeholders;
}

function handleNoteInsertion(noteText) {
  const placeholders = extractPlaceholders(noteText);

  // Handle cross-frame popup (e.g., Google Docs iframe)
  if (state.isCrossFramePopup) {
    if (placeholders.length === 0) {
      // No placeholders - send note to child frame and copy to clipboard
      sendNoteToChildFrame(noteText);

      // Set isPasting flag to prevent popup from reopening when user pastes
      state.isPasting = true;
      setTimeout(() => {
        state.isPasting = false;
      }, 3000);

      // Also copy to clipboard as fallback
      navigator.clipboard
        .writeText(noteText)
        .then(() => {
          showToast("BlockNote Failed", "Use Ctrl/Cmd+V to Insert");
        })
        .catch(() => {
          showToast("BlockNote Failed", "Use Ctrl/Cmd+V to Insert");
        });
    } else {
      // Has placeholders - show prompt, then send result to child frame
      showPlaceholderPrompt(noteText, placeholders, true /* isCrossFrame */);
    }
    return;
  }

  if (placeholders.length === 0) {
    // No placeholders, paste directly with clipboard fallback
    pasteNoteWithFallback(noteText);
  } else {
    // Show prompt to fill in placeholders
    showPlaceholderPrompt(noteText, placeholders);
  }
}

// Paste with clipboard fallback for sites where direct insertion may fail
function pasteNoteWithFallback(text) {
  const isGoogleDocs = window.location.hostname.includes("docs.google.com");

  // Always copy to clipboard first as safety net
  navigator.clipboard.writeText(text).catch(() => {});

  // Google Docs uses custom canvas rendering - execCommand won't work
  if (isGoogleDocs) {
    showToast("BlockNote Failed", "Use Ctrl/Cmd+V to Insert");

    // Set isPasting flag to prevent popup from reopening when user pastes
    // Keep it active for a few seconds to cover the time user takes to press Ctrl+V
    state.isPasting = true;
    setTimeout(() => {
      state.isPasting = false;
    }, 3000);

    // Restore focus to Google Docs input so user can paste
    // Note: Don't dispatch mouse events as they move the cursor to wrong position
    const restoreFocusToGoogleDocs = () => {
      const docsTextTargetIframe = document.querySelector(
        ".docs-texteventtarget-iframe",
      );

      // Focus the iframe where text input happens - Google Docs maintains cursor position internally
      if (docsTextTargetIframe) {
        try {
          const iframeDoc =
            docsTextTargetIframe.contentDocument ||
            docsTextTargetIframe.contentWindow?.document;
          if (iframeDoc) {
            const iframeBody = iframeDoc.body;
            const iframeEditable =
              iframeDoc.querySelector('[contenteditable="true"]') || iframeBody;
            if (iframeEditable) {
              iframeEditable.focus();
              return;
            }
          }
        } catch (e) {
          // Cross-origin, fall back to focusing the iframe itself
        }
        docsTextTargetIframe.focus();
      }
    };

    // Multiple attempts to ensure focus is restored
    restoreFocusToGoogleDocs();
    setTimeout(restoreFocusToGoogleDocs, 50);
    setTimeout(restoreFocusToGoogleDocs, 150);

    return;
  }

  // Try direct insertion
  pasteNote(text);
}

// Toast notification for clipboard fallback
function showToast(message, subtitle) {
  const isGoogleDocs = window.location.hostname.includes("docs.google.com");

  // Remove existing toast if any
  const existing = document.querySelector(".blocknotes-toast");
  if (existing) {
    existing.remove();
  }

  const toast = document.createElement("div");
  toast.className = "blocknotes-toast";
  toast.innerHTML = `
    <div style="font-weight: 600;">${escapeHtml(message)}</div>
    ${subtitle ? `<div style="font-size: 12px; opacity: 0.8; margin-top: 2px;">${escapeHtml(subtitle)}</div>` : ""}
  `;

  // Use !important on all styles to fight against Google Docs style overrides
  toast.style.cssText = `
    position: fixed !important;
    bottom: 24px !important;
    right: 24px !important;
    background: #1e293b !important;
    color: #f1f5f9 !important;
    padding: 12px 16px !important;
    border-radius: 8px !important;
    font-family: 'Inter', -apple-system, sans-serif !important;
    font-size: 14px !important;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3) !important;
    border: 1px solid #334155 !important;
    z-index: 2147483647 !important;
    animation: blocknotes-toast-in 0.2s ease !important;
    display: block !important;
    visibility: visible !important;
    opacity: 1 !important;
    pointer-events: auto !important;
    transform: none !important;
    width: auto !important;
    height: auto !important;
    min-width: 200px !important;
    max-width: 400px !important;
  `;

  // Add animation keyframes if not exists
  if (!document.getElementById("blocknotes-toast-styles")) {
    const style = document.createElement("style");
    style.id = "blocknotes-toast-styles";
    style.textContent = `
      @keyframes blocknotes-toast-in {
        from { opacity: 0; transform: translateY(10px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .blocknotes-toast {
        position: fixed !important;
        display: block !important;
        visibility: visible !important;
        opacity: 1 !important;
        z-index: 2147483647 !important;
      }
    `;
    document.head.appendChild(style);
  }

  // For Google Docs, try to append to a higher-level container
  let appendTarget = document.body;

  if (isGoogleDocs) {
    // Try to find the top-level docs container or use documentElement
    const docsChrome = document.querySelector(
      ".docs-butterbar-container",
    )?.parentElement;
    if (docsChrome) {
      appendTarget = docsChrome;
    } else {
      // Fallback to documentElement which is above body
      appendTarget = document.documentElement;
    }
  }

  appendTarget.appendChild(toast);

  // Auto-remove after 3 seconds
  setTimeout(() => {
    if (document.contains(toast)) {
      toast.style.opacity = "0";
      toast.style.transition = "opacity 0.2s ease";
      setTimeout(() => {
        if (document.contains(toast)) {
          toast.remove();
        }
      }, 200);
    }
  }, 3000);
}

// Try to auto-fill placeholders from page context
function tryAutoFillPlaceholders(inputs, placeholders) {
  const context = getPageContext();

  placeholders.forEach((placeholder) => {
    const input = inputs[placeholder];
    if (!input || input.value) return; // Skip if already has value

    const lowerPlaceholder = placeholder.toLowerCase();
    let value = null;

    // Match placeholder names to context data
    if (
      lowerPlaceholder.includes("name") &&
      !lowerPlaceholder.includes("company")
    ) {
      value = context.recipientName || context.profileName;
    } else if (
      lowerPlaceholder.includes("company") ||
      lowerPlaceholder.includes("organization")
    ) {
      value = context.company;
    } else if (
      lowerPlaceholder.includes("title") ||
      lowerPlaceholder.includes("position") ||
      lowerPlaceholder.includes("role")
    ) {
      value = context.jobTitle;
    } else if (lowerPlaceholder.includes("email")) {
      value = context.email;
    } else if (
      lowerPlaceholder.includes("topic") ||
      lowerPlaceholder.includes("subject")
    ) {
      value = context.subject || context.pageTitle;
    } else if (
      lowerPlaceholder.includes("location") ||
      lowerPlaceholder.includes("city")
    ) {
      value = context.location;
    }

    if (value) {
      input.value = value;
      input.dataset.autofilled = "true";
      input.style.borderColor = "#818cf8";
    }
  });
}

// Extract context from the current page
function getPageContext() {
  const context = {
    pageTitle: document.title,
    url: window.location.href,
    siteName: window.location.hostname,
  };

  // Gmail-specific selectors
  if (context.siteName.includes("mail.google.com")) {
    // Try to get recipient from To field
    const toField =
      document.querySelector('[name="to"]') ||
      document.querySelector("[data-hovercard-id]") ||
      document.querySelector(".agP");
    if (toField) {
      const text = toField.value || toField.textContent || "";
      // Extract name from "Name <email>" format
      const nameMatch = text.match(/^([^<]+)</);
      context.recipientName = nameMatch
        ? nameMatch[1].trim()
        : text.split("@")[0];
      context.email = text.match(/[\w.-]+@[\w.-]+/)
        ? text.match(/[\w.-]+@[\w.-]+/)[0]
        : "";
    }

    // Try to get subject
    const subjectField =
      document.querySelector('[name="subjectbox"]') ||
      document.querySelector(".hP");
    if (subjectField) {
      context.subject = subjectField.value || subjectField.textContent;
    }
  }

  // LinkedIn-specific selectors
  if (context.siteName.includes("linkedin.com")) {
    // Profile page
    const profileName =
      document.querySelector(".text-heading-xlarge") ||
      document.querySelector(".pv-text-details__left-panel h1");
    if (profileName) {
      context.profileName = profileName.textContent.trim();
    }

    const jobTitle =
      document.querySelector(".text-body-medium.break-words") ||
      document.querySelector(".pv-text-details__left-panel .text-body-medium");
    if (jobTitle) {
      context.jobTitle = jobTitle.textContent.trim();
    }

    const company =
      document
        .querySelector('[data-field="experience_company_logo"]')
        ?.closest("li")
        ?.querySelector('span[aria-hidden="true"]') ||
      document.querySelector(
        ".pv-text-details__right-panel .inline-show-more-text",
      );
    if (company) {
      context.company = company.textContent.trim();
    }

    const location = document.querySelector(
      ".text-body-small.inline.t-black--light.break-words",
    );
    if (location) {
      context.location = location.textContent.trim();
    }
  }

  // Generic fallbacks - look for common patterns
  if (!context.recipientName) {
    // Try to find any name-like element
    const h1 = document.querySelector("h1");
    if (h1 && h1.textContent.split(" ").length <= 4) {
      context.profileName = h1.textContent.trim();
    }
  }

  return context;
}

// Iframe-based placeholder prompt for sites with aggressive event blocking (LinkedIn)
function showPlaceholderPromptIframe(
  noteText,
  placeholders,
  isCrossFrame,
  targetElement,
  savedRange,
) {
  // Helper to restore focus when closing the prompt
  const restoreFocusAfterClose = () => {
    if (targetElement) {
      targetElement.focus();
    }
  };

  // Create container for the iframe
  const container = document.createElement("div");
  container.style.cssText = `
    position: fixed !important;
    top: 0 !important;
    left: 0 !important;
    width: 100vw !important;
    height: 100vh !important;
    background: rgba(0, 0, 0, 0.5) !important;
    z-index: 2147483647 !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
  `;

  // Build the iframe HTML content
  const placeholderInputsHTML = placeholders
    .map(
      (p, i) => `
    <div style="margin-bottom: 12px;">
      <label style="display: block; margin-bottom: 6px; font-size: 12px; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px;">
        ${p}
      </label>
      <input
        type="text"
        id="input-${i}"
        data-placeholder="${p}"
        placeholder="Enter ${p}"
        autocomplete="off"
        style="
          box-sizing: border-box;
          padding: 10px 12px;
          border: 1px solid #334155;
          border-radius: 8px;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          font-size: 14px;
          font-weight: 400;
          color: #f1f5f9;
          background: #334155;
          outline: none;
          width: 100%;
          height: 38px;
        "
        onfocus="this.style.borderColor='#818cf8'; this.style.boxShadow='0 0 0 2px rgba(129, 140, 248, 0.2)';"
        onblur="this.style.borderColor='#334155'; this.style.boxShadow='none';"
      />
    </div>
  `,
    )
    .join("");

  const iframeHTML = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: transparent;
          padding: 0;
          margin: 0;
        }
        .prompt-container {
          background: #27272a;
          border: 1px solid #3f3f46;
          border-radius: 16px;
          box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
          overflow: hidden;
          width: 380px;
          max-width: 90vw;
        }
        .header {
          padding: 10px 14px;
          border-bottom: 1px solid #3f3f46;
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .title {
          font-size: 11px;
          font-weight: 700;
          color: #fafafa;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .close-btn {
          background: transparent;
          border: none;
          font-size: 20px;
          font-weight: 700;
          color: #94a3b8;
          cursor: pointer;
          width: 20px;
          height: 20px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 4px;
        }
        .close-btn:hover {
          background: #475569;
          color: #f1f5f9;
        }
        .form {
          padding: 14px;
        }
        .button-group {
          display: flex;
          gap: 10px;
          justify-content: flex-end;
          margin-top: 4px;
        }
        .btn {
          padding: 8px 16px;
          border-radius: 8px;
          font-family: inherit;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
        }
        .btn-cancel {
          border: 1px solid #334155;
          background: #334155;
          color: #94a3b8;
        }
        .btn-cancel:hover {
          background: #475569;
          color: #f1f5f9;
        }
        .btn-insert {
          border: 1px solid #818cf8;
          background: #818cf8;
          color: white;
        }
        .btn-insert:hover {
          background: #6366f1;
          border-color: #6366f1;
        }
        input::placeholder {
          color: #64748b;
        }
      </style>
    </head>
    <body>
      <div class="prompt-container">
        <div class="header">
          <span class="title">Fill in values</span>
          <button class="close-btn" id="close-btn">&times;</button>
        </div>
        <form class="form" id="form">
          ${placeholderInputsHTML}
          <div class="button-group">
            <button type="button" class="btn btn-cancel" id="cancel-btn">Cancel</button>
            <button type="submit" class="btn btn-insert">Insert</button>
          </div>
        </form>
      </div>
      <script>
        const placeholders = ${JSON.stringify(placeholders)};

        document.getElementById('close-btn').addEventListener('click', () => {
          window.parent.postMessage({ type: 'blocknotes-prompt-close' }, '*');
        });

        document.getElementById('cancel-btn').addEventListener('click', () => {
          window.parent.postMessage({ type: 'blocknotes-prompt-close' }, '*');
        });

        document.getElementById('form').addEventListener('submit', (e) => {
          e.preventDefault();
          const values = {};
          placeholders.forEach((p, i) => {
            values[p] = document.getElementById('input-' + i).value || '{{' + p + '}}';
          });
          window.parent.postMessage({ type: 'blocknotes-prompt-submit', values }, '*');
        });

        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') {
            window.parent.postMessage({ type: 'blocknotes-prompt-close' }, '*');
          }
        });

        // Focus first input
        setTimeout(() => document.getElementById('input-0')?.focus(), 100);
      <\/script>
    </body>
    </html>
  `;

  // Create iframe
  const iframe = document.createElement("iframe");
  iframe.style.cssText = `
    border: none !important;
    width: 400px !important;
    height: 400px !important;
    background: transparent !important;
  `;
  iframe.srcdoc = iframeHTML;

  // Listen for messages from iframe
  const handleMessage = (event) => {
    if (event.data?.type === "blocknotes-prompt-close") {
      container.remove();
      window.removeEventListener("message", handleMessage);
      restoreFocusAfterClose();
    } else if (event.data?.type === "blocknotes-prompt-submit") {
      const values = event.data.values;
      let finalText = noteText;

      placeholders.forEach((placeholder) => {
        const value = values[placeholder] || `{{${placeholder}}}`;
        const regex = new RegExp(
          `\\{\\{${placeholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\}\\}`,
          "g",
        );
        finalText = finalText.replace(regex, value);
      });

      container.remove();
      window.removeEventListener("message", handleMessage);

      // Restore state and insert
      state.lastFocusedElement = targetElement;
      state.savedRange = savedRange;

      if (isCrossFrame) {
        sendNoteToChildFrame(finalText);
        state.isPasting = true;
        setTimeout(() => {
          state.isPasting = false;
        }, 3000);
        navigator.clipboard
          .writeText(finalText)
          .then(() => {
            showToast("BlockNote Failed", "Use Ctrl/Cmd+V to Insert");
          })
          .catch(() => {
            showToast("BlockNote Failed", "Use Ctrl/Cmd+V to Insert");
          });
        restoreFocusAfterClose();
      } else {
        pasteNoteWithFallback(finalText);
      }
    }
  };

  window.addEventListener("message", handleMessage);

  // Click outside to close
  container.addEventListener("click", (e) => {
    if (e.target === container) {
      container.remove();
      window.removeEventListener("message", handleMessage);
      restoreFocusAfterClose();
    }
  });

  container.appendChild(iframe);
  document.body.appendChild(container);
}

function showPlaceholderPrompt(noteText, placeholders, isCrossFrame = false) {
  // Save the focused element and selection range before showing prompt
  const targetElement = state.lastFocusedElement;
  const savedRange = state.savedRange;
  const isGoogleDocs = window.location.hostname.includes("docs.google.com");

  // Blur the target element to ensure our prompt can take focus
  // This prevents aggressive editors from intercepting keyboard events
  if (targetElement && targetElement.blur) {
    targetElement.blur();
  }

  // Helper to restore focus when closing the prompt
  // Note: Don't dispatch mouse events as they move the cursor to wrong position
  const restoreFocusAfterClose = () => {
    if (isGoogleDocs) {
      const docsTextTargetIframe = document.querySelector(
        ".docs-texteventtarget-iframe",
      );

      const restoreFocus = () => {
        if (docsTextTargetIframe) {
          try {
            const iframeDoc =
              docsTextTargetIframe.contentDocument ||
              docsTextTargetIframe.contentWindow?.document;
            if (iframeDoc) {
              const iframeBody = iframeDoc.body;
              const iframeEditable =
                iframeDoc.querySelector('[contenteditable="true"]') ||
                iframeBody;
              if (iframeEditable) {
                iframeEditable.focus();
                return;
              }
            }
          } catch (e) {
            // Cross-origin fallback
          }
          docsTextTargetIframe.focus();
        }
      };

      restoreFocus();
      setTimeout(restoreFocus, 50);
      setTimeout(restoreFocus, 150);
    } else if (targetElement) {
      targetElement.focus();
    }
  };

  const promptContainer = document.createElement("div");
  promptContainer.className = "blocknotes-placeholder-prompt";
  promptContainer.tabIndex = -1; // Make container focusable for focus trapping
  promptContainer.style.cssText = `
    position: fixed !important;
    top: 50% !important;
    left: 50% !important;
    transform: translate(-50%, -50%) !important;
    width: 380px !important;
    max-width: 90vw !important;
    background: #27272a !important;
    border: 1px solid #3f3f46 !important;
    border-radius: 16px !important;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5), 0 4px 12px rgba(0, 0, 0, 0.3) !important;
    z-index: 2147483647 !important;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
    overflow: hidden !important;
    animation: placeholderPromptFadeIn 0.2s ease !important;
    display: block !important;
    visibility: visible !important;
    opacity: 1 !important;
    pointer-events: auto !important;
    color: #fafafa !important;
  `;

  // Prevent focus from escaping to Word/Google Docs
  promptContainer.addEventListener("focusout", (e) => {
    // If focus is leaving the container, pull it back
    if (!promptContainer.contains(e.relatedTarget)) {
      e.preventDefault();
      e.stopPropagation();
      // Re-focus the first input or the container itself
      const firstFocusable = promptContainer.querySelector("input, button");
      if (firstFocusable) {
        setTimeout(() => firstFocusable.focus(), 0);
      }
    }
  });

  // Handle beforeinput events - LinkedIn's Quill editor listens for these at document level
  // We need to stop propagation to prevent LinkedIn from intercepting text input
  const handlePromptBeforeInput = (e) => {
    if (promptContainer.contains(e.target)) {
      e.stopImmediatePropagation();
    }
  };

  // Handle input events similarly
  const handlePromptInput = (e) => {
    if (promptContainer.contains(e.target)) {
      e.stopImmediatePropagation();
    }
  };

  // Document-level escape handler (capture phase) for edge cases where focus escapes
  const handleDocumentEscape = (e) => {
    if (e.key === "Escape" && document.body.contains(promptContainer)) {
      e.preventDefault();
      e.stopPropagation();
      promptContainer.remove();
      cleanupPromptListeners();
      restoreFocusAfterClose();
    }
  };

  // Declare handlePromptKeydown variable first (will be assigned below)
  let handlePromptKeydown;

  // Helper to clean up all prompt event listeners
  const cleanupPromptListeners = () => {
    window.removeEventListener("keydown", handlePromptKeydown, true);
    window.removeEventListener("keydown", handleDocumentEscape, true);
    window.removeEventListener("beforeinput", handlePromptBeforeInput, true);
    window.removeEventListener("input", handlePromptInput, true);
    window.removeEventListener("keyup", handlePromptBeforeInput, true);
    window.removeEventListener("keypress", handlePromptBeforeInput, true);
  };

  // Handle keyboard events using CAPTURE phase to intercept before LinkedIn
  // Use stopImmediatePropagation to prevent any other listeners from seeing the event
  handlePromptKeydown = (e) => {
    // Check if our prompt is visible and has an input focused
    const activeInput = promptContainer.querySelector("input:focus");
    const isPromptFocused = promptContainer.contains(document.activeElement);

    // If prompt is focused but target is outside (LinkedIn hijacking), redirect to our input
    if (isPromptFocused && !promptContainer.contains(e.target)) {
      e.preventDefault();
      e.stopImmediatePropagation();

      // Re-dispatch to the active input
      if (activeInput && e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
        // For printable characters, insert directly
        const start = activeInput.selectionStart || 0;
        const end = activeInput.selectionEnd || 0;
        activeInput.value =
          activeInput.value.substring(0, start) +
          e.key +
          activeInput.value.substring(end);
        activeInput.selectionStart = activeInput.selectionEnd = start + 1;
        activeInput.dispatchEvent(new Event("input", { bubbles: true }));
      } else if (activeInput && e.key === "Backspace") {
        const start = activeInput.selectionStart || 0;
        const end = activeInput.selectionEnd || 0;
        if (start === end && start > 0) {
          activeInput.value =
            activeInput.value.substring(0, start - 1) +
            activeInput.value.substring(end);
          activeInput.selectionStart = activeInput.selectionEnd = start - 1;
        } else if (start !== end) {
          activeInput.value =
            activeInput.value.substring(0, start) +
            activeInput.value.substring(end);
          activeInput.selectionStart = activeInput.selectionEnd = start;
        }
        activeInput.dispatchEvent(new Event("input", { bubbles: true }));
      }
      return;
    }

    // Normal handling for events targeting our prompt
    if (!promptContainer.contains(e.target)) {
      return;
    }

    // Handle Escape key to close the prompt
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      promptContainer.remove();
      cleanupPromptListeners();
      restoreFocusAfterClose();
      return;
    }

    // Handle Tab key to trap focus within the prompt
    if (e.key === "Tab") {
      e.stopImmediatePropagation();
      const focusableElements = promptContainer.querySelectorAll(
        "input:not([disabled]), button:not([disabled])",
      );
      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];

      if (e.shiftKey && document.activeElement === firstElement) {
        e.preventDefault();
        lastElement.focus();
      } else if (!e.shiftKey && document.activeElement === lastElement) {
        e.preventDefault();
        firstElement.focus();
      }
      return;
    }

    // Handle Enter to submit form
    if (e.key === "Enter") {
      e.stopImmediatePropagation();
      return;
    }

    // For all other keys (regular typing), stop LinkedIn from intercepting
    // but allow the event to continue to the input element
    e.stopImmediatePropagation();
  };

  // Register all event listeners on WINDOW with capture phase
  // LinkedIn may be listening on window, not document
  window.addEventListener("keydown", handlePromptKeydown, true);
  window.addEventListener("keydown", handleDocumentEscape, true);
  window.addEventListener("beforeinput", handlePromptBeforeInput, true);
  window.addEventListener("input", handlePromptInput, true);
  window.addEventListener("keyup", handlePromptBeforeInput, true);
  window.addEventListener("keypress", handlePromptBeforeInput, true);

  // Stop events from bubbling to LinkedIn's handlers (bubble phase only)
  const stopBubble = (e) => {
    e.stopPropagation();
  };
  promptContainer.addEventListener("mousedown", stopBubble);
  promptContainer.addEventListener("mouseup", stopBubble);
  promptContainer.addEventListener("click", stopBubble);
  promptContainer.addEventListener("pointerdown", stopBubble);
  promptContainer.addEventListener("pointerup", stopBubble);
  promptContainer.addEventListener("focusin", stopBubble);
  promptContainer.addEventListener("focusout", stopBubble);

  // Header - matching main popup style with drag functionality
  const header = document.createElement("div");
  header.className = "blocknotes-placeholder-header";
  header.style.cssText = `
    padding: 10px 14px !important;
    border-bottom: 1px solid #3f3f46 !important;
    font-size: 11px !important;
    font-weight: 700 !important;
    color: #fafafa !important;
    text-transform: uppercase !important;
    letter-spacing: 0.5px !important;
    display: flex !important;
    align-items: center !important;
    justify-content: space-between !important;
    cursor: grab !important;
    user-select: none !important;
    background: linear-gradient(135deg, #3f3f46 0%, #27272a 100%) !important;
    border-radius: 16px 16px 0 0 !important;
  `;

  const title = document.createElement("span");
  title.textContent = "Fill in values";
  title.style.cssText = `
    margin: 0 !important;
    font-size: 11px !important;
    font-weight: 700 !important;
    color: #fafafa !important;
    text-transform: uppercase !important;
    letter-spacing: 0.5px !important;
  `;

  const closeBtn = document.createElement("button");
  closeBtn.innerHTML = "×";
  closeBtn.style.cssText = `
    background: transparent !important;
    border: none !important;
    font-size: 20px !important;
    font-weight: 700 !important;
    color: #94a3b8 !important;
    cursor: pointer !important;
    padding: 0 !important;
    width: 20px !important;
    height: 20px !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    border-radius: 4px !important;
    transition: all 0.15s ease !important;
    line-height: 1 !important;
  `;

  closeBtn.addEventListener("mouseenter", () => {
    closeBtn.style.setProperty("background", "#475569", "important");
    closeBtn.style.setProperty("color", "#f1f5f9", "important");
  });

  closeBtn.addEventListener("mouseleave", () => {
    closeBtn.style.setProperty("background", "transparent", "important");
    closeBtn.style.setProperty("color", "#94a3b8", "important");
  });

  closeBtn.addEventListener("click", () => {
    promptContainer.remove();
    cleanupPromptListeners();
    restoreFocusAfterClose();
  });

  // Drag functionality for placeholder prompt
  let isDraggingPrompt = false;
  let promptDragStartX = 0;
  let promptDragStartY = 0;
  let promptStartX = 0;
  let promptStartY = 0;

  const handlePromptDragMove = (e) => {
    if (!isDraggingPrompt) return;
    const deltaX = e.clientX - promptDragStartX;
    const deltaY = e.clientY - promptDragStartY;
    promptContainer.style.left = `${promptStartX + deltaX}px`;
    promptContainer.style.top = `${promptStartY + deltaY}px`;
    promptContainer.style.transform = "none";
  };

  const handlePromptDragEnd = () => {
    if (!isDraggingPrompt) return;
    isDraggingPrompt = false;
    header.style.cursor = "grab";
    document.removeEventListener("mousemove", handlePromptDragMove, true);
    document.removeEventListener("mouseup", handlePromptDragEnd, true);
  };

  header.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    isDraggingPrompt = true;
    promptDragStartX = e.clientX;
    promptDragStartY = e.clientY;
    const rect = promptContainer.getBoundingClientRect();
    promptStartX = rect.left;
    promptStartY = rect.top;
    header.style.cursor = "grabbing";
    document.addEventListener("mousemove", handlePromptDragMove, true);
    document.addEventListener("mouseup", handlePromptDragEnd, true);
  });

  header.appendChild(title);
  header.appendChild(closeBtn);

  // Form
  const form = document.createElement("form");
  form.style.cssText = `
    padding: 16px !important;
    display: flex !important;
    flex-direction: column !important;
    gap: 14px !important;
    max-height: 60vh !important;
    overflow-y: auto !important;
    background: #1e293b !important;
    margin: 0 !important;
    border: none !important;
    pointer-events: auto !important;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
  `;

  // Auto-fill toggle
  const autoFillContainer = document.createElement("div");
  autoFillContainer.style.cssText = `
    display: flex !important;
    align-items: center !important;
    justify-content: space-between !important;
    padding: 10px 12px !important;
    background: #334155 !important;
    border: 1px solid #475569 !important;
    border-radius: 8px !important;
    margin: 0 !important;
  `;

  const autoFillLabel = document.createElement("label");
  autoFillLabel.style.cssText = `
    margin: 0;
    display: flex !important;
    align-items: center !important;
    gap: 8px !important;
    font-size: 12px !important;
    color: #e2e8f0 !important;
    cursor: pointer !important;
    flex: 1 !important;
  `;
  autoFillLabel.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 2a10 10 0 1 0 10 10H12V2z"></path>
      <path d="M12 12L12 2"></path>
      <path d="M12 12L20 12"></path>
    </svg>
    <span>Auto-fill from page</span>
  `;

  const autoFillToggle = document.createElement("input");
  autoFillToggle.type = "checkbox";
  autoFillToggle.id = "blocknotes-autofill-toggle";
  autoFillToggle.style.cssText = `
    width: 16px !important;
    height: 16px !important;
    cursor: pointer !important;
    accent-color: #818cf8 !important;
    margin: 0 !important;
    flex-shrink: 0 !important;
    display: inline-block !important;
    visibility: visible !important;
    opacity: 1 !important;
    -webkit-appearance: checkbox !important;
    appearance: checkbox !important;
    position: relative !important;
    pointer-events: auto !important;
  `;

  // Load saved preference
  chrome.storage.local.get("settings", (data) => {
    const settings = data.settings || {};
    autoFillToggle.checked = settings.autoFillPlaceholders || false;
    if (autoFillToggle.checked) {
      tryAutoFillPlaceholders(inputs, placeholders);
    }
  });

  autoFillToggle.addEventListener("change", () => {
    // Save preference
    chrome.storage.local.get("settings", (data) => {
      const settings = data.settings || {};
      settings.autoFillPlaceholders = autoFillToggle.checked;
      chrome.storage.local.set({ settings });
    });

    if (autoFillToggle.checked) {
      tryAutoFillPlaceholders(inputs, placeholders);
    } else {
      // Clear auto-filled values
      Object.values(inputs).forEach((input) => {
        if (input.dataset.autofilled) {
          input.value = "";
          input.style.borderColor = "#334155";
          delete input.dataset.autofilled;
        }
      });
    }
  });

  // Add label and toggle as siblings for proper space-between layout
  autoFillContainer.appendChild(autoFillLabel);
  autoFillContainer.appendChild(autoFillToggle);
  form.appendChild(autoFillContainer);

  const inputs = {};

  placeholders.forEach((placeholder, index) => {
    const fieldGroup = document.createElement("div");
    fieldGroup.style.cssText = `
      display: flex !important;
      flex-direction: column !important;
      gap: 6px !important;
      margin: 0 !important;
      padding: 0 !important;
    `;

    const label = document.createElement("label");
    label.textContent = placeholder;
    label.style.cssText = `
      font-size: 12px !important;
      margin: 0 !important;
      font-weight: 600 !important;
      color: #94a3b8 !important;
      display: block !important;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
    `;

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = `Enter ${placeholder}`;
    input.setAttribute("autocomplete", "off");
    input.setAttribute("autocorrect", "off");
    input.setAttribute("autocapitalize", "off");
    input.setAttribute("spellcheck", "false");
    input.style.cssText = `
      box-sizing: border-box !important;
      padding: 10px 12px !important;
      border: 1px solid #334155 !important;
      border-radius: 8px !important;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
      font-size: 14px !important;
      font-weight: 400 !important;
      color: #f1f5f9 !important;
      background: #334155 !important;
      outline: none !important;
      transition: border-color 0.2s ease, box-shadow 0.2s ease !important;
      width: 100% !important;
      height: 38px !important;
      display: block !important;
      cursor: text !important;
      caret-color: #f1f5f9 !important;
      visibility: visible !important;
      opacity: 1 !important;
      -webkit-appearance: none !important;
      appearance: none !important;
      position: relative !important;
      pointer-events: auto !important;
    `;

    input.addEventListener("focus", () => {
      input.style.setProperty("border-color", "#818cf8", "important");
      input.style.setProperty(
        "box-shadow",
        "0 0 0 2px rgba(129, 140, 248, 0.2)",
        "important",
      );
    });

    input.addEventListener("blur", () => {
      input.style.setProperty("border-color", "#334155", "important");
      input.style.setProperty("box-shadow", "none", "important");
    });

    input.addEventListener("beforeinput", (e) => {
      e.stopPropagation();
    });

    // Stop ALL events from propagating to page (fixes LinkedIn blocking inputs)
    const stopInputPropagation = (e) => {
      e.stopPropagation();
    };
    // Mouse/touch events
    input.addEventListener("mousedown", stopInputPropagation);
    input.addEventListener("mouseup", stopInputPropagation);
    input.addEventListener("click", stopInputPropagation);
    input.addEventListener("pointerdown", stopInputPropagation);
    input.addEventListener("pointerup", stopInputPropagation);
    input.addEventListener("touchstart", stopInputPropagation);
    input.addEventListener("touchend", stopInputPropagation);
    // Keyboard events - stop LinkedIn from intercepting
    input.addEventListener("keydown", stopInputPropagation);
    input.addEventListener("keyup", stopInputPropagation);
    input.addEventListener("keypress", stopInputPropagation);
    // Input events
    input.addEventListener("input", stopInputPropagation);
    input.addEventListener("textInput", stopInputPropagation); // Legacy but LinkedIn might use it
    // Composition events (for IME input)
    input.addEventListener("compositionstart", stopInputPropagation);
    input.addEventListener("compositionupdate", stopInputPropagation);
    input.addEventListener("compositionend", stopInputPropagation);

    inputs[placeholder] = input;

    fieldGroup.appendChild(label);
    fieldGroup.appendChild(input);
    form.appendChild(fieldGroup);
  });

  // Store reference to first input for focus after DOM attachment
  const firstInput = inputs[placeholders[0]];

  // Buttons
  const buttonGroup = document.createElement("div");
  buttonGroup.style.cssText = `
    display: flex !important;
    gap: 10px !important;
    justify-content: flex-end !important;
    margin-top: 4px !important;
  `;

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "Cancel";
  cancelBtn.style.cssText = `
    padding: 8px 16px !important;
    border: 1px solid #334155 !important;
    border-radius: 8px !important;
    background: #334155 !important;
    color: #94a3b8 !important;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
    font-size: 13px !important;
    font-weight: 600 !important;
    cursor: pointer !important;
    transition: all 0.2s ease !important;
  `;

  cancelBtn.addEventListener("mouseenter", () => {
    cancelBtn.style.setProperty("background", "#475569", "important");
    cancelBtn.style.setProperty("color", "#f1f5f9", "important");
  });

  cancelBtn.addEventListener("mouseleave", () => {
    cancelBtn.style.setProperty("background", "#334155", "important");
    cancelBtn.style.setProperty("color", "#94a3b8", "important");
  });

  cancelBtn.addEventListener("click", () => {
    promptContainer.remove();
    cleanupPromptListeners();
    restoreFocusAfterClose();
  });

  const insertBtn = document.createElement("button");
  insertBtn.type = "submit";
  insertBtn.textContent = "Insert";
  insertBtn.style.cssText = `
    padding: 8px 16px !important;
    border: 1px solid #818cf8 !important;
    border-radius: 8px !important;
    background: #818cf8 !important;
    color: white !important;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
    font-size: 13px !important;
    font-weight: 600 !important;
    cursor: pointer !important;
    transition: all 0.2s ease !important;
  `;

  insertBtn.addEventListener("mouseenter", () => {
    insertBtn.style.setProperty("background", "#6366f1", "important");
    insertBtn.style.setProperty("border-color", "#6366f1", "important");
  });

  insertBtn.addEventListener("mouseleave", () => {
    insertBtn.style.setProperty("background", "#818cf8", "important");
    insertBtn.style.setProperty("border-color", "#818cf8", "important");
  });

  buttonGroup.appendChild(cancelBtn);
  buttonGroup.appendChild(insertBtn);
  form.appendChild(buttonGroup);

  // Handle form submission (capture phase - fires before window interceptor kills event)
  form.addEventListener(
    "submit",
    (e) => {
      e.preventDefault();

      // Restore the original focused element and saved range
      state.lastFocusedElement = targetElement;
      state.savedRange = savedRange;

      let finalText = noteText;

      // Replace all placeholders with input values
      placeholders.forEach((placeholder) => {
        const value = inputs[placeholder].value || `{{${placeholder}}}`;
        const regex = new RegExp(
          `\\{\\{${placeholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\}\\}`,
          "g",
        );
        finalText = finalText.replace(regex, value);
      });

      promptContainer.remove();
      cleanupPromptListeners();

      // Handle cross-frame insertion
      if (isCrossFrame) {
        sendNoteToChildFrame(finalText);

        // Set isPasting flag to prevent popup from reopening when user pastes
        state.isPasting = true;
        setTimeout(() => {
          state.isPasting = false;
        }, 3000);

        navigator.clipboard
          .writeText(finalText)
          .then(() => {
            showToast("BlockNote Failed", "Use Ctrl/Cmd+V to Insert");
          })
          .catch(() => {
            showToast("BlockNote Failed", "Use Ctrl/Cmd+V to Insert");
          });
        restoreFocusAfterClose();
      } else {
        pasteNoteWithFallback(finalText);
        // For Google Docs, also restore focus after pasteNoteWithFallback
        if (isGoogleDocs) {
          restoreFocusAfterClose();
        }
      }
    },
    true,
  ); // Capture phase - fires before window interceptor kills event

  promptContainer.appendChild(header);
  promptContainer.appendChild(form);
  document.body.appendChild(promptContainer);

  // Focus the first input after DOM attachment for keyboard input
  // Use multiple attempts to combat aggressive focus stealing from Word/Docs
  if (firstInput) {
    const focusInput = () => {
      firstInput.focus();
      // Ensure the input is actually focused
      if (document.activeElement !== firstInput) {
        firstInput.focus();
      }
    };

    // Immediate focus
    focusInput();
    // Delayed focus attempts to combat focus stealing
    setTimeout(focusInput, 50);
    setTimeout(focusInput, 100);
    setTimeout(focusInput, 200);
  }

  // Add animation styles
  if (!document.getElementById("blocknotes-placeholder-styles")) {
    const style = document.createElement("style");
    style.id = "blocknotes-placeholder-styles";
    style.textContent = `
      @keyframes placeholderPromptFadeIn {
        from {
          opacity: 0;
          transform: translate(-50%, -50%) scale(0.95);
        }
        to {
          opacity: 1;
          transform: translate(-50%, -50%) scale(1);
        }
      }
      .blocknotes-placeholder-prompt input::placeholder {
        color: #64748b !important;
        opacity: 1 !important;
      }
      .blocknotes-placeholder-prompt input::-webkit-input-placeholder {
        color: #64748b !important;
        opacity: 1 !important;
      }
      .blocknotes-placeholder-prompt input::-moz-placeholder {
        color: #64748b !important;
        opacity: 1 !important;
      }
      .blocknotes-placeholder-prompt input:-ms-input-placeholder {
        color: #64748b !important;
        opacity: 1 !important;
      }
    `;
    document.head.appendChild(style);
  }
}

// ============================================
// PASTE
// ============================================

// Detect if contenteditable uses paragraph (<p>) structure for line breaks
// This is common in Word, many rich text editors, etc.
function usesParagraphStructure(el) {
  if (!el) return false;

  // Check if the element contains <p> tags as direct children or nested
  const hasParagraphs = el.querySelector("p") !== null;

  // Check if hitting Enter would create a paragraph (test by examining existing structure)
  // If first child is a <p>, it's likely a paragraph-based editor
  const firstChild = el.firstElementChild;
  if (firstChild && firstChild.tagName === "P") {
    return true;
  }

  // Check if there are multiple <p> siblings (indicates paragraph structure)
  const paragraphs = el.querySelectorAll(":scope > p");
  if (paragraphs.length > 0) {
    return true;
  }

  // Check for common rich text editor patterns that use paragraphs
  // These editors wrap content in <p> tags
  if (
    el.closest('[data-contents="true"]') || // Draft.js
    el.closest(".ql-editor") || // Quill
    el.closest(".ProseMirror") || // ProseMirror
    el.closest(".tox-edit-area") || // TinyMCE
    el.closest('[contenteditable="true"] p')
  ) {
    // Generic paragraph container
    return true;
  }

  return hasParagraphs;
}

function pasteNote(text) {
  const el = state.lastFocusedElement;
  if (!el) return;

  // Set flag to prevent popup from reopening during paste
  state.isPasting = true;

  let content = getValue(el);
  const slashIndex = content.lastIndexOf("/");

  if (slashIndex >= 0) {
    content = content.slice(0, slashIndex) + text;
  } else {
    content += text;
  }

  // Set value
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
    el.value = content;

    // React compatibility
    const nativeSetter = Object.getOwnPropertyDescriptor(
      el.tagName === "INPUT"
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    if (nativeSetter) {
      nativeSetter.call(el, content);
    }

    // Move cursor to end of inserted text
    const cursorPosition = content.length;
    el.setSelectionRange(cursorPosition, cursorPosition);

    // Dispatch events and restore cursor for INPUT/TEXTAREA
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.focus();

    // Restore cursor position after focus (React re-renders may reset it)
    const restoreInputCursor = () => {
      try {
        el.setSelectionRange(cursorPosition, cursorPosition);
      } catch (e) {
        // Ignore if element is no longer valid
      }
    };
    restoreInputCursor();
    setTimeout(restoreInputCursor, 0);
    setTimeout(restoreInputCursor, 50);

    // Update previous value and reset isPasting flag
    state.previousValue = getValue(el);
    setTimeout(() => {
      state.isPasting = false;
    }, 100);
    return;
  } else if (el.isContentEditable) {
    // For contenteditable, we need to handle newlines properly
    // Detect the editor type by structure, not by URL
    const hasNewlines = text.includes("\n");
    const isParagraphEditor = usesParagraphStructure(el);

    // Use saved range since clicking popup loses the selection
    let range = state.savedRange;

    // Also check current selection for comparison/fallback
    const currentSelection = window.getSelection();
    const currentRange =
      currentSelection.rangeCount > 0 ? currentSelection.getRangeAt(0) : null;

    if (!range) {
      range = currentRange;
    }

    if (range) {
      const insertContainer = range.startContainer;
      const insertOffset = range.startOffset;

      // First, restore the selection to where it was when popup opened
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);

      // Now use execCommand to delete the "/" and query text
      // This is safer than manually manipulating the DOM
      if (slashIndex >= 0 && insertContainer.nodeType === Node.TEXT_NODE) {
        const textContent = insertContainer.textContent || "";
        const slashPosInText = textContent.lastIndexOf("/");

        if (slashPosInText >= 0) {
          const searchQuery = extractQuery();
          // Characters to delete: "/" (1) + query length
          const charsToDelete = 1 + searchQuery.length;

          // Edge case: when cursor is in the first line and slash is at position 0,
          // the insertOffset might be 0 (before the slash) instead of after it.
          // In this case, we need to ensure we delete from position 0 and insert after.
          const isFirstLineEdgeCase =
            slashPosInText === 0 && insertOffset === 0;

          // The cursor should be right after the query, so we select backwards
          // Create a range from slash position to current position
          try {
            const deleteRange = document.createRange();
            // For the first line edge case, ensure we start from position 0
            // and delete the slash + query correctly
            const deleteStart = slashPosInText;
            const deleteEnd = Math.min(
              slashPosInText + charsToDelete,
              textContent.length,
            );

            deleteRange.setStart(insertContainer, deleteStart);
            deleteRange.setEnd(insertContainer, deleteEnd);

            sel.removeAllRanges();
            sel.addRange(deleteRange);

            // Delete the selected text
            document.execCommand("delete", false);
          } catch (e) {
            // Slash deletion failed, inserting at cursor
            // For first line edge case, if deletion fails, we need to position cursor after the slash+query
            // to avoid inserting before the slash
            if (isFirstLineEdgeCase) {
              try {
                const newRange = document.createRange();
                const endPos = Math.min(
                  slashPosInText + charsToDelete,
                  textContent.length,
                );
                newRange.setStart(insertContainer, endPos);
                newRange.collapse(true);
                sel.removeAllRanges();
                sel.addRange(newRange);
              } catch (e2) {
                sel.removeAllRanges();
                sel.addRange(range);
              }
            } else {
              // Restore original position if deletion fails
              sel.removeAllRanges();
              sel.addRange(range);
            }
          }
        }
      } else if (slashIndex >= 0) {
        // Edge case: insertContainer is not a TEXT_NODE (common on first line)
        // Need to find the text node containing the "/" and delete it
        try {
          // Walk through the element to find the text node with the slash
          const walker = document.createTreeWalker(
            el,
            NodeFilter.SHOW_TEXT,
            null,
            false,
          );

          let textNode = walker.nextNode();
          let slashNode = null;
          let slashNodeOffset = -1;

          while (textNode) {
            const nodeSlashPos = textNode.textContent.lastIndexOf("/");
            if (nodeSlashPos >= 0) {
              slashNode = textNode;
              slashNodeOffset = nodeSlashPos;
              // Keep looking in case there's a later slash
            }
            textNode = walker.nextNode();
          }

          if (slashNode && slashNodeOffset >= 0) {
            const searchQuery = extractQuery();
            const charsToDelete = 1 + searchQuery.length;
            const nodeTextLength = slashNode.textContent.length;

            const deleteRange = document.createRange();
            deleteRange.setStart(slashNode, slashNodeOffset);
            deleteRange.setEnd(
              slashNode,
              Math.min(slashNodeOffset + charsToDelete, nodeTextLength),
            );

            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(deleteRange);
            document.execCommand("delete", false);
          }
        } catch (e) {
          // Error searching for slash
        }
      }

      // Insert text based on editor type
      if (hasNewlines) {
        // Multiline text - insert line by line
        const lines = text.split("\n");

        if (isParagraphEditor) {
          // Paragraph-based editor (Word, rich text editors)
          // Use keyboard simulation for better compatibility with Word
          insertWithKeyboardSimulation(lines, el);
        } else {
          // Line-break based editor (Gmail, simple contenteditable)
          // Use insertLineBreak or <br> tags
          for (let index = 0; index < lines.length; index++) {
            const line = lines[index];
            document.execCommand("insertText", false, line);

            if (index < lines.length - 1) {
              document.execCommand("insertLineBreak", false);
            }
          }
        }
      } else {
        // Single line - simple insert
        document.execCommand("insertText", false, text);
      }

      // Clear saved range after use
      state.savedRange = null;
    } else {
      // Fallback: no saved range, try to focus and insert
      el.focus();
      if (hasNewlines) {
        insertTextLineByLine(text, isParagraphEditor);
      } else {
        document.execCommand("insertText", false, text);
      }
    }
  }

  // Update previous value
  state.previousValue = getValue(el);

  // For Word and similar editors, we need to position cursor after inserted text
  // Save the expected cursor position (current selection should be after inserted text)
  const selection = window.getSelection();
  let cursorRange = null;
  if (selection.rangeCount > 0) {
    cursorRange = selection.getRangeAt(0).cloneRange();
  }

  // Trigger events
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.focus();

  // Restore cursor position after focus (focus can reset cursor in Word)
  // Use setTimeout to ensure Word's internal processing is complete
  if (cursorRange) {
    const restoreCursor = () => {
      try {
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(cursorRange);
      } catch (e) {
        // Ignore if range is no longer valid
      }
    };
    // Immediate restore
    restoreCursor();
    // Delayed restore to handle Word's async cursor reset
    setTimeout(restoreCursor, 0);
    setTimeout(restoreCursor, 50);
  }

  // Reset isPasting flag after a short delay to ensure all events are processed
  setTimeout(() => {
    state.isPasting = false;
  }, 100);
}

// Helper function to insert text line by line using execCommand
function insertTextLineByLine(text, useParagraphs = false) {
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    // Insert the text content
    document.execCommand("insertText", false, line);

    if (index < lines.length - 1) {
      // Insert a line/paragraph break based on editor type
      if (useParagraphs) {
        document.execCommand("insertParagraph", false);
      } else {
        document.execCommand("insertLineBreak", false);
      }
    }
  }
}

// Detect if we're in MS Word Online
function isMSWordOnline() {
  // Check URL
  const hostname = window.location.hostname;
  if (
    hostname.includes("word.office.com") ||
    hostname.includes("word-edit.officeapps.live.com")
  ) {
    return true;
  }

  // Check for Word-specific DOM elements
  if (
    document.querySelector('[data-app="Word"]') ||
    document.querySelector(".WACViewPanel") ||
    document.querySelector('[class*="WordEditor"]')
  ) {
    return true;
  }

  return false;
}

// Insert multiline text for paragraph-based editors (Word, rich text editors)
async function insertWithKeyboardSimulation(lines, el) {
  const text = lines.join("\n");

  // For MS Word Online specifically, use clipboard-based paste
  // Word has internal state management that gets out of sync with DOM manipulation
  if (isMSWordOnline()) {
    const clipboardSuccess = await insertViaClipboard(text, el);
    if (clipboardSuccess) {
      return;
    }
  }

  // For other paragraph editors: Try inserting as plain text with newlines
  // execCommand insertText naturally leaves cursor after inserted text
  const textInserted = document.execCommand("insertText", false, text);
  if (textInserted) {
    return;
  }

  // Fallback: Insert each line separately with paragraph breaks
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];

    if (line.length > 0) {
      document.execCommand("insertText", false, line);
    }

    if (index < lines.length - 1) {
      document.execCommand("insertParagraph", false);
    }
  }
  // Cursor should now be after the inserted text
}

// Insert text via clipboard for Word - copy and prompt user to paste
async function insertViaClipboard(text, el) {
  try {
    // Write text to clipboard
    await navigator.clipboard.writeText(text);

    // Focus the element
    el.focus();

    // Set isPasting flag to prevent popup from reopening when user pastes
    state.isPasting = true;
    setTimeout(() => {
      state.isPasting = false;
    }, 3000);

    // Show toast to prompt user to paste
    // Programmatic paste is blocked by browsers for security
    showToast("BlockNote Failed", "Use Ctrl/Cmd+V to Insert");

    return true;
  } catch (error) {
    return false;
  }
}

// Helper to move cursor to end of contenteditable
function moveCursorToEnd(el) {
  const selection = window.getSelection();
  const range = document.createRange();

  // Find the last text node or element
  if (el.lastChild) {
    if (el.lastChild.nodeType === Node.TEXT_NODE) {
      range.setStart(el.lastChild, el.lastChild.textContent.length);
    } else {
      range.selectNodeContents(el.lastChild);
      range.collapse(false);
    }
  } else {
    range.selectNodeContents(el);
    range.collapse(false);
  }

  selection.removeAllRanges();
  selection.addRange(range);
}

function handleMessage(request) {
  if (request.action === "pasteValue") {
    pasteNote(request.value);
  }
}

// ============================================
// STYLES
// ============================================
function addStyles() {
  if (document.getElementById("blocknotes-styles")) return;

  const style = document.createElement("style");
  style.id = "blocknotes-styles";
  style.textContent = `
    .blocknotes-list::-webkit-scrollbar {
      width: 8px;
    }
    .blocknotes-list::-webkit-scrollbar-track {
      background: #27272a;
      border-radius: 4px;
    }
    .blocknotes-list::-webkit-scrollbar-thumb {
      background: #52525b;
      border-radius: 4px;
    }
    .blocknotes-list::-webkit-scrollbar-thumb:hover {
      background: #71717a;
    }
    .blocknotes-item:hover {
      background: #3f3f46 !important;
    }
    .blocknotes-header:active {
      cursor: grabbing !important;
    }
  `;
  document.head.appendChild(style);
}

// ============================================
// QUICK SAVE TEXT SELECTION
// ============================================
function handleMouseDown(event) {
  // Hide quick save button if clicking outside of it
  if (state.quickSaveButton && !state.quickSaveButton.contains(event.target)) {
    removeQuickSaveButton();
  }
}

function handleTextSelection() {
  // Don't process if we were dragging - let drag end cleanly
  if (state.isDragging) {
    state.isDragging = false;
    return;
  }

  // Don't recreate button if currently saving
  if (state.isSaving) {
    return;
  }

  const selection = window.getSelection();
  const selectedText = selection.toString().trim();

  // If button exists and is in saved state (green), remove it when new selection is made
  if (state.quickSaveButton && state.quickSaveButton.dataset.saved === "true") {
    removeQuickSaveButton();
  }

  // Remove button if no text selected
  if (!selectedText) {
    removeQuickSaveButton();
    return;
  }

  // Don't show for very short selections (< 3 chars)
  if (selectedText.length < 3) {
    removeQuickSaveButton();
    return;
  }

  state.selectedText = selectedText;
  showQuickSaveButton();
}

function showQuickSaveButton() {
  // Remove existing button if any
  removeQuickSaveButton();

  // Create quick save button at fixed position (bottom-right)
  const button = document.createElement("button");
  button.className = "blocknotes-quick-save";
  button.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
      <polyline points="17 21 17 13 7 13 7 21"/>
      <polyline points="7 3 7 8 15 8"/>
    </svg>
    <span>Note</span>
  `;

  button.style.cssText = `
    position: fixed !important;
    bottom: 24px !important;
    right: 24px !important;
    display: flex !important;
    align-items: center !important;
    gap: 6px !important;
    padding: 10px 14px !important;
    background: rgba(39, 39, 42, 0.95) !important;
    color: #a1a1aa !important;
    border: 1px solid #3f3f46 !important;
    border-radius: 8px !important;
    font-family: 'Inter', -apple-system, sans-serif !important;
    font-size: 12px !important;
    font-weight: 500 !important;
    cursor: pointer !important;
    z-index: 2147483647 !important;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4) !important;
    transition: all 0.2s ease !important;
    animation: quickSaveFadeIn 0.2s ease !important;
    backdrop-filter: blur(8px) !important;
  `;

  // Prevent mousedown from interfering with click
  button.addEventListener(
    "mousedown",
    (e) => {
      e.stopPropagation();
    },
    true,
  );

  // Prevent mouseup from triggering handleTextSelection which would remove the button before click fires
  button.addEventListener(
    "mouseup",
    (e) => {
      e.stopPropagation();
    },
    true,
  );

  button.addEventListener("mouseenter", () => {
    if (button.dataset.saved !== "true") {
      button.style.setProperty(
        "background",
        "rgba(63, 63, 70, 0.98)",
        "important",
      );
      button.style.setProperty("color", "#fafafa", "important");
      button.style.setProperty("border-color", "#52525b", "important");
      button.style.setProperty("transform", "translateY(-1px)", "important");
      button.style.setProperty(
        "box-shadow",
        "0 6px 16px rgba(0, 0, 0, 0.5)",
        "important",
      );
    }
  });

  button.addEventListener("mouseleave", () => {
    if (button.dataset.saved !== "true") {
      button.style.setProperty(
        "background",
        "rgba(39, 39, 42, 0.95)",
        "important",
      );
      button.style.setProperty("color", "#a1a1aa", "important");
      button.style.setProperty("border-color", "#3f3f46", "important");
      button.style.setProperty("transform", "translateY(0)", "important");
      button.style.setProperty(
        "box-shadow",
        "0 4px 12px rgba(0, 0, 0, 0.4)",
        "important",
      );
    }
  });

  button.addEventListener(
    "click",
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      if (!state.selectedText) {
        return;
      }

      // Set saving flag to prevent button recreation
      state.isSaving = true;

      // Turn green and show "Noted!" immediately
      button.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
      <span>Noted!</span>
    `;

      // Completely rebuild the style attribute to ensure it applies
      button.style.cssText = `
      position: fixed !important;
      bottom: 24px !important;
      right: 24px !important;
      display: flex !important;
      align-items: center !important;
      gap: 6px !important;
      padding: 10px 14px !important;
      background: rgba(129, 140, 248, 0.95) !important;
      color: #ffffff !important;
      border: 1px solid rgba(129, 140, 248, 0.95) !important;
      border-radius: 8px !important;
      font-family: 'Inter', -apple-system, sans-serif !important;
      font-size: 12px !important;
      font-weight: 500 !important;
      cursor: default !important;
      z-index: 2147483647 !important;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4) !important;
      transition: none !important;
      pointer-events: none !important;
      backdrop-filter: blur(8px) !important;
    `;

      button.dataset.saved = "true";

      saveSelectedText();

      // Remove button after 1 second and reset flag
      setTimeout(() => {
        removeQuickSaveButton();
        state.isSaving = false;
      }, 1000);
    },
    true,
  );

  document.body.appendChild(button);
  state.quickSaveButton = button;

  // Add animation styles if not already added
  if (!document.getElementById("blocknotes-quicksave-styles")) {
    const style = document.createElement("style");
    style.id = "blocknotes-quicksave-styles";
    style.textContent = `
      @keyframes quickSaveFadeIn {
        from {
          opacity: 0;
          transform: translateY(20px) scale(0.9);
        }
        to {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
      }
    `;
    document.head.appendChild(style);
  }
}

function removeQuickSaveButton() {
  if (state.quickSaveButton) {
    state.quickSaveButton.remove();
    state.quickSaveButton = null;
  }
}

function saveSelectedText() {
  const text = state.selectedText;

  if (!text) return;

  // Limit name to first 50 characters (default fallback)
  const defaultName = text.length > 50 ? text.substring(0, 50) + "..." : text;

  // Format date like main.js does (MM/DD/YYYY)
  const currentDate = new Date();
  const date = `${(currentDate.getMonth() + 1)
    .toString()
    .padStart(2, "0")}/${currentDate
    .getDate()
    .toString()
    .padStart(2, "0")}/${currentDate.getFullYear()}`;
  const timestamp = Date.now();

  // Generate unique ID using timestamp + random to prevent collisions
  const uniqueId = `${timestamp}_${Math.random().toString(36).substr(2, 9)}`;

  chrome.storage.local.get(["notes", "settings"], (data) => {
    const savedNotes = data.notes || {};
    const settings = data.settings || {};
    const noteCount = Object.keys(savedNotes).length;

    // Default purple color to match main app
    const DEFAULT_NOTE_COLOR = "#c4b5fd";

    const noteData = {
      noteText: text,
      noteName: defaultName,
      date: date,
      timestamp: timestamp,
      noteIndex: uniqueId, // Use unique ID instead of counter
      displayIndex: noteCount,
      noteColor: DEFAULT_NOTE_COLOR,
      favorited: false,
      archived: false,
    };

    savedNotes[uniqueId] = noteData;

    chrome.storage.local.set({ notes: savedNotes }, () => {
      if (chrome.runtime.lastError) {
        console.error("BlockNotes: Storage error:", chrome.runtime.lastError);
        return;
      }

      // Notify main page to refresh notes
      chrome.runtime.sendMessage({ action: "noteSaved" });

      // Check if auto-naming is enabled and AI is configured
      const provider = settings.aiProvider;
      const model = settings.aiModel;
      const apiKey = settings.key;
      const customBaseUrl = settings.customBaseUrl || "";
      const hasAIConfigured =
        provider && provider !== "none" && model && apiKey;
      // Defaults to true, user can disable it
      const autonameEnabled = settings.autonameSelection !== false;

      if (autonameEnabled && hasAIConfigured) {
        generateNoteName(text, provider, model, apiKey, customBaseUrl)
          .then((suggestedName) => {
            // Update the note name in storage
            chrome.storage.local.get("notes", (data) => {
              const notes = data.notes || {};
              if (notes[uniqueId]) {
                notes[uniqueId].noteName = suggestedName;
                chrome.storage.local.set({ notes: notes }, () => {
                  // Notify main page to refresh
                  chrome.runtime.sendMessage({ action: "noteSaved" });
                });
              }
            });
          })
          .catch((error) => {
            console.error("BlockNotes: Auto-naming failed:", error);
            // Keep the default name on error
          });
      }
    });
  });
}

// ============================================
// USAGE TRACKING
// ============================================
function incrementNoteUsage(noteIndex) {
  if (!noteIndex) return;

  chrome.storage.local.get("notes", (data) => {
    const savedNotes = data.notes || {};
    if (savedNotes[noteIndex]) {
      savedNotes[noteIndex].usageCount =
        (savedNotes[noteIndex].usageCount || 0) + 1;
      savedNotes[noteIndex].lastUsedAt = Date.now();

      chrome.storage.local.set({ notes: savedNotes }, () => {
        if (chrome.runtime.lastError) {
          console.error(
            "BlockNotes: Failed to update usage:",
            chrome.runtime.lastError,
          );
        }
      });
    }
  });
}

// ============================================
// UTILS
// ============================================
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
