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
    parentIsGoogleDocs = window.parent.location.hostname.includes("docs.google.com") ||
                         window.parent.location.hostname.includes("drive.google.com");
  } catch (e) {
    // Cross-origin, can't check - but if we're in a small iframe, likely should delegate
  }

  return isGoogleDocsInputIframe || isTinyIframe || parentIsGoogleDocs;
}

// Send message to parent frame to show popup
function requestPopupInParent() {
  try {
    window.parent.postMessage({
      type: BLOCKNOTES_MESSAGE_TYPE,
      action: "showPopup"
    }, "*");
    console.log("BlockNotes: Sent popup request to parent frame");
    return true;
  } catch (e) {
    console.log("BlockNotes: Failed to send message to parent:", e);
    return false;
  }
}

// Handle messages from child frames
function handleCrossFrameMessage(event) {
  // Validate message
  if (!event.data || event.data.type !== BLOCKNOTES_MESSAGE_TYPE) return;

  console.log("BlockNotes: Received cross-frame message:", event.data);

  if (event.data.action === "showPopup") {
    // Store reference to source window for sending note back
    state.crossFrameSource = event.source;

    // Load notes and show popup in this (parent) frame
    chrome.storage.local.get(["settings", "notes"], (data) => {
      if (chrome.runtime.lastError) {
        console.log("BlockNotes: Extension context invalidated.");
        return;
      }
      state.notes = data.notes || {};
      state.lastFocusedElement = null; // No specific element, will center popup
      state.isCrossFramePopup = true; // Flag to handle note selection differently
      showPopup();
    });
  }

  if (event.data.action === "insertNote") {
    // Received note text from parent frame - insert it
    const noteText = event.data.noteText;
    console.log("BlockNotes: Received note to insert from parent:", noteText);

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
    console.log("BlockNotes: Error inserting text:", e);
  }
  return false;
}

// Send selected note to child frame
function sendNoteToChildFrame(noteText) {
  if (state.crossFrameSource) {
    try {
      state.crossFrameSource.postMessage({
        type: BLOCKNOTES_MESSAGE_TYPE,
        action: "insertNote",
        noteText: noteText
      }, "*");
      console.log("BlockNotes: Sent note to child frame");
      return true;
    } catch (e) {
      console.log("BlockNotes: Failed to send note to child frame:", e);
    }
  }
  return false;
}

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

  // Listen for cross-frame messages (for Google Docs/Drive iframe popup delegation)
  window.addEventListener("message", handleCrossFrameMessage);

  // Log iframe context for debugging
  const inIframe = window !== window.top;
  const isSandboxed = document.origin === "null" || document.origin === "about:blank";
  const isGoogleDocs = window.location.hostname.includes("docs.google.com");

  console.log("✓ BlockNotes loaded", {
    url: window.location.href,
    inIframe,
    isSandboxed,
    origin: document.origin,
    readyState: document.readyState,
    isGoogleDocs,
  });

  // Additional Google Docs debugging on load
  if (isGoogleDocs) {
    console.log("📋 [GDocs Debug] Google Docs detected at init!");

    // Set up a mutation observer to watch for dynamically added elements
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node;
            // Check if this is a text input related element
            if (el.matches?.('.docs-texteventtarget-iframe, .docs-texteventtarget, [contenteditable="true"], iframe')) {
              console.log("📋 [GDocs Debug] MutationObserver: New relevant element added:", {
                tagName: el.tagName,
                className: el.className,
                id: el.id,
              });
            }
            // Also check children
            const relevantChildren = el.querySelectorAll?.('.docs-texteventtarget-iframe, .docs-texteventtarget, [contenteditable="true"], iframe');
            if (relevantChildren?.length > 0) {
              console.log(`📋 [GDocs Debug] MutationObserver: ${relevantChildren.length} relevant children added`);
            }
          }
        }
      }
    });

    // Start observing after a short delay
    setTimeout(() => {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
      });
      console.log("📋 [GDocs Debug] MutationObserver started");
    }, 1000);

    // Add click listener to see what element gets focused
    document.addEventListener("click", (e) => {
      console.log("📋 [GDocs Debug] Click event:", {
        target: e.target.tagName,
        targetClass: e.target.className,
        targetId: e.target.id,
        activeElement: document.activeElement?.tagName,
        activeElementClass: document.activeElement?.className,
      });
    }, true);

    // Delay the DOM inspection to allow Google Docs to fully render
    setTimeout(() => {
      console.log("📋 [GDocs Debug] DOM inspection after 2s delay:");

      // Look for key Google Docs elements
      const elements = {
        "kix-appview-editor": document.querySelector(".kix-appview-editor"),
        "kix-page": document.querySelector(".kix-page"),
        "kix-canvas-tile-content": document.querySelector(".kix-canvas-tile-content"),
        "docs-texteventtarget-iframe": document.querySelector(".docs-texteventtarget-iframe"),
        "docs-texteventtarget": document.querySelector(".docs-texteventtarget"),
        "kix-cursor": document.querySelector(".kix-cursor"),
        "kix-lineview": document.querySelector(".kix-lineview"),
        "contenteditable elements": document.querySelectorAll('[contenteditable="true"]'),
        "role=textbox elements": document.querySelectorAll('[role="textbox"]'),
        "all iframes": document.querySelectorAll("iframe"),
      };

      for (const [name, el] of Object.entries(elements)) {
        if (el instanceof NodeList || el instanceof HTMLCollection) {
          console.log(`📋 [GDocs Debug] ${name}: ${el.length} found`);
          if (el.length > 0 && el.length <= 5) {
            Array.from(el).forEach((item, i) => {
              console.log(`  - [${i}] ${item.tagName} class="${item.className}" id="${item.id}"`);
            });
          }
        } else {
          console.log(`📋 [GDocs Debug] ${name}: ${el ? "FOUND" : "NOT FOUND"}`);
          if (el) {
            console.log(`  - tagName: ${el.tagName}, class: ${el.className}, id: ${el.id}`);
          }
        }
      }

      // Check active element
      console.log("📋 [GDocs Debug] Current activeElement:", document.activeElement?.tagName, document.activeElement?.className);

      // Try to find where text input actually goes
      console.log("📋 [GDocs Debug] Looking for text input mechanism...");

      // Google Docs uses a hidden iframe for text input
      const iframes = document.querySelectorAll("iframe");
      iframes.forEach((iframe, i) => {
        console.log(`📋 [GDocs Debug] Iframe ${i}:`, {
          src: iframe.src,
          className: iframe.className,
          id: iframe.id,
          width: iframe.width,
          height: iframe.height,
        });

        // Try to access iframe content
        try {
          const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
          if (iframeDoc) {
            console.log(`📋 [GDocs Debug] Iframe ${i} body preview:`, iframeDoc.body?.innerHTML?.substring(0, 300));
            const iframeContentEditable = iframeDoc.querySelector('[contenteditable="true"]');
            if (iframeContentEditable) {
              console.log(`📋 [GDocs Debug] Iframe ${i} has contenteditable!`, iframeContentEditable.tagName);
            }
          }
        } catch (e) {
          console.log(`📋 [GDocs Debug] Iframe ${i} inaccessible (cross-origin):`, e.message);
        }
      });

    }, 2000);
  }
}

// ============================================
// FOCUS TRACKING
// ============================================
function handleFocus(event) {
  const isGoogleDocs = window.location.hostname.includes("docs.google.com");

  if (isGoogleDocs) {
    console.log("📋 [GDocs Debug] Focus event:", {
      target: event.target.tagName,
      className: event.target.className,
      id: event.target.id,
      contentEditable: event.target.contentEditable,
      isContentEditable: event.target.isContentEditable,
      role: event.target.getAttribute?.("role"),
      ariaLabel: event.target.getAttribute?.("aria-label"),
      isInputResult: isInput(event.target),
    });
  }

  if (isInput(event.target)) {
    state.lastFocusedElement = event.target;
    state.previousValue = getValue(event.target);

    if (isGoogleDocs) {
      console.log("📋 [GDocs Debug] Stored as lastFocusedElement:", event.target);
    }
  }
}

function isInput(el) {
  if (!el) return false;

  const isGoogleDocs = window.location.hostname.includes("docs.google.com");
  const debugPrefix = "📋 [GDocs Debug] isInput check:";

  // Standard inputs
  if (el.tagName === "TEXTAREA") {
    if (isGoogleDocs) console.log(debugPrefix, "TEXTAREA match");
    return true;
  }
  if (el.tagName === "INPUT" && ["text", "search", "email", "url", ""].includes(el.type || "")) {
    if (isGoogleDocs) console.log(debugPrefix, "INPUT match");
    return true;
  }
  if (el.isContentEditable) {
    if (isGoogleDocs) console.log(debugPrefix, "isContentEditable match");
    return true;
  }

  // Check for contenteditable attribute explicitly (Google Docs uses this)
  if (el.getAttribute && el.getAttribute("contenteditable") === "true") {
    if (isGoogleDocs) console.log(debugPrefix, "contenteditable=true attribute match");
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
      "gmail_default"
    ];
    const matchedClass = editorClasses.find((cls) => el.className.includes(cls));
    if (matchedClass) {
      if (isGoogleDocs) console.log(debugPrefix, "Editor class match:", matchedClass);
      return true;
    }
  }

  // Check for role="textbox"
  if (el.getAttribute && el.getAttribute("role") === "textbox") {
    if (isGoogleDocs) console.log(debugPrefix, "role=textbox match");
    return true;
  }

  // Check ARIA labels for Google Docs
  if (el.getAttribute) {
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel && ariaLabel.toLowerCase().includes("document")) {
      if (isGoogleDocs) console.log(debugPrefix, "aria-label document match:", ariaLabel);
      return true;
    }
    // Gmail compose body aria-label
    if (ariaLabel && ariaLabel.toLowerCase().includes("message body")) {
      if (isGoogleDocs) console.log(debugPrefix, "aria-label message body match");
      return true;
    }
  }

  // Gmail compose - check for specific Gmail elements (multiple selectors for robustness)
  if (el.closest && el.closest('[aria-label="Message Body"]')) return true;
  if (el.closest && el.closest('[aria-label="Message body"]')) return true;
  if (el.closest && el.closest('.editable[contenteditable="true"]')) return true;
  if (el.closest && el.closest('[role="textbox"][contenteditable="true"]')) return true;
  if (el.closest && el.closest('div[contenteditable="true"][aria-multiline="true"]')) return true;
  if (el.closest && el.closest('[g_editable="true"]')) return true; // Gmail specific
  if (el.closest && el.closest('.Am')) return true; // Gmail compose area class
  if (el.closest && el.closest('[contenteditable="true"]')) {
    if (isGoogleDocs) console.log(debugPrefix, "closest contenteditable=true match");
    return true;
  }

  if (isGoogleDocs) {
    console.log(debugPrefix, "NO MATCH for element:", {
      tagName: el.tagName,
      className: el.className,
      id: el.id,
      contentEditable: el.contentEditable,
      isContentEditable: el.isContentEditable,
      role: el.getAttribute?.("role"),
      ariaLabel: el.getAttribute?.("aria-label"),
    });
  }

  return false;
}

// ============================================
// INPUT DETECTION
// ============================================
function handleInput(event) {
  // Ignore input events during paste to prevent popup from reopening
  if (state.isPasting) {
    console.log("BlockNotes: Ignoring input event during paste");
    return;
  }

  const isGoogleDocs = window.location.hostname.includes("docs.google.com");

  if (isGoogleDocs) {
    console.log("📋 [GDocs Debug] Input event fired:", {
      target: event.target.tagName,
      targetClass: event.target.className,
      targetId: event.target.id,
      isInputResult: isInput(event.target),
      inputType: event.inputType,
      data: event.data,
    });
  }

  if (!isInput(event.target)) return;

  const value = getValue(event.target);
  const previousValue = state.previousValue;
  state.previousValue = value;

  if (isGoogleDocs) {
    console.log("📋 [GDocs Debug] Input passed isInput check:", {
      value: value.substring(Math.max(0, value.length - 20)),
      previousValue: previousValue.substring(Math.max(0, previousValue.length - 20)),
    });
  }

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

  // Log ALL keydown events in Google Docs to see what's being captured
  if (isGoogleDocs && event.key === "/") {
    console.log("📋 [GDocs Debug] Keydown '/' detected:", {
      key: event.key,
      target: event.target.tagName,
      targetClass: event.target.className,
      targetId: event.target.id,
      activeElement: document.activeElement?.tagName,
      activeElementClass: document.activeElement?.className,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      isPopupOpen: state.isPopupOpen,
      lastFocusedElement: state.lastFocusedElement?.tagName,
    });
  }

  // Special handler for "/" key - especially for Gmail and contenteditable elements
  if (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.shiftKey && !state.isPopupOpen && !state.isPasting) {
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

      // Check if we should delegate to parent frame (e.g., Google Docs iframe)
      if (shouldDelegateToParent()) {
        requestPopupInParent();
        return;
      }

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

    // Google Docs specific handling - it uses a hidden iframe for text input
    if (isGoogleDocs) {
      console.log("📋 [GDocs Debug] Slash detected in Google Docs context");

      // Try to find the text event target (Google Docs uses this for text input)
      const docsTextTarget = document.querySelector(".docs-texteventtarget-iframe");
      const docsEditor = document.querySelector(".kix-appview-editor");
      const docsPage = document.querySelector(".kix-page");

      console.log("📋 [GDocs Debug] Google Docs elements:", {
        docsTextTarget: docsTextTarget ? "FOUND" : "NOT FOUND",
        docsEditor: docsEditor ? "FOUND" : "NOT FOUND",
        docsPage: docsPage ? "FOUND" : "NOT FOUND",
        target: target.tagName,
        targetClass: target.className,
        isInContentEditable,
      });

      // If we haven't already triggered the popup via contenteditable detection
      if (!isInContentEditable && !state.isPopupOpen) {
        console.log("📋 [GDocs Debug] Attempting to open popup for Google Docs...");

        // Use whichever element we can find
        const focusElement = docsEditor || docsPage || target;

        state.lastSlashDetected = true;
        state.lastFocusedElement = focusElement;

        // Check if we should delegate to parent frame (e.g., Google Docs iframe)
        if (shouldDelegateToParent()) {
          console.log("📋 [GDocs Debug] Delegating popup to parent frame");
          requestPopupInParent();
          return;
        }

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
  }

  // Handle Ctrl/Meta + Shift + / as a force-open shortcut (works everywhere)
  if (event.key === "/" && (event.ctrlKey || event.metaKey) && event.shiftKey) {
    event.preventDefault();

    if (isGoogleDocs) {
      console.log("📋 [GDocs Debug] Ctrl+Shift+/ force-open shortcut triggered");
    }

    // Find focused input or use last focused
    let target = document.activeElement;

    if (isGoogleDocs) {
      console.log("📋 [GDocs Debug] Initial target for force-open:", {
        tagName: target?.tagName,
        className: target?.className,
        isInputResult: isInput(target),
      });
    }

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

      if (isGoogleDocs) {
        console.log("📋 [GDocs Debug] Searching with selectors...");
      }

      for (const selector of selectors) {
        const element = document.querySelector(selector);
        console.log(`BlockNotes: Trying selector "${selector}":`, element);
        if (isGoogleDocs) {
          console.log(`📋 [GDocs Debug] Selector "${selector}":`, element ? {
            tagName: element.tagName,
            className: element.className,
            isInputResult: isInput(element),
          } : "NOT FOUND");
        }
        if (element && isInput(element)) {
          target = element;
          console.log("BlockNotes: Found valid input:", element);
          if (isGoogleDocs) {
            console.log("📋 [GDocs Debug] Using element:", element);
          }
          target.focus();
          break;
        }
      }
    }

    if (isGoogleDocs) {
      console.log("📋 [GDocs Debug] Final target for force-open:", {
        tagName: target?.tagName,
        className: target?.className,
        isInputResult: isInput(target),
      });
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
      // If not in a valid input but in an iframe, try delegating to parent
      if (shouldDelegateToParent()) {
        requestPopupInParent();
        return;
      }
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
  const isGoogleDocs = window.location.hostname.includes("docs.google.com");

  if (isGoogleDocs) {
    console.log("📋 [GDocs Debug] showPopup called:", {
      isPopupOpen: state.isPopupOpen,
      popupContainerExists: !!state.popupContainer,
      lastFocusedElement: state.lastFocusedElement?.tagName,
      lastFocusedElementClass: state.lastFocusedElement?.className,
      activeElement: document.activeElement?.tagName,
      activeElementClass: document.activeElement?.className,
    });
  }

  // Safety check: if isPopupOpen is true but container doesn't exist, reset state
  if (state.isPopupOpen && !state.popupContainer) {
    state.isPopupOpen = false;
  }

  if (state.isPopupOpen) return;

  // Allow showing popup even if no element is focused (will center it)
  const hasTarget = !!state.lastFocusedElement;

  if (isGoogleDocs) {
    console.log("📋 [GDocs Debug] showPopup proceeding with hasTarget:", hasTarget);
  }

  // Save the current selection range for contenteditable elements (like Gmail)
  // This must happen BEFORE the popup steals focus
  const selection = window.getSelection();
  if (selection.rangeCount > 0) {
    state.savedRange = selection.getRangeAt(0).cloneRange();

    // Debug logging for range saving
    const rangeContainer = state.savedRange.startContainer;
    console.log("BlockNotes: Saved selection range:", {
      startContainer: rangeContainer.nodeType === Node.TEXT_NODE ? "TEXT_NODE" : rangeContainer.nodeName,
      startOffset: state.savedRange.startOffset,
      textContent: rangeContainer.nodeType === Node.TEXT_NODE
        ? rangeContainer.textContent?.substring(Math.max(0, state.savedRange.startOffset - 10), state.savedRange.startOffset + 10)
        : "(not text node)",
      collapsed: state.savedRange.collapsed,
    });
  } else {
    state.savedRange = null;
    console.log("BlockNotes: No selection to save");
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
  // Use window-level capture to intercept keys before Google Docs iframe
  window.addEventListener("keydown", handlePopupKeydown, true);

  // For Google Docs: also add listener to the iframe where typing happens
  if (isGoogleDocs) {
    const docsTextTarget = document.querySelector(".docs-texteventtarget-iframe");
    if (docsTextTarget) {
      try {
        const iframeDoc = docsTextTarget.contentDocument || docsTextTarget.contentWindow?.document;
        if (iframeDoc) {
          iframeDoc.addEventListener("keydown", handlePopupKeydown, true);
          state.googleDocsIframeDoc = iframeDoc; // Save reference for cleanup
          console.log("BlockNotes: Added keydown listener to Google Docs iframe");
        }
      } catch (e) {
        console.log("BlockNotes: Could not access Google Docs iframe (cross-origin):", e.message);
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
  const maxHeight = 320;
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
      display: block !important;
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
    display: block !important;
    visibility: visible !important;
    opacity: 1 !important;
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
      const matches = filterNotes(extractQuery());
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
  console.log("BlockNotes: closePopup called", {
    hasPopupContainer: !!state.popupContainer,
    isPopupOpen: state.isPopupOpen,
  });

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
      state.googleDocsIframeDoc.removeEventListener("keydown", handlePopupKeydown, true);
      console.log("BlockNotes: Removed keydown listener from Google Docs iframe");
    } catch (e) {
      // Ignore errors if iframe is no longer accessible
    }
    state.googleDocsIframeDoc = null;
  }

  if (state.popupContainer) {
    console.log("BlockNotes: Removing popup container from DOM");
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

  // Restore focus after state cleanup
  if (isGoogleDocs) {
    // For Google Docs, focus the text event target iframe
    // Note: Don't dispatch mouse events as they move the cursor to wrong position
    const docsTextTargetIframe = document.querySelector(".docs-texteventtarget-iframe");

    const restoreFocusToGoogleDocs = () => {
      if (docsTextTargetIframe) {
        try {
          const iframeDoc = docsTextTargetIframe.contentDocument || docsTextTargetIframe.contentWindow?.document;
          if (iframeDoc) {
            const iframeBody = iframeDoc.body;
            const iframeEditable = iframeDoc.querySelector('[contenteditable="true"]') || iframeBody;
            if (iframeEditable) {
              iframeEditable.focus();
              console.log("BlockNotes: Focused inside Google Docs iframe (closePopup)");
              return;
            }
          }
        } catch (e) {
          // Cross-origin fallback
        }
        docsTextTargetIframe.focus();
        console.log("BlockNotes: Focused Google Docs iframe element (closePopup)");
      }
    };

    // Multiple attempts to combat focus issues
    restoreFocusToGoogleDocs();
    setTimeout(restoreFocusToGoogleDocs, 50);
    setTimeout(restoreFocusToGoogleDocs, 150);
  } else if (targetElement) {
    // For other sites, focus the original element
    targetElement.focus();
    console.log("BlockNotes: Restored focus to lastFocusedElement");
  }

  console.log("BlockNotes: closePopup completed, isPopupOpen:", state.isPopupOpen);
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
      navigator.clipboard.writeText(noteText).then(() => {
        showToast("Press Ctrl/Cmd+V to paste", "Note copied to clipboard");
      }).catch(() => {
        showToast("Press Ctrl/Cmd+V to paste", "Note copied to clipboard");
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

  console.log("📋 [Paste Debug] pasteNoteWithFallback called:", {
    textLength: text.length,
    textPreview: text.substring(0, 50) + (text.length > 50 ? "..." : ""),
    isGoogleDocs,
    lastFocusedElement: state.lastFocusedElement?.tagName,
    lastFocusedElementClass: state.lastFocusedElement?.className,
  });

  // Always copy to clipboard first as safety net
  navigator.clipboard.writeText(text).then(() => {
    console.log("📋 [Paste Debug] Clipboard write SUCCESS");
  }).catch((err) => {
    console.log("📋 [Paste Debug] Clipboard write FAILED:", err);
  });

  // Google Docs uses custom canvas rendering - execCommand won't work
  if (isGoogleDocs) {
    console.log("📋 [GDocs Debug] Google Docs detected - showing clipboard toast");
    console.log("📋 [GDocs Debug] Attempting to investigate Google Docs structure...");

    // Log the Google Docs DOM structure for debugging
    const docsCanvas = document.querySelector(".kix-canvas-tile-content");
    const docsEditor = document.querySelector(".kix-appview-editor");
    const docsPage = document.querySelector(".kix-page");
    const docsTextTarget = document.querySelector(".docs-texteventtarget-iframe");
    const docsTextTargetDiv = document.querySelector(".docs-texteventtarget");

    console.log("📋 [GDocs Debug] DOM structure:", {
      docsCanvas: docsCanvas ? "FOUND" : "NOT FOUND",
      docsEditor: docsEditor ? "FOUND" : "NOT FOUND",
      docsPage: docsPage ? "FOUND" : "NOT FOUND",
      docsTextTargetIframe: docsTextTarget ? "FOUND" : "NOT FOUND",
      docsTextTargetDiv: docsTextTargetDiv ? "FOUND" : "NOT FOUND",
      activeElement: document.activeElement?.tagName,
      activeElementClass: document.activeElement?.className,
    });

    // Try to find the hidden textarea/iframe that Google Docs uses for text input
    if (docsTextTarget) {
      console.log("📋 [GDocs Debug] docs-texteventtarget-iframe found:", docsTextTarget);
      try {
        const iframeDoc = docsTextTarget.contentDocument || docsTextTarget.contentWindow?.document;
        console.log("📋 [GDocs Debug] Iframe contentDocument:", iframeDoc);
        if (iframeDoc) {
          console.log("📋 [GDocs Debug] Iframe body:", iframeDoc.body?.innerHTML?.substring(0, 200));
          console.log("📋 [GDocs Debug] Iframe activeElement:", iframeDoc.activeElement);
        }
      } catch (e) {
        console.log("📋 [GDocs Debug] Cannot access iframe (cross-origin?):", e.message);
      }
    }

    showToast("Press Ctrl/Cmd+V to paste", "Note copied to clipboard");

    // Set isPasting flag to prevent popup from reopening when user pastes
    // Keep it active for a few seconds to cover the time user takes to press Ctrl+V
    state.isPasting = true;
    setTimeout(() => {
      state.isPasting = false;
    }, 3000);

    // Restore focus to Google Docs input so user can paste
    // Note: Don't dispatch mouse events as they move the cursor to wrong position
    const restoreFocusToGoogleDocs = () => {
      const docsTextTargetIframe = document.querySelector(".docs-texteventtarget-iframe");

      // Focus the iframe where text input happens - Google Docs maintains cursor position internally
      if (docsTextTargetIframe) {
        try {
          const iframeDoc = docsTextTargetIframe.contentDocument || docsTextTargetIframe.contentWindow?.document;
          if (iframeDoc) {
            const iframeBody = iframeDoc.body;
            const iframeEditable = iframeDoc.querySelector('[contenteditable="true"]') || iframeBody;
            if (iframeEditable) {
              iframeEditable.focus();
              console.log("BlockNotes: Focused inside Google Docs iframe");
              return;
            }
          }
        } catch (e) {
          // Cross-origin, fall back to focusing the iframe itself
        }
        docsTextTargetIframe.focus();
        console.log("BlockNotes: Focused Google Docs iframe element");
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

  console.log("📋 [Toast Debug] showToast called:", { message, subtitle, isGoogleDocs });

  // Remove existing toast if any
  const existing = document.querySelector('.blocknotes-toast');
  if (existing) {
    console.log("📋 [Toast Debug] Removing existing toast");
    existing.remove();
  }

  const toast = document.createElement('div');
  toast.className = 'blocknotes-toast';
  toast.innerHTML = `
    <div style="font-weight: 600;">${escapeHtml(message)}</div>
    ${subtitle ? `<div style="font-size: 12px; opacity: 0.8; margin-top: 2px;">${escapeHtml(subtitle)}</div>` : ''}
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
  if (!document.getElementById('blocknotes-toast-styles')) {
    const style = document.createElement('style');
    style.id = 'blocknotes-toast-styles';
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
    const docsChrome = document.querySelector('.docs-butterbar-container')?.parentElement;
    if (docsChrome) {
      console.log("📋 [Toast Debug] Appending to docs chrome container");
      appendTarget = docsChrome;
    } else {
      // Fallback to documentElement which is above body
      console.log("📋 [Toast Debug] Appending to documentElement");
      appendTarget = document.documentElement;
    }
  }

  appendTarget.appendChild(toast);

  console.log("📋 [Toast Debug] Toast appended:", {
    parent: appendTarget.tagName,
    toastInDOM: document.contains(toast),
    computedDisplay: window.getComputedStyle(toast).display,
    computedVisibility: window.getComputedStyle(toast).visibility,
    computedOpacity: window.getComputedStyle(toast).opacity,
    computedZIndex: window.getComputedStyle(toast).zIndex,
    boundingRect: toast.getBoundingClientRect(),
  });

  // Check again after a short delay (Google Docs might remove/hide it)
  if (isGoogleDocs) {
    setTimeout(() => {
      console.log("📋 [Toast Debug] Toast status after 100ms:", {
        stillInDOM: document.contains(toast),
        computedDisplay: document.contains(toast) ? window.getComputedStyle(toast).display : "removed",
        computedVisibility: document.contains(toast) ? window.getComputedStyle(toast).visibility : "removed",
        boundingRect: document.contains(toast) ? toast.getBoundingClientRect() : "removed",
      });
    }, 100);
  }

  // Auto-remove after 3 seconds
  setTimeout(() => {
    if (document.contains(toast)) {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.2s ease';
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

function showPlaceholderPrompt(noteText, placeholders, isCrossFrame = false) {
  // Save the focused element and selection range before showing prompt
  const targetElement = state.lastFocusedElement;
  const savedRange = state.savedRange;
  const isGoogleDocs = window.location.hostname.includes("docs.google.com");
  const isLinkedIn = window.location.hostname.includes("linkedin.com");

  // For LinkedIn, use iframe-based prompt to bypass their aggressive event blocking
  // if (isLinkedIn) {
  //   showPlaceholderPromptIframe(noteText, placeholders, isCrossFrame, targetElement, savedRange);
  //   return;
  // }

  // Helper to restore focus when closing the prompt
  // Note: Don't dispatch mouse events as they move the cursor to wrong position
  const restoreFocusAfterClose = () => {
    if (isGoogleDocs) {
      const docsTextTargetIframe = document.querySelector(".docs-texteventtarget-iframe");

      const restoreFocus = () => {
        if (docsTextTargetIframe) {
          try {
            const iframeDoc = docsTextTargetIframe.contentDocument || docsTextTargetIframe.contentWindow?.document;
            if (iframeDoc) {
              const iframeBody = iframeDoc.body;
              const iframeEditable = iframeDoc.querySelector('[contenteditable="true"]') || iframeBody;
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

  // Document-level escape handler (capture phase) for edge cases where focus escapes
  const handleDocumentEscape = (e) => {
    if (e.key === 'Escape' && document.body.contains(promptContainer)) {
      e.preventDefault();
      e.stopPropagation();
      promptContainer.remove();
      document.removeEventListener('keydown', handleDocumentEscape, true);
      restoreFocusAfterClose();
    }
  };
  document.addEventListener('keydown', handleDocumentEscape, true);
  promptContainer.tabIndex = -1; // Make container focusable for focus trapping
  promptContainer.style.cssText = `
    position: fixed !important;
    top: 50% !important;
    left: 50% !important;
    transform: translate(-50%, -50%) !important;
    width: 420px !important;
    max-width: 90vw !important;
    background: #1e293b !important;
    border: 1px solid #334155 !important;
    border-radius: 16px !important;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5) !important;
    z-index: 2147483647 !important;
    font-family: 'Inter', -apple-system, sans-serif !important;
    overflow: hidden !important;
    animation: placeholderPromptFadeIn 0.2s ease !important;
    display: block !important;
    visibility: visible !important;
    opacity: 1 !important;
    pointer-events: auto !important;
    color: #f1f5f9 !important;
  `;

  // Prevent focus from escaping to Word/Google Docs
  promptContainer.addEventListener('focusout', (e) => {
    // If focus is leaving the container, pull it back
    if (!promptContainer.contains(e.relatedTarget)) {
      e.preventDefault();
      e.stopPropagation();
      // Re-focus the first input or the container itself
      const firstFocusable = promptContainer.querySelector('input, button');
      if (firstFocusable) {
        setTimeout(() => firstFocusable.focus(), 0);
      }
    }
  });

  // Handle keyboard events - only stop propagation for keys we handle
  // Use bubble phase so inputs can receive keystrokes first
  promptContainer.addEventListener('keydown', (e) => {
    // Handle Escape key to close the prompt
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      promptContainer.remove();
      document.removeEventListener('keydown', handleDocumentEscape, true);
      restoreFocusAfterClose();
      return;
    }

    // Handle Tab key to trap focus within the prompt
    if (e.key === 'Tab') {
      e.stopPropagation();
      const focusableElements = promptContainer.querySelectorAll(
        'input:not([disabled]), button:not([disabled])'
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
    if (e.key === 'Enter') {
      e.stopPropagation();
      return;
    }

    // For other keys (regular typing), stop propagation in bubble phase
    // to prevent LinkedIn from intercepting, but let the input receive it
    e.stopPropagation();
  });

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

  // Header
  const header = document.createElement("div");
  header.style.cssText = `
    padding: 16px 20px !important;
    border-bottom: 1px solid #334155 !important;
    display: flex !important;
    justify-content: space-between !important;
    align-items: center !important;
    background: #334155 !important;
  `;

  const title = document.createElement("h3");
  title.textContent = "Fill in values";
  title.style.cssText = `
    margin: 0 !important;
    font-size: 15px !important;
    font-weight: 600 !important;
    color: #f1f5f9 !important;
  `;

  const closeBtn = document.createElement("button");
  closeBtn.innerHTML = "×";
  closeBtn.style.cssText = `
    background: transparent !important;
    border: none !important;
    font-size: 24px !important;
    color: #94a3b8 !important;
    cursor: pointer !important;
    padding: 0 !important;
    width: 24px !important;
    height: 24px !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    border-radius: 4px !important;
    transition: all 0.15s ease !important;
  `;

  closeBtn.addEventListener("mouseenter", () => {
    closeBtn.style.setProperty('background', '#475569', 'important');
    closeBtn.style.setProperty('color', '#f1f5f9', 'important');
  });

  closeBtn.addEventListener("mouseleave", () => {
    closeBtn.style.setProperty('background', 'transparent', 'important');
    closeBtn.style.setProperty('color', '#94a3b8', 'important');
  });

  closeBtn.addEventListener("click", () => {
    promptContainer.remove();
    document.removeEventListener('keydown', handleDocumentEscape, true);
    restoreFocusAfterClose();
  });

  header.appendChild(title);
  header.appendChild(closeBtn);

  // Form
  const form = document.createElement("form");
  form.style.cssText = `
    padding: 20px !important;
    display: flex !important;
    flex-direction: column !important;
    gap: 16px !important;
    max-height: 60vh !important;
    overflow-y: auto !important;
    background: transparent !important;
    margin: 0 !important;
    border: none !important;
    pointer-events: auto !important;
    font-family: 'Inter', -apple-system, sans-serif !important;
  `;

  // Auto-fill toggle
  const autoFillContainer = document.createElement("div");
  autoFillContainer.style.cssText = `
    display: flex !important;
    align-items: center !important;
    justify-content: space-between !important;
    padding: 10px 12px !important;
    background: rgba(129, 140, 248, 0.1) !important;
    border: 1px solid rgba(129, 140, 248, 0.2) !important;
    border-radius: 8px !important;
    margin-bottom: 4px !important;
  `;

  const autoFillLabel = document.createElement("label");
  autoFillLabel.style.cssText = `
    display: flex !important;
    align-items: center !important;
    gap: 8px !important;
    font-size: 13px !important;
    color: #f1f5f9 !important;
    cursor: pointer !important;
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
    width: 18px !important;
    height: 18px !important;
    cursor: pointer !important;
    accent-color: #818cf8 !important;
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
      display: flex !important;
      flex-direction: column !important;
      gap: 6px !important;
      margin: 0 !important;
      padding: 0 !important;
    `;

    const label = document.createElement("label");
    label.textContent = placeholder;
    label.style.cssText = `
      font-size: 13px !important;
      font-weight: 600 !important;
      color: #f1f5f9 !important;
      display: block !important;
      font-family: 'Inter', -apple-system, sans-serif !important;
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
      font-family: 'Inter', -apple-system, sans-serif !important;
      font-size: 14px !important;
      font-weight: 400 !important;
      color: #f1f5f9 !important;
      background: #334155 !important;
      outline: none !important;
      transition: border-color 0.2s ease, box-shadow 0.2s ease !important;
      width: 100% !important;
      height: 40px !important;
      display: block !important;
      cursor: text !important;
      caret-color: #f1f5f9 !important;
    `;

    input.addEventListener("focus", () => {
      input.style.setProperty('border-color', '#818cf8', 'important');
      input.style.setProperty('box-shadow', '0 0 0 3px rgba(129, 140, 248, 0.15)', 'important');
    });

    input.addEventListener("blur", () => {
      input.style.setProperty('border-color', '#334155', 'important');
      input.style.setProperty('box-shadow', 'none', 'important');
    });

    // Stop events from propagating to page (fixes LinkedIn blocking inputs)
    const stopInputPropagation = (e) => {
      e.stopPropagation();
    };
    input.addEventListener("mousedown", stopInputPropagation);
    input.addEventListener("mouseup", stopInputPropagation);
    input.addEventListener("click", stopInputPropagation);
    input.addEventListener("pointerdown", stopInputPropagation);
    input.addEventListener("pointerup", stopInputPropagation);
    input.addEventListener("touchstart", stopInputPropagation);
    input.addEventListener("touchend", stopInputPropagation);

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
    font-family: 'Inter', -apple-system, sans-serif !important;
    font-size: 13px !important;
    font-weight: 600 !important;
    cursor: pointer !important;
    transition: all 0.2s ease !important;
  `;

  cancelBtn.addEventListener("mouseenter", () => {
    cancelBtn.style.setProperty('background', '#475569', 'important');
    cancelBtn.style.setProperty('color', '#f1f5f9', 'important');
  });

  cancelBtn.addEventListener("mouseleave", () => {
    cancelBtn.style.setProperty('background', '#334155', 'important');
    cancelBtn.style.setProperty('color', '#94a3b8', 'important');
  });

  cancelBtn.addEventListener("click", () => {
    promptContainer.remove();
    document.removeEventListener('keydown', handleDocumentEscape, true);
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
    font-family: 'Inter', -apple-system, sans-serif !important;
    font-size: 13px !important;
    font-weight: 600 !important;
    cursor: pointer !important;
    transition: all 0.2s ease !important;
  `;

  insertBtn.addEventListener("mouseenter", () => {
    insertBtn.style.setProperty('background', '#6366f1', 'important');
    insertBtn.style.setProperty('border-color', '#6366f1', 'important');
  });

  insertBtn.addEventListener("mouseleave", () => {
    insertBtn.style.setProperty('background', '#818cf8', 'important');
    insertBtn.style.setProperty('border-color', '#818cf8', 'important');
  });

  buttonGroup.appendChild(cancelBtn);
  buttonGroup.appendChild(insertBtn);
  form.appendChild(buttonGroup);

  // Handle form submission (capture phase - fires before window interceptor kills event)
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
    document.removeEventListener('keydown', handleDocumentEscape, true);

    // Handle cross-frame insertion
    if (isCrossFrame) {
      sendNoteToChildFrame(finalText);

      // Set isPasting flag to prevent popup from reopening when user pastes
      state.isPasting = true;
      setTimeout(() => {
        state.isPasting = false;
      }, 3000);

      navigator.clipboard.writeText(finalText).then(() => {
        showToast("Press Ctrl/Cmd+V to paste", "Note copied to clipboard");
      }).catch(() => {
        showToast("Press Ctrl/Cmd+V to paste", "Note copied to clipboard");
      });
      restoreFocusAfterClose();
    } else {
      pasteNoteWithFallback(finalText);
      // For Google Docs, also restore focus after pasteNoteWithFallback
      if (isGoogleDocs) {
        restoreFocusAfterClose();
      }
    }
  }, true);  // Capture phase - fires before window interceptor kills event

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
  const hasParagraphs = el.querySelector('p') !== null;

  // Check if hitting Enter would create a paragraph (test by examining existing structure)
  // If first child is a <p>, it's likely a paragraph-based editor
  const firstChild = el.firstElementChild;
  if (firstChild && firstChild.tagName === 'P') {
    return true;
  }

  // Check if there are multiple <p> siblings (indicates paragraph structure)
  const paragraphs = el.querySelectorAll(':scope > p');
  if (paragraphs.length > 0) {
    return true;
  }

  // Check for common rich text editor patterns that use paragraphs
  // These editors wrap content in <p> tags
  if (el.closest('[data-contents="true"]') || // Draft.js
      el.closest('.ql-editor') || // Quill
      el.closest('.ProseMirror') || // ProseMirror
      el.closest('.tox-edit-area') || // TinyMCE
      el.closest('[contenteditable="true"] p')) { // Generic paragraph container
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

  console.log("BlockNotes: pasteNote called:", {
    textLength: text.length,
    textPreview: text.substring(0, 30),
    elementTag: el.tagName,
    isContentEditable: el.isContentEditable,
    contentLength: content.length,
    slashIndex,
    hasSavedRange: !!state.savedRange,
    savedRangeInfo: state.savedRange ? {
      startOffset: state.savedRange.startOffset,
      collapsed: state.savedRange.collapsed,
    } : null,
  });

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
    // Detect the editor type by structure, not by URL
    const hasNewlines = text.includes('\n');
    const isParagraphEditor = usesParagraphStructure(el);

    // Use saved range since clicking popup loses the selection
    let range = state.savedRange;

    // Also check current selection for comparison/fallback
    const currentSelection = window.getSelection();
    const currentRange = currentSelection.rangeCount > 0 ? currentSelection.getRangeAt(0) : null;

    console.log("BlockNotes: Range comparison:", {
      hasSavedRange: !!range,
      hasCurrentRange: !!currentRange,
      savedRangeContainer: range?.startContainer?.nodeName,
      savedRangeOffset: range?.startOffset,
      currentRangeContainer: currentRange?.startContainer?.nodeName,
      currentRangeOffset: currentRange?.startOffset,
    });

    if (!range) {
      range = currentRange;
      console.log("BlockNotes: Using current range instead of saved");
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
        const textContent = insertContainer.textContent || '';
        const slashPosInText = textContent.lastIndexOf('/');

        if (slashPosInText >= 0) {
          const searchQuery = extractQuery();
          // Characters to delete: "/" (1) + query length
          const charsToDelete = 1 + searchQuery.length;

          // Edge case: when cursor is in the first line and slash is at position 0,
          // the insertOffset might be 0 (before the slash) instead of after it.
          // In this case, we need to ensure we delete from position 0 and insert after.
          const isFirstLineEdgeCase = slashPosInText === 0 && insertOffset === 0;

          console.log("BlockNotes: Deleting slash via selection:", {
            textContent: textContent.substring(Math.max(0, slashPosInText - 5)),
            slashPosInText,
            searchQuery,
            charsToDelete,
            insertOffset,
            isFirstLineEdgeCase,
          });

          // The cursor should be right after the query, so we select backwards
          // Create a range from slash position to current position
          try {
            const deleteRange = document.createRange();
            // For the first line edge case, ensure we start from position 0
            // and delete the slash + query correctly
            const deleteStart = slashPosInText;
            const deleteEnd = Math.min(slashPosInText + charsToDelete, textContent.length);

            deleteRange.setStart(insertContainer, deleteStart);
            deleteRange.setEnd(insertContainer, deleteEnd);

            sel.removeAllRanges();
            sel.addRange(deleteRange);

            // Delete the selected text
            document.execCommand('delete', false);

            // For first line edge case, ensure cursor is positioned correctly after deletion
            // The cursor should now be at the position where the slash was (position 0 for first line)
            if (isFirstLineEdgeCase) {
              // After deletion, cursor should be at slashPosInText (position 0)
              // Verify and correct cursor position if needed
              const currentSel = window.getSelection();
              if (currentSel.rangeCount > 0) {
                const currentRange = currentSel.getRangeAt(0);
                console.log("BlockNotes: First line edge case - cursor after deletion:", {
                  startOffset: currentRange.startOffset,
                  collapsed: currentRange.collapsed,
                });
              }
            }

            console.log("BlockNotes: Slash deleted successfully");
          } catch (e) {
            console.log("BlockNotes: Slash deletion failed, inserting at cursor:", e.message);
            // For first line edge case, if deletion fails, we need to position cursor after the slash+query
            // to avoid inserting before the slash
            if (isFirstLineEdgeCase) {
              try {
                const newRange = document.createRange();
                const endPos = Math.min(slashPosInText + charsToDelete, textContent.length);
                newRange.setStart(insertContainer, endPos);
                newRange.collapse(true);
                sel.removeAllRanges();
                sel.addRange(newRange);
                console.log("BlockNotes: First line edge case - positioned cursor after slash+query");
              } catch (e2) {
                console.log("BlockNotes: Could not reposition cursor:", e2.message);
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
        console.log("BlockNotes: Slash not in direct text node, searching for it");

        try {
          // Walk through the element to find the text node with the slash
          const walker = document.createTreeWalker(
            el,
            NodeFilter.SHOW_TEXT,
            null,
            false
          );

          let textNode = walker.nextNode();
          let slashNode = null;
          let slashNodeOffset = -1;

          while (textNode) {
            const nodeSlashPos = textNode.textContent.lastIndexOf('/');
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

            console.log("BlockNotes: Found slash in text node:", {
              slashNodeOffset,
              nodeTextLength,
              searchQuery,
              charsToDelete,
              isFirstLine: slashNodeOffset === 0,
            });

            const deleteRange = document.createRange();
            deleteRange.setStart(slashNode, slashNodeOffset);
            deleteRange.setEnd(slashNode, Math.min(slashNodeOffset + charsToDelete, nodeTextLength));

            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(deleteRange);
            document.execCommand('delete', false);

            console.log("BlockNotes: Slash deleted successfully (searched)");
          } else {
            console.log("BlockNotes: Could not find slash in any text node");
          }
        } catch (e) {
          console.log("BlockNotes: Error searching for slash:", e.message);
        }
      }

      // Insert text based on editor type
      if (hasNewlines) {
        // Multiline text - insert line by line
        const lines = text.split('\n');

        if (isParagraphEditor) {
          // Paragraph-based editor (Word, rich text editors)
          // Use keyboard simulation for better compatibility with Word
          insertWithKeyboardSimulation(lines, el);
        } else {
          // Line-break based editor (Gmail, simple contenteditable)
          // Use insertLineBreak or <br> tags
          for (let index = 0; index < lines.length; index++) {
            const line = lines[index];
            document.execCommand('insertText', false, line);

            if (index < lines.length - 1) {
              document.execCommand('insertLineBreak', false);
            }
          }
        }
      } else {
        // Single line - simple insert
        document.execCommand('insertText', false, text);
      }

      // Clear saved range after use
      state.savedRange = null;
    } else {
      // Fallback: no saved range, try to focus and insert
      el.focus();
      if (hasNewlines) {
        insertTextLineByLine(text, isParagraphEditor);
      } else {
        document.execCommand('insertText', false, text);
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
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    // Insert the text content
    document.execCommand('insertText', false, line);

    if (index < lines.length - 1) {
      // Insert a line/paragraph break based on editor type
      if (useParagraphs) {
        document.execCommand('insertParagraph', false);
      } else {
        document.execCommand('insertLineBreak', false);
      }
    }
  }
}

// Detect if we're in MS Word Online
function isMSWordOnline() {
  // Check URL
  const hostname = window.location.hostname;
  if (hostname.includes('word.office.com') ||
      hostname.includes('word-edit.officeapps.live.com')) {
    return true;
  }

  // Check for Word-specific DOM elements
  if (document.querySelector('[data-app="Word"]') ||
      document.querySelector('.WACViewPanel') ||
      document.querySelector('[class*="WordEditor"]')) {
    return true;
  }

  return false;
}

// Insert multiline text for paragraph-based editors (Word, rich text editors)
async function insertWithKeyboardSimulation(lines, el) {
  const text = lines.join('\n');

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
  const textInserted = document.execCommand('insertText', false, text);
  if (textInserted) {
    return;
  }

  // Fallback: Insert each line separately with paragraph breaks
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];

    if (line.length > 0) {
      document.execCommand('insertText', false, line);
    }

    if (index < lines.length - 1) {
      document.execCommand('insertParagraph', false);
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
    showToast("Press Ctrl/Cmd+V to paste", "Note copied to clipboard");

    return true;
  } catch (error) {
    console.log('BlockNotes: Clipboard write failed, using fallback', error);
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
