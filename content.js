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
};

// ============================================
// AI AUTO-NAMING
// ============================================
async function generateNoteName(noteText, provider, model, apiKey) {
  const prompt = `Suggest a concise and meaningful title for the following note content:\n"${noteText}".
    IT IS VERY CRITICALLY IMPORTANT YOU ANSWER WITH ONLY ONE NAME.
    Do your best to capture what the note actually contains so it is easy to remember what it was about later.
    Maximum 5 words suggested name.
    If the note text is not understandable just combine a random color with a random animal and a random 2-digit number.
    IT IS VERY CRITICALLY IMPORTANT YOU ANSWER DIRECTLY WITH ONLY ONE NAME.`;

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
          }
        );
        const data = await response.json();
        if (!response.ok || !data.candidates || !data.candidates[0]) {
          throw new Error("Gemini API error");
        }
        return data.candidates[0].content.parts[0].text.trim();
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
          }
        );
        const data = await response.json();
        if (!response.ok || !data.choices || !data.choices[0]) {
          throw new Error("OpenAI API error");
        }
        return data.choices[0].message.content.trim();
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
        return data.content[0].text.trim();
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
          }
        );
        const data = await response.json();
        if (!response.ok || !data.choices || !data.choices[0]) {
          throw new Error("Groq API error");
        }
        return data.choices[0].message.content.trim();
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

  // Log iframe context for debugging
  const inIframe = window !== window.top;
  const isSandboxed = document.origin === "null" || document.origin === "about:blank";
  console.log("✓ BlockNotes loaded", {
    url: window.location.href,
    inIframe,
    isSandboxed,
    origin: document.origin,
    readyState: document.readyState
  });
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
  if (el.tagName === "INPUT" && ["text", "search", "email", "url", ""].includes(el.type || "")) return true;
  if (el.isContentEditable) return true;

  // Check for contenteditable attribute explicitly (Google Docs uses this)
  if (el.getAttribute && el.getAttribute("contenteditable") === "true") return true;

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
      "gmail_default"
    ];
    if (editorClasses.some((cls) => el.className.includes(cls))) return true;
  }

  // Check for role="textbox"
  if (el.getAttribute && el.getAttribute("role") === "textbox") return true;

  // Check ARIA labels for Google Docs
  if (el.getAttribute) {
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel && ariaLabel.toLowerCase().includes("document")) return true;
    // Gmail compose body aria-label
    if (ariaLabel && ariaLabel.toLowerCase().includes("message body")) return true;
  }

  // Gmail compose - check for specific Gmail elements (multiple selectors for robustness)
  if (el.closest && el.closest('[aria-label="Message Body"]')) return true;
  if (el.closest && el.closest('[aria-label="Message body"]')) return true;
  if (el.closest && el.closest('.editable[contenteditable="true"]')) return true;
  if (el.closest && el.closest('[role="textbox"][contenteditable="true"]')) return true;
  if (el.closest && el.closest('div[contenteditable="true"][aria-multiline="true"]')) return true;
  if (el.closest && el.closest('[g_editable="true"]')) return true; // Gmail specific
  if (el.closest && el.closest('.Am')) return true; // Gmail compose area class
  if (el.closest && el.closest('[contenteditable="true"]')) return true; // Any contenteditable ancestor

  return false;
}

// ============================================
// INPUT DETECTION
// ============================================
function handleInput(event) {
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
  // Special handler for "/" key - especially for Gmail and contenteditable elements
  if (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.shiftKey && !state.isPopupOpen) {
    const target = event.target;
    const isGmail = window.location.hostname.includes("mail.google.com");

    // Debug logging for Gmail
    if (isGmail) {
      console.log("BlockNotes: Slash pressed in Gmail", {
        target: target.tagName,
        isContentEditable: target.isContentEditable,
        classList: target.className,
        parentContentEditable: target.parentElement?.isContentEditable,
        closestContentEditable: target.closest?.('[contenteditable="true"]'),
        activeElement: document.activeElement?.tagName,
        activeElementEditable: document.activeElement?.isContentEditable,
      });
    }

    // Find the actual contenteditable container (Gmail nests divs inside it)
    let contentEditableContainer = target.closest?.('[contenteditable="true"]') ||
                                     (target.isContentEditable ? target : null) ||
                                     (target.parentElement?.isContentEditable ? target.parentElement : null);

    // For Gmail, also check the active element since target might be a nested div
    if (!contentEditableContainer && document.activeElement) {
      contentEditableContainer = document.activeElement.closest?.('[contenteditable="true"]') ||
                                 (document.activeElement.isContentEditable ? document.activeElement : null);
    }

    // Gmail-specific: Check for Gmail's compose body more aggressively
    const gmailComposeBody = isGmail && (
      target.closest?.('[aria-label="Message Body"]') ||
      target.closest?.('[aria-label="Message body"]') ||
      target.closest?.('[g_editable="true"]') ||
      target.closest?.('.editable[contenteditable="true"]') ||
      target.closest?.('.Am.Al.editable') ||
      target.closest?.('div[aria-multiline="true"]') ||
      document.activeElement?.closest?.('[aria-label="Message Body"]') ||
      document.activeElement?.closest?.('[aria-label="Message body"]') ||
      document.activeElement?.closest?.('[g_editable="true"]') ||
      document.activeElement?.closest?.('.editable[contenteditable="true"]')
    );

    // For Gmail, be more permissive - if we're on Gmail and "/" is pressed in any div, try to open
    const isInGmailCompose = isGmail && (
      contentEditableContainer ||
      gmailComposeBody ||
      target.tagName === "DIV" ||
      target.closest?.('.editable') ||
      target.closest?.('[role="textbox"]') ||
      target.closest?.('.Am') ||
      target.closest?.('.aoI') ||  // Gmail compose container
      document.activeElement?.isContentEditable ||
      document.activeElement?.closest?.('[contenteditable="true"]')
    );

    // For other sites, use standard contenteditable detection
    const isInContentEditable = contentEditableContainer || target.isContentEditable;

    if (isInGmailCompose || isInContentEditable) {
      // Use the Gmail compose body, contenteditable container, or the target
      const focusElement = gmailComposeBody || contentEditableContainer || document.activeElement || target;

      console.log("BlockNotes: Opening popup for:", focusElement?.tagName, "Gmail:", isGmail, "Element:", focusElement);

      state.lastSlashDetected = true;
      state.lastFocusedElement = focusElement;

      setTimeout(() => {
        try {
          chrome.storage.local.get(["settings", "notes"], (data) => {
            if (chrome.runtime.lastError) {
              console.log("BlockNotes: Extension context invalidated.");
              return;
            }
            state.notes = data.notes || {};
            showPopup();
          });
        } catch (error) {
          console.log("BlockNotes: Extension context invalidated.");
        }
      }, 100);
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
        'textarea:not([disabled])',
        'input[type="text"]:not([disabled])',
        '.kix-lineview',  // Google Docs
        '.kix-cursor',  // Google Docs cursor area
        '.kix-page',  // Google Docs page
        '.docs-texteventtarget',  // Google Docs text target
        '.docs-texteventtarget-iframe',  // Google Docs iframe
        '[aria-label*="Document content"]',  // Google Docs ARIA label
        '[aria-label*="document"]',
        '.kix-appview-editor',  // Google Docs editor
      ];

      console.log("BlockNotes: Searching for valid input in document...");

      for (const selector of selectors) {
        const element = document.querySelector(selector);
        console.log(`BlockNotes: Trying selector "${selector}":`, element);
        if (element && isInput(element)) {
          target = element;
          console.log("BlockNotes: Found valid input:", element);
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
        try {
          chrome.storage.local.get(["settings", "notes"], (data) => {
            if (chrome.runtime.lastError) {
              console.log("BlockNotes: Extension context invalidated. Please reload the page.");
              return;
            }
            state.notes = data.notes || {};
            showPopup();
          });
        } catch (error) {
          console.log("BlockNotes: Extension context invalidated. Please reload the page.");
        }
      }
    } else {
      console.log("BlockNotes: No valid text input found. Please click in a text field first.");
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

  popup.appendChild(header);
  popup.appendChild(list);
  document.body.appendChild(popup);

  state.popupContainer = popup;

  // Setup listeners
  if (hasTarget) {
    state.lastFocusedElement.addEventListener("input", updateResults);
  }
  document.addEventListener("click", handleClickOutside);
  document.addEventListener("keydown", handlePopupKeydown, true);

  // Initial render
  updateResults();

  // Add styles
  addStyles();
}

function getPopupStyles(hasTarget = true) {
  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;
  const maxHeight = 320;
  const width = Math.min(380, viewportWidth - 40);
  const spacing = 8;

  // If no target element, center the popup
  if (!hasTarget) {
    return `
      position: fixed;
      width: ${width}px;
      background: #27272a;
      border: 1px solid #3f3f46;
      border-radius: 16px;
      box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5), 0 4px 12px rgba(0, 0, 0, 0.3);
      z-index: 2147483647;
      overflow: hidden;
      max-height: ${maxHeight}px;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
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
      window.getComputedStyle(el).paddingLeft || "0"
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
    position: fixed;
    top: ${top}px;
    left: ${left}px;
    width: ${width}px;
    max-height: ${maxHeight}px;
    background: #27272a;
    border: 1px solid #3f3f46;
    border-radius: 16px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5), 0 4px 12px rgba(0, 0, 0, 0.3);
    z-index: 2147483647;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    overflow: hidden;
    transition: opacity 0.15s ease;
  `;
}

function getListStyles() {
  return `
    margin: 0;
    padding: 3px;
    list-style: none;
    max-height: 280px;
    overflow-y: auto;
  `;
}

// ============================================
// UPDATE & RENDER
// ============================================
function updateResults() {
  if (!state.popupContainer) return;

  const list = state.popupContainer.querySelector(".blocknotes-list");
  if (!list) return;

  const query = extractQuery();
  const matches = filterNotes(query);

  renderResults(list, matches);
}

function extractQuery() {
  const value = getValue(state.lastFocusedElement);
  const lastSlash = value.lastIndexOf("/");

  // Return everything after the last slash, keep spaces and numbers
  if (lastSlash >= 0) {
    return value.substring(lastSlash + 1).trim();
  }
  return "";
}

function filterNotes(query) {
  // Normalize query for better matching
  const normalizedQuery = query.toLowerCase();

  return Object.values(state.notes)
    .filter((note) => {
      if (!normalizedQuery) return true;

      const name = (note.noteName || "").toLowerCase();
      const text = (note.noteText || "").toLowerCase();

      // Match if query appears anywhere in name or text
      return name.includes(normalizedQuery) || text.includes(normalizedQuery);
    })
    .sort((a, b) => {
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

function renderResults(list, matches) {
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

  matches.forEach((note, i) => {
    const li = document.createElement("li");
    li.className = "blocknotes-item";

    const name = note.noteName || `Note ${note.noteIndex + 1}`;
    const preview =
      note.noteText.length > 50
        ? note.noteText.substring(0, 50) + "..."
        : note.noteText;
    const noteColor = note.noteColor || '#c4b5fd';

    li.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 2px;">
        <span style="width: 10px; height: 10px; border-radius: 3px; background: ${noteColor}; flex-shrink: 0;"></span>
        <span style="font-weight: 600; font-size: 13px; color: #f1f5f9;">${escapeHtml(name)}</span>
      </div>
      <div style="font-size: 12px; color: #94a3b8; line-height: 1.3; margin-left: 18px;">${escapeHtml(
        preview
      )}</div>
    `;

    li.style.cssText = getItemStyles(i === state.selectedIndex);

    li.addEventListener("mouseenter", () => selectItem(i));
    li.addEventListener("click", () => {
      handleNoteInsertion(note.noteText);
      incrementNoteUsage(note.noteIndex);
      closePopup();
    });

    list.appendChild(li);
  });

  // Ensure selected is visible
  const selected = list.children[state.selectedIndex];
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

  Array.from(list.children).forEach((item, i) => {
    item.style.cssText = getItemStyles(i === index);
  });
}

function handlePopupKeydown(event) {
  if (!state.popupContainer) return;

  const list = state.popupContainer.querySelector(".blocknotes-list");
  const items = list?.children || [];
  const max = items.length - 1;

  switch (event.key) {
    case "ArrowDown":
      event.preventDefault();
      event.stopPropagation();
      selectItem(state.selectedIndex < max ? state.selectedIndex + 1 : 0);
      break;

    case "ArrowUp":
      event.preventDefault();
      event.stopPropagation();
      selectItem(state.selectedIndex > 0 ? state.selectedIndex - 1 : max);
      break;

    case "Enter":
      event.preventDefault();
      event.stopPropagation();
      const matches = filterNotes(extractQuery());
      if (matches[state.selectedIndex]) {
        handleNoteInsertion(matches[state.selectedIndex].noteText);
        incrementNoteUsage(matches[state.selectedIndex].noteIndex);
        closePopup();
      }
      break;

    case "Escape":
      event.preventDefault();
      event.stopPropagation();
      closePopup();
      break;

    case "Backspace":
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
        if (cursorPos !== undefined && lastSlashPos >= 0 && cursorPos === lastSlashPos + 1) {
          // The next backspace will delete the slash
          closePopup();
        }
      }
      break;
  }
}

function handleClickOutside(event) {
  if (!state.popupContainer) return;
  if (state.popupContainer.contains(event.target)) return;
  if (state.lastFocusedElement === event.target) return;
  closePopup();
}

function closePopup() {
  // Always clean up listeners and reset state, even if popupContainer is already null
  // (prevents stuck state if container was removed externally)
  state.lastFocusedElement?.removeEventListener("input", updateResults);
  document.removeEventListener("click", handleClickOutside);
  document.removeEventListener("keydown", handlePopupKeydown, true);
  document.removeEventListener("mousemove", handleDragMove);
  document.removeEventListener("mouseup", handleDragEnd);

  if (state.popupContainer) {
    state.popupContainer.remove();
  }
  state.popupContainer = null;
  state.isPopupOpen = false;
  state.lastSlashDetected = false;
  state.selectedIndex = 0;
  state.isDragging = false;
  state.savedRange = null;
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
  // Always copy to clipboard first as safety net
  navigator.clipboard.writeText(text).catch(() => {});

  // Google Docs uses custom canvas rendering - execCommand won't work
  const isGoogleDocs = window.location.hostname.includes("docs.google.com");
  if (isGoogleDocs) {
    showToast("Press Ctrl/Cmd+V to paste", "Note copied to clipboard");
    return;
  }

  // Try direct insertion
  pasteNote(text);
}

// Toast notification for clipboard fallback
function showToast(message, subtitle) {
  // Remove existing toast if any
  const existing = document.querySelector('.blocknotes-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'blocknotes-toast';
  toast.innerHTML = `
    <div style="font-weight: 600;">${escapeHtml(message)}</div>
    ${subtitle ? `<div style="font-size: 12px; opacity: 0.8; margin-top: 2px;">${escapeHtml(subtitle)}</div>` : ''}
  `;
  toast.style.cssText = `
    position: fixed;
    bottom: 24px;
    right: 24px;
    background: #1e293b;
    color: #f1f5f9;
    padding: 12px 16px;
    border-radius: 8px;
    font-family: 'Inter', -apple-system, sans-serif;
    font-size: 14px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    border: 1px solid #334155;
    z-index: 2147483647;
    animation: blocknotes-toast-in 0.2s ease;
  `;

  // Add animation keyframes if not exists
  if (!document.getElementById('blocknotes-toast-styles')) {
    const style = document.createElement('style');
    style.id = 'blocknotes-toast-styles';
    style.textContent = `
      @keyframes blocknotes-toast-in {
        from { opacity: 0; transform: translateY(10px); }
        to { opacity: 1; transform: translateY(0); }
      }
    `;
    document.head.appendChild(style);
  }

  document.body.appendChild(toast);

  // Auto-remove after 3 seconds
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.2s ease';
    setTimeout(() => toast.remove(), 200);
  }, 3000);
}

// Try to auto-fill placeholders from page context
function tryAutoFillPlaceholders(inputs, placeholders) {
  const context = getPageContext();

  placeholders.forEach(placeholder => {
    const input = inputs[placeholder];
    if (!input || input.value) return; // Skip if already has value

    const lowerPlaceholder = placeholder.toLowerCase();
    let value = null;

    // Match placeholder names to context data
    if (lowerPlaceholder.includes('name') && !lowerPlaceholder.includes('company')) {
      value = context.recipientName || context.profileName;
    } else if (lowerPlaceholder.includes('company') || lowerPlaceholder.includes('organization')) {
      value = context.company;
    } else if (lowerPlaceholder.includes('title') || lowerPlaceholder.includes('position') || lowerPlaceholder.includes('role')) {
      value = context.jobTitle;
    } else if (lowerPlaceholder.includes('email')) {
      value = context.email;
    } else if (lowerPlaceholder.includes('topic') || lowerPlaceholder.includes('subject')) {
      value = context.subject || context.pageTitle;
    } else if (lowerPlaceholder.includes('location') || lowerPlaceholder.includes('city')) {
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
  if (context.siteName.includes('mail.google.com')) {
    // Try to get recipient from To field
    const toField = document.querySelector('[name="to"]') ||
                    document.querySelector('[data-hovercard-id]') ||
                    document.querySelector('.agP');
    if (toField) {
      const text = toField.value || toField.textContent || '';
      // Extract name from "Name <email>" format
      const nameMatch = text.match(/^([^<]+)</);
      context.recipientName = nameMatch ? nameMatch[1].trim() : text.split('@')[0];
      context.email = text.match(/[\w.-]+@[\w.-]+/) ? text.match(/[\w.-]+@[\w.-]+/)[0] : '';
    }

    // Try to get subject
    const subjectField = document.querySelector('[name="subjectbox"]') ||
                        document.querySelector('.hP');
    if (subjectField) {
      context.subject = subjectField.value || subjectField.textContent;
    }
  }

  // LinkedIn-specific selectors
  if (context.siteName.includes('linkedin.com')) {
    // Profile page
    const profileName = document.querySelector('.text-heading-xlarge') ||
                       document.querySelector('.pv-text-details__left-panel h1');
    if (profileName) {
      context.profileName = profileName.textContent.trim();
    }

    const jobTitle = document.querySelector('.text-body-medium.break-words') ||
                    document.querySelector('.pv-text-details__left-panel .text-body-medium');
    if (jobTitle) {
      context.jobTitle = jobTitle.textContent.trim();
    }

    const company = document.querySelector('[data-field="experience_company_logo"]')?.closest('li')?.querySelector('span[aria-hidden="true"]') ||
                   document.querySelector('.pv-text-details__right-panel .inline-show-more-text');
    if (company) {
      context.company = company.textContent.trim();
    }

    const location = document.querySelector('.text-body-small.inline.t-black--light.break-words');
    if (location) {
      context.location = location.textContent.trim();
    }
  }

  // Generic fallbacks - look for common patterns
  if (!context.recipientName) {
    // Try to find any name-like element
    const h1 = document.querySelector('h1');
    if (h1 && h1.textContent.split(' ').length <= 4) {
      context.profileName = h1.textContent.trim();
    }
  }

  return context;
}

function showPlaceholderPrompt(noteText, placeholders) {
  // Save the focused element and selection range before showing prompt
  const targetElement = state.lastFocusedElement;
  const savedRange = state.savedRange;

  const promptContainer = document.createElement("div");
  promptContainer.className = "blocknotes-placeholder-prompt";
  promptContainer.style.cssText = `
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 420px;
    max-width: 90vw;
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 16px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
    z-index: 2147483647;
    font-family: 'Inter', -apple-system, sans-serif;
    overflow: hidden;
    animation: placeholderPromptFadeIn 0.2s ease;
  `;

  // Header
  const header = document.createElement("div");
  header.style.cssText = `
    padding: 16px 20px;
    border-bottom: 1px solid #334155;
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: #334155;
  `;

  const title = document.createElement("h3");
  title.textContent = "Fill in values";
  title.style.cssText = `
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    color: #f1f5f9;
  `;

  const closeBtn = document.createElement("button");
  closeBtn.innerHTML = "×";
  closeBtn.style.cssText = `
    background: transparent;
    border: none;
    font-size: 24px;
    color: #94a3b8;
    cursor: pointer;
    padding: 0;
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    transition: all 0.15s ease;
  `;

  closeBtn.addEventListener("mouseenter", () => {
    closeBtn.style.background = "#475569";
    closeBtn.style.color = "#f1f5f9";
  });

  closeBtn.addEventListener("mouseleave", () => {
    closeBtn.style.background = "transparent";
    closeBtn.style.color = "#94a3b8";
  });

  closeBtn.addEventListener("click", () => {
    promptContainer.remove();
  });

  header.appendChild(title);
  header.appendChild(closeBtn);

  // Form
  const form = document.createElement("form");
  form.style.cssText = `
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    max-height: 60vh;
    overflow-y: auto;
  `;

  // Auto-fill toggle
  const autoFillContainer = document.createElement("div");
  autoFillContainer.style.cssText = `
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    background: rgba(129, 140, 248, 0.1);
    border: 1px solid rgba(129, 140, 248, 0.2);
    border-radius: 8px;
    margin-bottom: 4px;
  `;

  const autoFillLabel = document.createElement("label");
  autoFillLabel.style.cssText = `
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: #f1f5f9;
    cursor: pointer;
  `;
  autoFillLabel.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#818cf8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
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
    width: 18px;
    height: 18px;
    cursor: pointer;
    accent-color: #818cf8;
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
      Object.values(inputs).forEach(input => {
        if (input.dataset.autofilled) {
          input.value = "";
          input.style.borderColor = "#334155";
          delete input.dataset.autofilled;
        }
      });
    }
  });

  autoFillLabel.appendChild(autoFillToggle);
  autoFillContainer.appendChild(autoFillLabel);
  form.appendChild(autoFillContainer);

  const inputs = {};

  placeholders.forEach((placeholder, index) => {
    const fieldGroup = document.createElement("div");
    fieldGroup.style.cssText = `
      display: flex;
      flex-direction: column;
      gap: 6px;
    `;

    const label = document.createElement("label");
    label.textContent = placeholder;
    label.style.cssText = `
      font-size: 13px;
      font-weight: 600;
      color: #f1f5f9;
    `;

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = `Enter ${placeholder}`;
    input.style.cssText = `
      padding: 10px 12px;
      border: 1px solid #334155;
      border-radius: 8px;
      font-family: 'Inter', -apple-system, sans-serif;
      font-size: 14px;
      color: #f1f5f9;
      background: #334155;
      outline: none;
      transition: all 0.2s ease;
    `;

    input.addEventListener("focus", () => {
      input.style.borderColor = "#818cf8";
      input.style.boxShadow = "0 0 0 3px rgba(129, 140, 248, 0.15)";
    });

    input.addEventListener("blur", () => {
      input.style.borderColor = "#334155";
      input.style.boxShadow = "none";
    });

    inputs[placeholder] = input;

    fieldGroup.appendChild(label);
    fieldGroup.appendChild(input);
    form.appendChild(fieldGroup);

    // Auto-focus first input
    if (index === 0) {
      setTimeout(() => input.focus(), 100);
    }
  });

  // Buttons
  const buttonGroup = document.createElement("div");
  buttonGroup.style.cssText = `
    display: flex;
    gap: 10px;
    justify-content: flex-end;
    margin-top: 4px;
  `;

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "Cancel";
  cancelBtn.style.cssText = `
    padding: 8px 16px;
    border: 1px solid #334155;
    border-radius: 8px;
    background: #334155;
    color: #94a3b8;
    font-family: 'Inter', -apple-system, sans-serif;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s ease;
  `;

  cancelBtn.addEventListener("mouseenter", () => {
    cancelBtn.style.background = "#475569";
    cancelBtn.style.color = "#f1f5f9";
  });

  cancelBtn.addEventListener("mouseleave", () => {
    cancelBtn.style.background = "#334155";
    cancelBtn.style.color = "#94a3b8";
  });

  cancelBtn.addEventListener("click", () => {
    promptContainer.remove();
  });

  const insertBtn = document.createElement("button");
  insertBtn.type = "submit";
  insertBtn.textContent = "Insert";
  insertBtn.style.cssText = `
    padding: 8px 16px;
    border: 1px solid #818cf8;
    border-radius: 8px;
    background: #818cf8;
    color: white;
    font-family: 'Inter', -apple-system, sans-serif;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s ease;
  `;

  insertBtn.addEventListener("mouseenter", () => {
    insertBtn.style.background = "#6366f1";
    insertBtn.style.borderColor = "#6366f1";
  });

  insertBtn.addEventListener("mouseleave", () => {
    insertBtn.style.background = "#818cf8";
    insertBtn.style.borderColor = "#818cf8";
  });

  buttonGroup.appendChild(cancelBtn);
  buttonGroup.appendChild(insertBtn);
  form.appendChild(buttonGroup);

  // Handle form submission
  form.addEventListener("submit", (e) => {
    e.preventDefault();

    // Restore the original focused element and saved range
    state.lastFocusedElement = targetElement;
    state.savedRange = savedRange;

    let finalText = noteText;

    // Replace all placeholders with input values
    placeholders.forEach((placeholder) => {
      const value = inputs[placeholder].value || `{{${placeholder}}}`;
      const regex = new RegExp(`\\{\\{${placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}\\}`, "g");
      finalText = finalText.replace(regex, value);
    });

    promptContainer.remove();
    pasteNoteWithFallback(finalText);
  });

  // Handle escape key to close
  const handleEscape = (e) => {
    if (e.key === "Escape") {
      promptContainer.remove();
      document.removeEventListener("keydown", handleEscape);
    }
  };
  document.addEventListener("keydown", handleEscape);

  promptContainer.appendChild(header);
  promptContainer.appendChild(form);
  document.body.appendChild(promptContainer);

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
    `;
    document.head.appendChild(style);
  }
}

// ============================================
// PASTE
// ============================================
function pasteNote(text) {
  const el = state.lastFocusedElement;
  if (!el) return;

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
      "value"
    )?.set;
    if (nativeSetter) {
      nativeSetter.call(el, content);
    }

    // Move cursor to end
    el.setSelectionRange(content.length, content.length);
  } else if (el.isContentEditable) {
    // For contenteditable, we need to handle newlines properly
    // especially for Gmail and similar rich text editors
    const isGmail = window.location.hostname.includes("mail.google.com");

    if (isGmail) {
      // Gmail needs special handling - insert at cursor position with range manipulation
      // Use saved range since clicking popup loses the selection
      let range = state.savedRange;
      if (!range) {
        const selection = window.getSelection();
        if (selection.rangeCount > 0) {
          range = selection.getRangeAt(0);
        }
      }

      if (range) {
        let insertContainer = range.startContainer;
        let insertOffset = range.startOffset;

        // Delete the "/" character and search query if they exist
        if (slashIndex >= 0 && insertContainer.nodeType === Node.TEXT_NODE) {
          const textContent = insertContainer.textContent || '';

          // Find the "/" position in this text node
          const slashPosInText = textContent.lastIndexOf('/');

          if (slashPosInText >= 0) {
            // Get the search query to calculate how much to delete
            const searchQuery = extractQuery();
            // Calculate end position: slash + 1 (for "/") + query length
            const endPos = Math.min(slashPosInText + 1 + searchQuery.length, textContent.length);

            // Delete from slash through the search query
            const deleteRange = document.createRange();
            deleteRange.setStart(insertContainer, slashPosInText);
            deleteRange.setEnd(insertContainer, endPos);
            deleteRange.deleteContents();

            // Update insert position to where "/" was
            insertOffset = slashPosInText;
          }
        }

        // Create a new range at the insert position
        range = document.createRange();
        range.setStart(insertContainer, insertOffset);
        range.collapse(true);

        // Now insert the note text at current cursor position
        // Split note text by newlines and insert with proper formatting
        const lines = text.split('\n');
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index];
          const textNode = document.createTextNode(line);
          range.insertNode(textNode);
          range.setStartAfter(textNode);
          range.setEndAfter(textNode);
          range.collapse(false);

          if (index < lines.length - 1) {
            // Insert line break
            const br = document.createElement('br');
            range.insertNode(br);
            range.setStartAfter(br);
            range.setEndAfter(br);
            range.collapse(false);
          }
        }

        // Move cursor to end
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);

        // Clear saved range after use
        state.savedRange = null;
      } else {
        el.textContent = content;
      }
    } else {
      // Standard contenteditable - use textContent
      el.textContent = content;

      // Move cursor to end
      const range = document.createRange();
      const sel = window.getSelection();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  // Update previous value
  state.previousValue = content;

  // Trigger events
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.focus();
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
  showQuickSaveButton(selection);
}

function showQuickSaveButton(selection) {
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
  button.addEventListener("mousedown", (e) => {
    e.stopPropagation();
  }, true);

  // Prevent mouseup from triggering handleTextSelection which would remove the button before click fires
  button.addEventListener("mouseup", (e) => {
    e.stopPropagation();
  }, true);

  button.addEventListener("mouseenter", () => {
    if (button.dataset.saved !== "true") {
      button.style.setProperty('background', 'rgba(63, 63, 70, 0.98)', 'important');
      button.style.setProperty('color', '#fafafa', 'important');
      button.style.setProperty('border-color', '#52525b', 'important');
      button.style.setProperty('transform', 'translateY(-1px)', 'important');
      button.style.setProperty('box-shadow', '0 6px 16px rgba(0, 0, 0, 0.5)', 'important');
    }
  });

  button.addEventListener("mouseleave", () => {
    if (button.dataset.saved !== "true") {
      button.style.setProperty('background', 'rgba(39, 39, 42, 0.95)', 'important');
      button.style.setProperty('color', '#a1a1aa', 'important');
      button.style.setProperty('border-color', '#3f3f46', 'important');
      button.style.setProperty('transform', 'translateY(0)', 'important');
      button.style.setProperty('box-shadow', '0 4px 12px rgba(0, 0, 0, 0.4)', 'important');
    }
  });

  button.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    console.log("BlockNotes: Save button clicked! Text:", state.selectedText);
    console.log("BlockNotes: Button element:", button);
    console.log("BlockNotes: Current button background:", window.getComputedStyle(button).background);

    if (!state.selectedText) {
      console.error("BlockNotes: No text selected!");
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
    console.log("BlockNotes: Button updated to purple 'Noted!' state");
    console.log("BlockNotes: New button background:", window.getComputedStyle(button).background);

    saveSelectedText();

    // Remove button after 1 second and reset flag
    setTimeout(() => {
      console.log("BlockNotes: Removing save button after 1 second");
      removeQuickSaveButton();
      state.isSaving = false;
    }, 1000);
  }, true);

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
  console.log("BlockNotes: saveSelectedText called, text:", text);

  if (!text) {
    console.error("BlockNotes: No text to save!");
    return;
  }

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

    console.log("BlockNotes: Existing notes:", noteCount);
    console.log("BlockNotes: New unique ID:", uniqueId);

    // Default purple color to match main app
    const DEFAULT_NOTE_COLOR = '#c4b5fd';

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

      console.log("BlockNotes: Note saved successfully!", noteData);
      console.log("BlockNotes: Quick saved note:", defaultName);

      // Notify main page to refresh notes
      chrome.runtime.sendMessage({ action: "noteSaved" });

      // Check if auto-naming is enabled and AI is configured
      const provider = settings.aiProvider;
      const model = settings.aiModel;
      const apiKey = settings.key;
      const hasAIConfigured = provider && provider !== "none" && model && apiKey;
      // Defaults to true, user can disable it
      const autonameEnabled = settings.autonameSelection !== false;

      if (autonameEnabled && hasAIConfigured) {
        console.log("BlockNotes: Auto-naming enabled, calling AI...");
        generateNoteName(text, provider, model, apiKey)
          .then((suggestedName) => {
            console.log("BlockNotes: AI suggested name:", suggestedName);
            // Update the note name in storage
            chrome.storage.local.get("notes", (data) => {
              const notes = data.notes || {};
              if (notes[uniqueId]) {
                notes[uniqueId].noteName = suggestedName;
                chrome.storage.local.set({ notes: notes }, () => {
                  console.log("BlockNotes: Note name updated to:", suggestedName);
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
      savedNotes[noteIndex].usageCount = (savedNotes[noteIndex].usageCount || 0) + 1;
      savedNotes[noteIndex].lastUsedAt = Date.now();

      chrome.storage.local.set({ notes: savedNotes }, () => {
        if (chrome.runtime.lastError) {
          console.error("BlockNotes: Failed to update usage:", chrome.runtime.lastError);
          return;
        }
        console.log("BlockNotes: Usage tracked for note:", noteIndex);
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
