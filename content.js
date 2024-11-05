console.log("Content script loaded");

let lastFocusedElement = null;

document.addEventListener(
  "focus",
  (event) => {
    const target = event.target;
    if (
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable) &&
      !target.hasAttribute("popup_input_box")
    ) {
      lastFocusedElement = target;
      console.log("Set target:", lastFocusedElement);
    }
  },
  true
);

function createNoteInputField(notes) {
  console.log("Active mode");

  const inputField = document.createElement("input");
  inputField.setAttribute("popup_input_box", "popup-input-box-1234");
  inputField.style.position = "absolute";
  inputField.style.zIndex = "9999";

  if (lastFocusedElement) {
    const rect = lastFocusedElement.getBoundingClientRect();
    inputField.style.top = `${rect.bottom + window.scrollY}px`;
    inputField.style.left = `${rect.left + window.scrollX}px`;
  }

  document.body.appendChild(inputField);
  inputField.focus();

  // Create a container for matching notes
  const notesContainer = document.createElement("ul");
  notesContainer.id = "notes-container"; // Set ID for styling
  notesContainer.style.position = "absolute";
  notesContainer.style.zIndex = "9999";
  notesContainer.style.listStyleType = "none";
  notesContainer.style.padding = "0";
  notesContainer.style.margin = "0";
  notesContainer.style.top = `${inputField.getBoundingClientRect().bottom + window.scrollY}px`;
  notesContainer.style.left = `${inputField.getBoundingClientRect().left + window.scrollX}px`;
  notesContainer.style.width = `${inputField.offsetWidth}px`;
  notesContainer.style.backgroundColor = "white";
  notesContainer.style.border = "1px solid #ccc";
  notesContainer.style.maxHeight = "200px";
  notesContainer.style.overflowY = "auto";
  notesContainer.style.display = "none"; // Initially hidden
  document.body.appendChild(notesContainer);

  // Function to show matching notes
  const showMatchingNotes = () => {
    const query = inputField.value.toLowerCase();
    const matchingNotes = Object.entries(notes)
      .filter(
        ([, note]) =>
          note.noteName && note.noteName.toLowerCase().startsWith(query)
      )
      .map(([, note]) => note);

    // If there are no matches, show the first five notes
    if (matchingNotes.length === 0) {
      const firstFiveNotes = Object.entries(notes)
        .slice(0, 5)
        .map(([, note]) => note);
      matchingNotes.push(...firstFiveNotes);
    }

    // Clear previous notes
    notesContainer.innerHTML = "";

    // Populate matching notes
    matchingNotes.forEach((note) => {
      const li = document.createElement("li");
      li.textContent = note.noteName; // Use noteName for display
      li.style.cursor = "pointer";
      li.style.padding = "4px";
      li.style.borderBottom = "1px solid #ccc";

      // Ensure that the note has text to paste
      li.addEventListener("click", () => {
        console.log('Note clicked:', note.noteName);
        if (note.noteText) {
          pasteValueToTarget(note.noteText, true); // Paste the note content
        } else {
          console.warn(`No text available for note: ${note.noteName}`);
        }

        inputField.blur(); // Remove input field after selection
        lastFocusedElement.focus(); // Restore focus to the last focused input
        notesContainer.style.display = "none"; // Hide notes container
      });

      notesContainer.appendChild(li);
    });
    // Show or hide the container based on matches
    notesContainer.style.display = matchingNotes.length > 0 ? "block" : "none";
  };

  // Show matching notes initially and on each keyup
  showMatchingNotes(); // Show notes immediately
  inputField.addEventListener("keyup", showMatchingNotes);

  inputField.addEventListener("blur", () => {
    document.body.removeChild(inputField);
    document.body.removeChild(notesContainer); // Remove notes container on blur
  });

  inputField.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      const selectedNote = Object.entries(notes).find(
        ([, note]) =>
          note.noteName &&
          note.noteName.toLowerCase().includes(inputField.value.toLowerCase())
      );
      if (selectedNote) {
        const noteContent = selectedNote[1].noteText;
        console.log("Pasted Value:", noteContent);
        pasteValueToTarget(noteContent, true);
      } else {
        console.warn("No matching note found on Enter key.");
      }
      inputField.blur();
      notesContainer.style.display = "none"; // Hide notes container on enter
    } else if (
      event.key === "Escape" ||
      (event.key === "Backspace" && inputField.value === "")
    ) {
      inputField.blur();
      lastFocusedElement.focus();
      notesContainer.style.display = "none"; // Hide notes container on escape or backspace
    }
  });
}

function pasteValueToTarget(value, fromKeyUp = false) {
  const targetElement = lastFocusedElement;
  console.log("Pasting value:", value, "to target:", targetElement);

  if (!targetElement) {
    console.error("No input, textarea, or contenteditable element was found.");
    return;
  }

  if (targetElement.isContentEditable) {
    const selection = window.getSelection();
    const range = selection.getRangeAt(0);

    if (fromKeyUp) {
      range.deleteContents(); // Delete last character if triggered by keyup
    }

    const textNode = document.createTextNode(value);
    range.insertNode(textNode);
    range.setStartAfter(textNode);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    console.log(`Inserted "${value}" into content editable element.`);
  } else {
    if (fromKeyUp) {
      targetElement.value = targetElement.value.slice(0, -1) + value; // Remove last character
    } else {
      targetElement.value += value; // Just append the value
    }
    targetElement.dispatchEvent(new Event("input", { bubbles: true }));
    console.log(`Inserted "${value}" into input/textarea element.`);
  }
}

chrome.storage.sync.get("notes", (data) => {
  const notes = data.notes || {};
  console.log("Fetched Notes:", notes);

  document.addEventListener("keyup", (event) => {
    if (event.key === "/") {
      createNoteInputField(notes);
    }
  });
});

chrome.runtime.onMessage.addListener((request) => {
  if (request.action === "pasteValue") {
    pasteValueToTarget(request.value);
  }
});