import { playPop } from "./sounds.js";

let sortableInstance = null;
let resizeHandler = null;

// Initialize Sortable.js on the notes container
export function updateDragDropListeners() {
  const notesContainer = document.getElementById("notes");

  if (!notesContainer) return;

  // Destroy existing instance if it exists
  if (sortableInstance) {
    sortableInstance.destroy();
    sortableInstance = null;
  }

  // Remove old resize handler if exists
  if (resizeHandler) {
    window.removeEventListener("resize", resizeHandler);
  }

  // Check if there are any notes to make draggable
  const noteElements = notesContainer.querySelectorAll(".note");
  if (noteElements.length === 0) return;

  // Initialize Sortable.js
  const isMobile = window.innerWidth <= 1000;

  sortableInstance = new Sortable(notesContainer, {
    animation: 200,
    easing: "ease-out",
    ghostClass: "sortable-ghost",
    chosenClass: "sortable-chosen",
    dragClass: "sortable-drag",
    // No handle on desktop = drag from anywhere on note
    // On mobile, use drag handle
    handle: isMobile ? ".drag-handle" : null,
    draggable: ".note:not(.editing)",
    forceFallback: false,
    fallbackTolerance: 0,
    delay: 0,
    // Filter out buttons and interactive elements - don't prevent default so inputs work
    filter: ".edit, .delete-btn, .accept, .discard, .copy-btn, .insert-placeholder-btn, .note-actions, .favorite-btn, .archive-btn, .color-swatch-trigger, .color-picker-popup, input, textarea, button",
    preventOnFilter: false,
    // Grid settings
    swapThreshold: 0.5,

    onStart: (evt) => {
      // Don't drag while editing
      const isEditing = evt.item.querySelector("input.note-title, textarea.note-text-edit") !== null;
      if (isEditing) {
        return false;
      }
      document.body.style.cursor = 'grabbing';
    },
    onEnd: (evt) => {
      document.body.style.cursor = '';
      updateDisplayIndexes();
      playPop();
    },
  });

  // Update drag handle visibility on resize
  resizeHandler = handleDragHandleVisibility;
  window.addEventListener("resize", resizeHandler);
  handleDragHandleVisibility();
}

// Update display indices after drag
export function updateDisplayIndexes() {
  const notesElements = document.querySelectorAll(".note");
  const totalNotes = notesElements.length;

  chrome.storage.local.get("notes", (data) => {
    const savedNotes = data.notes || {};

    notesElements.forEach((noteElem, i) => {
      const dataKey = noteElem.getAttribute("key");

      if (savedNotes[dataKey]) {
        savedNotes[dataKey].displayIndex = totalNotes - 1 - i;
        noteElem.setAttribute("display-index", totalNotes - 1 - i);
      }
    });

    chrome.storage.local.set({ notes: savedNotes }, () => {
      // Notes saved
    });
  });
}

// Handle drag handle visibility based on screen size
function handleDragHandleVisibility() {
  const dragHandles = document.querySelectorAll(".drag-handle");
  const isMobile = window.innerWidth <= 1000;

  dragHandles.forEach((handle) => {
    handle.style.display = isMobile ? "flex" : "none";
  });

  // Update Sortable handle option dynamically
  if (sortableInstance) {
    sortableInstance.option("handle", isMobile ? ".drag-handle" : null);
  }
}