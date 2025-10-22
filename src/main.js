import { updateDragDropListeners } from "./drag.js";
import { playPop } from "./sounds.js";
import { getDate } from "./util.js";

const input = document.getElementById("note-input");
const pasteButton = document.getElementById("instant-paste");
const noteMessage = document.getElementById("note-message");
const notes = document.getElementById("notes");

let noteCounter = null; // because of the default note.

function deleteLocalNote(index) {
  // console.log("deleting, ", index);

  chrome.storage.local.get("notes", (data) => {
    const savedNotes = data.notes || {};
    console.log("Deleted note: ", index);
    delete savedNotes[index];
    checkNoteMessage(savedNotes);
    updateDragDropListeners();

    chrome.storage.local.set({ notes: savedNotes }, () => {
      // console.log("Notes saved:", savedNotes);
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
    noteData.noteName = `Note ${noteCounter+1}`; // Default name
    savedNotes[key] = noteData; // set key (index) to current count
    // console.log("Saving note key: ", key)
    // console.log("Saving note data: ", noteData)
    chrome.storage.local.set({ notes: savedNotes }, () => {
      // console.log("Notes saved:", savedNotes);
    });
    checkNoteMessage(savedNotes);

    noteCounter++; // increment the count
    chrome.storage.local.set({ noteCounter: noteCounter }, () => {
      // console.log("Set counter:", noteCounter);
    });
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

    chrome.storage.local.get("notes", (data) => {
      const savedNotes = data.notes || {};
      console.log("Loaded Saved Notes: ", savedNotes);
      chrome.storage.local.get(
        "noteCounter",
        (data) => (noteCounter = data.noteCounter)
      );
      let sortedNotes = Object.entries(savedNotes).sort(
        ([, a], [, b]) => a.displayIndex - b.displayIndex
      );
      // console.log(sortedNotes);

      sortedNotes.forEach(([_, data], index) => {
        data.displayIndex = index;
        createNote(data);
      });

      // console.log(sortedNotes);
      checkNoteMessage(sortedNotes);
      console.log("Done loading notes.");
      updateDragDropListeners();
    });
  });
}

function makeNote(noteText) {
  chrome.storage.local.get(["settings"], (data) => {
    const AIKEY = data.settings?.key;
    const date = getDate();
    const noteData = { noteText, date, noteIndex: noteCounter };
    const newNoteDOM = createNote(noteData);
    playPop();
    updateDragDropListeners();

    if (!AIKEY) {
      saveLocalNote(noteData); // directly
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
                    text: `Suggest a one concise and meaningful title for the following note content:\n"${noteText}. 
                        IT IS VERY CRITICALLY IMPORTANT YOU ANSWER WITH ONLY ONE NAME. 
                        Do your best to capture what the note actually contains so it is easy to remember what it was about later. 
                        Maximum 5 words suggested name.
                        If the note text is not understandable just combine a random color with a random animal and a random 2-digit number
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
            responseData.candidates[0].content.parts[0].text;
          // console.log(suggestedName)
          const headingText = newNoteDOM.querySelector(".note-title");
          headingText.textContent = suggestedName;
          noteData.noteName = suggestedName;
          saveLocalNote(noteData); // Finally save it
        })
        .catch((error) =>
          console.error("Error generating note name with Gemini:", error)
        );
    }
  });
}

pasteButton.addEventListener("click", async () => {
  try {
    const noteText = await navigator.clipboard.readText(); // Read text from the clipboard
    makeNote(noteText); // Create the note with the pasted text
    input.value = ""; // Clear input after use
  } catch (err) {
    console.error("Failed to read clipboard contents: ", err);
  }
});

input.addEventListener("paste", (event) => {
  const noteText = (event.clipboardData || window.clipboardData).getData(
    "text"
  );
  event.preventDefault();
  makeNote(noteText);
  input.value = "";
});

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && input.value.trim() !== "") {
    makeNote(input.value.trim());
    input.value = "";
  }
});

function createNote({ noteText, date, noteIndex, displayIndex, noteName }) {
  // console.log("Creating note: ", noteText, date, noteIndex);

  // NOTE CONTENT
  const noteContent = document.createElement("div");
  noteContent.classList.add("note-content");

  const note = document.createElement("div");
  note.classList.add("draggable", "note");
  note.setAttribute("draggable", window.innerWidth > 1000); // draggable only on large screens
  note.setAttribute("display-index", displayIndex);
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
  editBtn.appendChild(editIcon);

  const discardBtn = document.createElement("div");
  discardBtn.classList.add("discard");
  const discardIcon = document.createElement("img");
  discardIcon.src = "./public/uicons/uicons-round-medium-outline-close.svg";
  discardBtn.appendChild(discardIcon);

  const acceptBtn = document.createElement("div");
  acceptBtn.classList.add("accept");
  const acceptIcon = document.createElement("img");
  acceptIcon.src = "./public/uicons/uicons-round-medium-outline-checkmark.svg";
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
  copyBtn.appendChild(copyIcon);
  copyBtn.appendChild(document.createTextNode("Copy"));

  const deleteIcon = document.createElement("img");
  deleteIcon.src = "./public/uicons/uicons-round-medium-outline-trash.svg";
  const deleteBtn = document.createElement("div");
  deleteBtn.appendChild(deleteIcon);
  deleteBtn.classList.add("delete-btn");

  actionContainer.classList.add("note-actions");

  // DRAG HANDLE (Visible on touch devices only)
  const dragIcon = document.createElement("img");
  dragIcon.src =
    "./public/uicons/uicons-round-medium-outline-3-dots-horizontal.svg";
  const dragHandle = document.createElement("div");
  dragHandle.appendChild(dragIcon);
  dragHandle.classList.add("drag-handle");
  dragHandle.style.display = window.innerWidth <= 1000 ? "flex" : "none";

  // Show or hide drag handle based on screen width
  function updateHandleVisibility() {
    dragHandle.style.display = window.innerWidth <= 1000 ? "flex" : "none";
    note.setAttribute("draggable", window.innerWidth > 1000); // Entire note draggable on larger screens
  }

  window.addEventListener("resize", updateHandleVisibility);

  // Drag only from handle on small screens
  if (window.innerWidth <= 1000) {
    dragHandle.addEventListener("mousedown", (e) => e.stopPropagation());
    dragHandle.addEventListener("touchstart", (e) => e.stopPropagation());
  }

  let originalTitle = noteHeading.textContent;
  let originalText = noteTextDiv.textContent;

  const handleKeydown = (e) => {
    if (e.key === "Enter") {
      // Save the changes
      acceptBtn.click();
    } else if (e.key === "Escape") {
      // Discard the changes
      discardBtn.click();
    }
  };

  // Event listeners for edit, delete, copy, etc.
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

    // Add keydown event listener when in edit mode
    document.addEventListener("keydown", handleKeydown);
  });

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

    // Update local storage with the new note data
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
        // console.log("Notes saved:", savedNotes);
      });
    });

    actionContainer.classList.remove("note-background");
    note.draggable = true;

    editBtn.style.display = "flex";
    acceptBtn.style.display = "none";
    discardBtn.style.display = "none";

    // Remove keydown event listener after saving
    document.removeEventListener("keydown", handleKeydown);
  });

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

    // Remove keydown event listener after discarding
    document.removeEventListener("keydown", handleKeydown);
  });

  deleteBtn.addEventListener("click", () => {
    note.remove();
    deleteLocalNote(noteIndex); // Remove note using index
  });

  copyBtn.addEventListener("click", (e) => {
    navigator.clipboard
      .writeText(originalText)
      .then(() => {
        const allNotes = notes.querySelectorAll(".copy-btn");
        allNotes.forEach((singleNote) => {
          singleNote.childNodes[1].textContent = "Copy";
        });
        copyBtn.childNodes[1].textContent = "Copied";
      })
      .catch((err) => console.error("Failed to copy text: ", err));
  });

  // Append elements to note structure
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

  notes.prepend(note); // Display in reverse order

  return note;
}

function loadShapePositions() {
  const shapes = document.querySelectorAll(".background-svg-animate");
  const isSmallScreen = window.innerWidth < 600;

  shapes.forEach((shape) => {
    if (isSmallScreen) {
      shape.style.display = "none"; // Hide shapes on small screens
    } else {
      // Set shape dimensions within a reasonable size
      let width = Math.floor(Math.random() * 150) + 150; // Between 150 and 300
      shape.style.width = `${width}px`;
      shape.style.height = `${width}px`;
      shape.style.display = "block";

      // Random rotation (e.g., 0, 90, 180, or 270 degrees)
      const rotation = Math.floor(Math.random() * 4) * 90;
      shape.style.transform = `rotate(${rotation}deg)`;

      // Calculate position to prevent overflow, considering rotation
      const shapeSize = width;
      const rotatedSize =
        rotation === 90 || rotation === 270 ? shapeSize : shapeSize; // For 90 or 270, the size swaps, but it's the same here because it's square

      let rangeX = window.innerWidth - rotatedSize; // Account for width of shape and some margin
      let rangeY = window.innerHeight - rotatedSize - 140; // Account for height of shape and some margin

      // Position the shape randomly within the range, ensuring it fits in the viewport
      let x = Math.floor(Math.random() * rangeX);
      let y = Math.floor(Math.random() * rangeY) + 140;

      shape.style.left = `${x}px`;
      shape.style.top = `${y}px`;
    }
  });
}

window.addEventListener("resize", loadShapePositions);

document.addEventListener("keydown", async (event) => {
  if (event.key === "/") {
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

loadShapePositions();
loadNotes();
