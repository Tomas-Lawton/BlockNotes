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
  shiftPressed: false,
};

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

  // Load Shift+/ setting once at startup
  chrome.storage.local.get("settings", (data) => {
    state.useShiftSlash = data.settings?.useShiftSlash === true; // Default unchecked
  });

  // Setup listeners
  document.addEventListener("focus", handleFocus, true);
  document.addEventListener("input", handleInput, true);
  document.addEventListener("keydown", handleGlobalKeydown);
  document.addEventListener("keyup", handleGlobalKeyup);
  chrome.runtime.onMessage.addListener(handleMessage);

  console.log("✓ BlockNotes loaded");
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
  return (
    el.isContentEditable ||
    el.tagName === "TEXTAREA" ||
    (el.tagName === "INPUT" &&
      ["text", "search", "email", "url", ""].includes(el.type || ""))
  );
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

  // --- Close popup if space typed right after slash ---
  if (state.isPopupOpen) {
    const lastSlashIndex = value.lastIndexOf("/");
    const lastSpaceIndex = value.lastIndexOf(" ");
    // close only if space immediately follows last slash
    if (lastSlashIndex >= 0 && lastSpaceIndex === lastSlashIndex + 1) {
      closePopup();
      return;
    }
    if (!value.includes("/")) {
      closePopup();
    }
    return;
  }

  // --- Detect fresh slash ---
  const justTypedSlash =
    lastChar === "/" && prevLastChar !== "/" && prevLastChar !== " ";

  if (justTypedSlash) {
    // Check Shift requirement
    if (state.useShiftSlash && !state.shiftPressed) {
      return; // Don't open - shift wasn't held
    }

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

// Track Shift key state
function handleGlobalKeydown(event) {
  if (event.key === "Shift") {
    state.shiftPressed = true;
  }
  if (state.isPopupOpen) {
    handlePopupKeydown(event);
  }
}

function handleGlobalKeyup(event) {
  if (event.key === "Shift") {
    state.shiftPressed = false;
  }
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
  if (state.isPopupOpen || !state.lastFocusedElement) return;

  state.isPopupOpen = true;
  state.selectedIndex = 0;

  // Create popup
  const popup = document.createElement("div");
  popup.className = "blocknotes-popup";
  popup.style.cssText = getPopupStyles();

  // Create list
  const list = document.createElement("ul");
  list.className = "blocknotes-list";
  list.style.cssText = getListStyles();

  // Add minimalist title with close button
  const header = document.createElement("div");
  header.className = "blocknotes-header";
  header.style.cssText = `
    padding: 8px 12px;
    border-bottom: 1px solid #e5e7eb;
    font-size: 11px;
    font-weight: 600;
    color: #111827;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    cursor: grab;
    user-select: none;
  `;

  const title = document.createElement("span");
  title.textContent = "BlockNotes";

  const closeBtn = document.createElement("button");
  closeBtn.innerHTML = "×";
  closeBtn.style.cssText = `
    background: transparent;
    border: none;
    font-size: 24px;
    font-weight: 700;
    color: #6b7280;
    cursor: pointer;
    padding: 0;
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    transition: all 0.15s ease;
    line-height: 1;
  `;

  closeBtn.addEventListener("mouseenter", () => {
    closeBtn.style.background = "#f3f4f6";
    closeBtn.style.color = "#111827";
  });

  closeBtn.addEventListener("mouseleave", () => {
    closeBtn.style.background = "transparent";
    closeBtn.style.color = "#6b7280";
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
  state.lastFocusedElement.addEventListener("input", updateResults);
  document.addEventListener("click", handleClickOutside);
  document.addEventListener("keydown", handlePopupKeydown, true);

  // Initial render
  updateResults();

  // Add styles
  addStyles();
}

function getPopupStyles() {
  const rect = state.lastFocusedElement.getBoundingClientRect();
  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;
  const maxHeight = 320;
  const width = Math.min(380, viewportWidth - 40);
  const spacing = 8;

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
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.12), 0 2px 8px rgba(0, 0, 0, 0.08);
    z-index: 2147483647;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    overflow: hidden;
    transition: opacity 0.15s ease;
  `;
}

function getListStyles() {
  return `
    margin: 0;
    padding: 4px;
    list-style: none;
    max-height: 260px;
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
  console.log(query);
  // Normalize query for better matching
  const normalizedQuery = query.toLowerCase();

  return Object.values(state.notes)
    .filter((note) => {
      console.log(note);
      if (!normalizedQuery) return true;

      const name = (note.noteName || "").toLowerCase();
      const text = (note.noteText || "").toLowerCase();

      console.log(
        name || "problem",
        text || "problem",
        normalizedQuery || "problem"
      );
      console.log(
        name.includes(normalizedQuery) || text.includes(normalizedQuery)
      );
      // Match if query appears anywhere in name or text
      return name.includes(normalizedQuery) || text.includes(normalizedQuery);
    })
    .sort((a, b) => {
      if (!normalizedQuery)
        return (b.displayIndex || 0) - (a.displayIndex || 0);

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

      // Finally by display index
      return (b.displayIndex || 0) - (a.displayIndex || 0);
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
      color: #9ca3af;
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

    li.innerHTML = `
      <div style="font-weight: 600; font-size: 14px; color: #111827; margin-bottom: 4px;">${escapeHtml(
        name
      )}</div>
      <div style="font-size: 13px; color: #6b7280; line-height: 1.4;">${escapeHtml(
        preview
      )}</div>
    `;

    li.style.cssText = getItemStyles(i === state.selectedIndex);

    li.addEventListener("mouseenter", () => selectItem(i));
    li.addEventListener("click", () => {
      pasteNote(note.noteText);
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
    padding: 10px 12px;
    margin: 2px 0;
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.15s ease;
    background: ${isSelected ? "#f3f4f6" : "white"};
    border-left: ${isSelected ? "3px solid #3b82f6" : "3px solid transparent"};
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
        pasteNote(matches[state.selectedIndex].noteText);
        closePopup();
      }
      break;

    case "Escape":
      event.preventDefault();
      event.stopPropagation();
      closePopup();
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
  if (!state.popupContainer) return;

  state.lastFocusedElement?.removeEventListener("input", updateResults);
  document.removeEventListener("click", handleClickOutside);
  document.removeEventListener("keydown", handlePopupKeydown, true);
  document.removeEventListener("mousemove", handleDragMove);
  document.removeEventListener("mouseup", handleDragEnd);

  state.popupContainer.remove();
  state.popupContainer = null;
  state.isPopupOpen = false;
  state.lastSlashDetected = false;
  state.selectedIndex = 0;
  state.isDragging = false;
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
    el.textContent = content;

    // Move cursor to end
    const range = document.createRange();
    const sel = window.getSelection();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
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
      background: #f9fafb;
      border-radius: 4px;
    }
    .blocknotes-list::-webkit-scrollbar-thumb {
      background: #d1d5db;
      border-radius: 4px;
    }
    .blocknotes-list::-webkit-scrollbar-thumb:hover {
      background: #9ca3af;
    }
    .blocknotes-item:hover {
      background: #f9fafb !important;
    }
    .blocknotes-header:active {
      cursor: grabbing !important;
    }
  `;
  document.head.appendChild(style);
}

// ============================================
// UTILS
// ============================================
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
