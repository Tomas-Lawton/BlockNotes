import { updateDragDropListeners } from "./drag.js";
import { playPop } from "./sounds.js";
import { getDate } from "./util.js";

const input = document.getElementById("note-input");
const pasteButton = document.getElementById("instant-paste");
const noteMessage = document.getElementById("note-message");
const notes = document.getElementById("notes");

// Stats elements
const totalNotesElem = document.getElementById("total-notes");
const totalCharsElem = document.getElementById("total-chars");

let noteCounter = null;

// Update stats function - ensures proper sync with storage
function updateStats() {
  chrome.storage.local.get("notes", (data) => {
    const savedNotes = data.notes || {};
    const noteCount = Object.keys(savedNotes).length;
    let totalChars = 0;

    Object.values(savedNotes).forEach((note) => {
      totalChars += note.noteText?.length || 0;
    });

    if (totalNotesElem) totalNotesElem.textContent = noteCount;
    if (totalCharsElem)
      totalCharsElem.textContent = totalChars.toLocaleString();
  });
}

function deleteLocalNote(index) {
  chrome.storage.local.get("notes", (data) => {
    const savedNotes = data.notes || {};
    console.log("Deleted note: ", index);
    delete savedNotes[index];

    chrome.storage.local.set({ notes: savedNotes }, () => {
      // Update after storage completes
      checkNoteMessage(savedNotes);
      updateStats();
      updateDragDropListeners();
    });

    const audio = new Audio("./public/audio/swish.mp3");
    audio.play();
  });
}

function checkNoteMessage(savedNotes) {
  if (Object.keys(savedNotes).length > 0) {
    noteMessage.style.display = "none";
  } else {
    noteMessage.style.display = "block";
  }
}

function saveLocalNote(noteData) {
  chrome.storage.local.get("notes", (data) => {
    const savedNotes = data.notes || {};
    const key = noteCounter.toString();
    noteData.noteName = noteData.noteName || `Note ${noteCounter + 1}`;
    savedNotes[key] = noteData;

    chrome.storage.local.set({ notes: savedNotes }, () => {
      // Update after storage completes
      checkNoteMessage(savedNotes);
      updateStats();
    });

    noteCounter++;
    chrome.storage.local.set({ noteCounter: noteCounter });
  });
}

function loadNotes() {
  chrome.storage.local.get("isInstalled", (data) => {
    let isInstalled = data.isInstalled;

    if (!isInstalled) {
      chrome.storage.local.set({ isInstalled: true }, () => {
        console.log("You Installed Blocknotes. Cool!");
      });
    }

    chrome.storage.local.get(["notes", "noteCounter"], (data) => {
      const savedNotes = data.notes || {};
      noteCounter = data.noteCounter || 0;

      console.log("Loaded Saved Notes: ", savedNotes);

      let sortedNotes = Object.entries(savedNotes).sort(
        ([, a], [, b]) => a.displayIndex - b.displayIndex
      );

      sortedNotes.forEach(([_, noteData], index) => {
        noteData.displayIndex = index;
        createNote(noteData);
      });

      checkNoteMessage(savedNotes);
      updateStats();
      console.log("Done loading notes.");
      updateDragDropListeners();
    });
  });
}

function makeNote(noteText) {
  if (!noteText || noteText.trim() === "") return;

  chrome.storage.local.get(["settings"], (data) => {
    const AIKEY = data.settings?.key;
    const date = getDate();
    const noteData = {
      noteText: noteText.trim(),
      date,
      noteIndex: noteCounter,
      displayIndex: 0,
    };

    const newNoteDOM = createNote(noteData);
    playPop();
    updateDragDropListeners();

    if (!AIKEY) {
      saveLocalNote(noteData);
    } else {
      // Use Gemini for note naming
      fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${AIKEY}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    text: `Suggest a concise and meaningful title for the following note content:\n"${noteText}". 
                        IT IS VERY CRITICALLY IMPORTANT YOU ANSWER WITH ONLY ONE NAME. 
                        Do your best to capture what the note actually contains so it is easy to remember what it was about later. 
                        Maximum 5 words suggested name.
                        If the note text is not understandable just combine a random color with a random animal and a random 2-digit number.
                        IT IS VERY CRITICALLY IMPORTANT YOU ANSWER DIRECTLY WITH ONLY ONE NAME.`,
                  },
                ],
              },
            ],
          }),
        }
      )
        .then((response) => response.json())
        .then((responseData) => {
          console.log("Gemini response: ", responseData);
          const suggestedName =
            responseData.candidates[0].content.parts[0].text.trim();
          const headingText = newNoteDOM.querySelector(".note-title");
          if (headingText) {
            headingText.textContent = suggestedName;
          }
          noteData.noteName = suggestedName;
          saveLocalNote(noteData);
        })
        .catch((error) => {
          console.error("Error generating note name with Gemini:", error);
          saveLocalNote(noteData);
        });
    }
  });
}

pasteButton.addEventListener("click", async () => {
  try {
    const noteText = await navigator.clipboard.readText();
    if (noteText && noteText.trim()) {
      makeNote(noteText);
      input.value = "";
    }
  } catch (err) {
    console.error("Failed to read clipboard contents: ", err);
  }
});

input.addEventListener("paste", (event) => {
  const noteText = (event.clipboardData || window.clipboardData).getData(
    "text"
  );
  event.preventDefault();
  if (noteText && noteText.trim()) {
    makeNote(noteText);
    input.value = "";
  }
});

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && input.value.trim() !== "") {
    makeNote(input.value.trim());
    input.value = "";
  }
});

function createNote({ noteText, date, noteIndex, displayIndex, noteName }) {
  // NOTE CONTENT
  const noteContent = document.createElement("div");
  noteContent.classList.add("note-content");

  const note = document.createElement("div");
  note.classList.add("draggable", "note");
  note.setAttribute("draggable", window.innerWidth > 1000);
  note.setAttribute("display-index", displayIndex ?? 0);
  note.setAttribute("key", noteIndex);

  // HEADER START
  const noteHeader = document.createElement("div");
  noteHeader.classList.add("note-header");

  let noteHeading = document.createElement("h3");
  noteHeading.textContent = noteName || `Note ${noteIndex + 1}`;
  noteHeading.classList.add("note-title");

  const editBtn = document.createElement("div");
  editBtn.classList.add("edit");
  const editIcon = document.createElement("img");
  editIcon.src = "./public/uicons/uicons-round-medium-outline-pencil.svg";
  editIcon.alt = "Edit";
  editIcon.width = 20;
  editIcon.height = 20;
  editBtn.appendChild(editIcon);

  const discardBtn = document.createElement("div");
  discardBtn.classList.add("discard");
  const discardIcon = document.createElement("img");
  discardIcon.src = "./public/uicons/uicons-round-medium-outline-close.svg";
  discardIcon.alt = "Discard";
  discardIcon.width = 20;
  discardIcon.height = 20;
  discardBtn.appendChild(discardIcon);

  const acceptBtn = document.createElement("div");
  acceptBtn.classList.add("accept");
  const acceptIcon = document.createElement("img");
  acceptIcon.src = "./public/uicons/uicons-round-medium-outline-checkmark.svg";
  acceptIcon.alt = "Accept";
  acceptIcon.width = 20;
  acceptIcon.height = 20;
  acceptBtn.appendChild(acceptIcon);

  const dateElem = document.createElement("p");
  dateElem.textContent = date;
  dateElem.classList.add("note-date");

  let noteTextDiv = document.createElement("div");
  noteTextDiv.textContent = noteText;
  noteTextDiv.classList.add("note-text");

  const actionContainer = document.createElement("div");
  const copyBtn = document.createElement("button");
  copyBtn.classList.add("copy-btn");
  const copyIcon = document.createElement("img");
  copyIcon.src = "./public/uicons/uicons-round-medium-outline-copy.svg";
  copyIcon.alt = "Copy";
  copyIcon.width = 18;
  copyIcon.height = 18;
  copyBtn.appendChild(copyIcon);
  copyBtn.appendChild(document.createTextNode("Copy"));

  const deleteIcon = document.createElement("img");
  deleteIcon.src = "./public/uicons/uicons-round-medium-outline-trash.svg";
  deleteIcon.alt = "Delete";
  deleteIcon.width = 20;
  deleteIcon.height = 20;
  const deleteBtn = document.createElement("div");
  deleteBtn.appendChild(deleteIcon);
  deleteBtn.classList.add("delete-btn");

  actionContainer.classList.add("note-actions");

  // DRAG HANDLE
  const dragIcon = document.createElement("img");
  dragIcon.src =
    "./public/uicons/uicons-round-medium-outline-3-dots-horizontal.svg";
  dragIcon.alt = "Drag";
  dragIcon.width = 20;
  dragIcon.height = 20;
  const dragHandle = document.createElement("div");
  dragHandle.appendChild(dragIcon);
  dragHandle.classList.add("drag-handle");
  dragHandle.style.display = window.innerWidth <= 1000 ? "flex" : "none";

  function updateHandleVisibility() {
    dragHandle.style.display = window.innerWidth <= 1000 ? "flex" : "none";
    note.setAttribute("draggable", window.innerWidth > 1000);
  }

  window.addEventListener("resize", updateHandleVisibility);

  if (window.innerWidth <= 1000) {
    dragHandle.addEventListener("mousedown", (e) => e.stopPropagation());
    dragHandle.addEventListener("touchstart", (e) => e.stopPropagation());
  }

  let originalTitle = noteHeading.textContent;
  let originalText = noteTextDiv.textContent;

  const handleKeydown = (e) => {
    if (e.key === "Enter") {
      acceptBtn.click();
    } else if (e.key === "Escape") {
      discardBtn.click();
    }
  };

  // Edit button
  editBtn.addEventListener("click", () => {
    editBtn.style.display = "none";
    acceptBtn.style.display = "flex";
    discardBtn.style.display = "flex";

    const input1 = document.createElement("input");
    input1.type = "text";
    input1.value = noteHeading.textContent;
    input1.classList.add("note-title");
    noteHeading.replaceWith(input1);

    const input2 = document.createElement("textarea");
    input2.name = "post";
    input2.maxLength = "5000";
    input2.value = noteTextDiv.textContent;
    input2.classList.add("note-text");
    noteTextDiv.replaceWith(input2);

    actionContainer.classList.add("note-background");
    note.draggable = false;

    const autoResize = () => (input2.style.height = `${input2.scrollHeight}px`);
    input2.addEventListener("input", autoResize);
    autoResize();

    noteHeading = input1;
    noteTextDiv = input2;
    input1.focus();

    document.addEventListener("keydown", handleKeydown);
  });

  // Accept button
  acceptBtn.addEventListener("click", () => {
    originalTitle = noteHeading.value;
    originalText = noteTextDiv.value;

    const newHeading = document.createElement("h3");
    newHeading.textContent = originalTitle;
    newHeading.classList.add("note-title");

    const newTextDiv = document.createElement("div");
    newTextDiv.textContent = originalText;
    newTextDiv.classList.add("note-text");

    noteHeading.replaceWith(newHeading);
    noteTextDiv.replaceWith(newTextDiv);
    noteHeading = newHeading;
    noteTextDiv = newTextDiv;

    // Update storage
    chrome.storage.local.get("notes", (data) => {
      const savedNotes = data.notes || {};
      const newDate = getDate();
      dateElem.textContent = newDate;
      savedNotes[noteIndex] = {
        noteText: originalText,
        date: newDate,
        noteIndex,
        displayIndex,
        noteName: originalTitle,
      };

      chrome.storage.local.set({ notes: savedNotes }, () => {
        updateStats();
      });
    });

    actionContainer.classList.remove("note-background");
    note.draggable = true;

    editBtn.style.display = "flex";
    acceptBtn.style.display = "none";
    discardBtn.style.display = "none";

    document.removeEventListener("keydown", handleKeydown);
  });

  // Discard button
  discardBtn.addEventListener("click", () => {
    const newHeading = document.createElement("h3");
    newHeading.textContent = originalTitle;
    newHeading.classList.add("note-title");

    const newTextDiv = document.createElement("div");
    newTextDiv.textContent = originalText;
    newTextDiv.classList.add("note-text");

    noteHeading.replaceWith(newHeading);
    noteTextDiv.replaceWith(newTextDiv);

    noteHeading = newHeading;
    noteTextDiv = newTextDiv;

    actionContainer.classList.remove("note-background");
    note.draggable = true;

    editBtn.style.display = "flex";
    acceptBtn.style.display = "none";
    discardBtn.style.display = "none";

    document.removeEventListener("keydown", handleKeydown);
  });

  // Delete button
  deleteBtn.addEventListener("click", () => {
    note.remove();
    deleteLocalNote(noteIndex);
  });

  // Copy button
  copyBtn.addEventListener("click", () => {
    navigator.clipboard
      .writeText(originalText)
      .then(() => {
        const allCopyBtns = notes.querySelectorAll(".copy-btn");
        allCopyBtns.forEach((btn) => {
          if (btn.childNodes[1]) {
            btn.childNodes[1].textContent = "Copy";
          }
        });
        if (copyBtn.childNodes[1]) {
          copyBtn.childNodes[1].textContent = "Copied";
        }
      })
      .catch((err) => console.error("Failed to copy text: ", err));
  });

  // Append elements
  noteHeader.appendChild(noteHeading);
  noteHeader.appendChild(editBtn);
  noteHeader.appendChild(acceptBtn);
  noteHeader.appendChild(discardBtn);
  noteHeader.appendChild(deleteBtn);

  actionContainer.appendChild(copyBtn);
  actionContainer.appendChild(dateElem);

  noteContent.appendChild(dragHandle);
  noteContent.appendChild(noteHeader);
  noteContent.appendChild(noteTextDiv);
  note.appendChild(noteContent);
  note.appendChild(actionContainer);

  notes.prepend(note);

  return note;
}

// Quick action handlers
function initQuickActions() {
  const quickActionButtons = document.querySelectorAll(".quick-action-btn");

  quickActionButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.getAttribute("data-action");

      switch (action) {
        case "sort-date":
          sortNotesByDate();
          break;
        case "sort-title":
          sortNotesByTitle();
          break;
        case "clear-all":
          clearAllNotes();
          break;
      }
    });
  });
}

// Sort by date
function sortNotesByDate() {
  chrome.storage.local.get("notes", (data) => {
    const savedNotes = data.notes || {};
    const noteElements = Array.from(notes.children);

    noteElements.sort((a, b) => {
      const keyA = a.getAttribute("key");
      const keyB = b.getAttribute("key");
      const dateA = new Date(savedNotes[keyA]?.date || 0);
      const dateB = new Date(savedNotes[keyB]?.date || 0);
      return dateB - dateA;
    });

    notes.innerHTML = "";
    noteElements.forEach((elem) => notes.appendChild(elem));

    updateDisplayIndices();
  });
}

// Sort by title
function sortNotesByTitle() {
  chrome.storage.local.get("notes", (data) => {
    const savedNotes = data.notes || {};
    const noteElements = Array.from(notes.children);

    noteElements.sort((a, b) => {
      const keyA = a.getAttribute("key");
      const keyB = b.getAttribute("key");
      const titleA = (savedNotes[keyA]?.noteName || "").toLowerCase();
      const titleB = (savedNotes[keyB]?.noteName || "").toLowerCase();
      return titleA.localeCompare(titleB);
    });

    notes.innerHTML = "";
    noteElements.forEach((elem) => notes.appendChild(elem));

    updateDisplayIndices();
  });
}

// Clear all notes
function clearAllNotes() {
  if (
    confirm("Are you sure you want to delete all notes? This cannot be undone.")
  ) {
    chrome.storage.local.set({ notes: {}, noteCounter: 0 }, () => {
      notes.innerHTML = "";
      noteCounter = 0;
      updateStats();
      checkNoteMessage({});
      console.log("All notes cleared");
    });
  }
}

// Update display indices
function updateDisplayIndices() {
  chrome.storage.local.get("notes", (data) => {
    const savedNotes = data.notes || {};
    const noteElements = Array.from(notes.children);

    noteElements.forEach((elem, index) => {
      const key = elem.getAttribute("key");
      elem.setAttribute("display-index", index);
      if (savedNotes[key]) {
        savedNotes[key].displayIndex = index;
      }
    });

    chrome.storage.local.set({ notes: savedNotes }, () => {
      console.log("Display indices updated");
    });
  });
}

// Load background shapes with proper positioning
function loadShapePositions() {
  const shapes = document.querySelectorAll(".background-svg-animate");
  const isSmallScreen = window.innerWidth < 600;

  shapes.forEach((shape, index) => {
    if (isSmallScreen) {
      shape.style.display = "none";
    } else {
      let width = Math.floor(Math.random() * 150) + 150; // 150-300px
      shape.style.width = `${width}px`;
      shape.style.height = `${width}px`;
      shape.style.display = "block";

      const rotation = Math.floor(Math.random() * 4) * 90;
      shape.style.transform = `rotate(${rotation}deg)`;

      let rangeX = window.innerWidth - width - 100;
      let rangeY = window.innerHeight - width - 200;

      let x = Math.floor(Math.random() * rangeX) + 50;
      let y = Math.floor(Math.random() * rangeY) + 150;

      shape.style.left = `${x}px`;
      shape.style.top = `${y}px`;

      // Add subtle animation
      shape.style.animation = `float ${6 + index}s ease-in-out infinite`;
      shape.style.animationDelay = `${index * 0.5}s`;
    }
  });
}

window.addEventListener("resize", loadShapePositions);

// Global keyboard shortcuts
document.addEventListener("keydown", async (event) => {
  // "/" to focus and auto-paste
  if (event.key === "/" && document.activeElement !== input) {
    event.preventDefault();
    input.focus();
    try {
      const clipboardText = await navigator.clipboard.readText();
      input.value = clipboardText;
    } catch (error) {
      console.error("Failed to read clipboard: ", error);
    }
  }
});

// Initialize everything
console.log("Initializing BlockNotes...");
loadShapePositions();
loadNotes();
initQuickActions();
console.log("BlockNotes initialized successfully!");
