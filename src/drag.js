import { playPop } from "./sounds.js";

// Detect screen width initially
let isVerticalOnly = window.innerWidth <= 1000;
let isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

export function updateDragDropListeners() {
  const draggables = document.querySelectorAll(".draggable");
  const containers = document.querySelectorAll(".container");

  // Update the drag mode on resize events
  window.addEventListener("resize", () => {
    isVerticalOnly = window.innerWidth <= 1000;
    handleDragHandleVisibility();
  });

  draggables.forEach((draggable) => {
    let originalContainer = null;
    let originalIndex = null;
    let touchStartY = 0;
    let touchStartX = 0;
    let isDragging = false;
    let placeholder = null;

    // Select the drag handle within the draggable note
    const dragHandle = draggable.querySelector(".drag-handle");

    // ============ DESKTOP DRAG EVENTS ============
    draggable.addEventListener("dragstart", (e) => {
      draggable.classList.add("dragging");
      originalContainer = draggable.closest(".container");
      originalIndex = Array.from(originalContainer.children).indexOf(draggable);
    });

    draggable.addEventListener("dragend", () => {
      draggable.classList.remove("dragging");
      const newContainer = draggable.closest(".container");
      if (newContainer) {
        updateDisplayIndexes();
        playPop();
      }
    });

    // ============ MOBILE/TOUCH DRAG EVENTS ============
    if (dragHandle) {
      dragHandle.addEventListener("touchstart", (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        isDragging = true;
        const touch = e.touches[0];
        touchStartY = touch.clientY;
        touchStartX = touch.clientX;
        
        draggable.classList.add("dragging");
        originalContainer = draggable.closest(".container");
        originalIndex = Array.from(originalContainer.children).indexOf(draggable);
        
        // Create placeholder
        placeholder = document.createElement("div");
        placeholder.style.height = `${draggable.offsetHeight}px`;
        placeholder.style.width = `${draggable.offsetWidth}px`;
        placeholder.style.border = "4px dashed #05060f";
        placeholder.style.borderRadius = "2rem";
        placeholder.style.background = "rgba(5, 6, 15, 0.05)";
        placeholder.style.margin = draggable.style.margin;
        
        // Store original styles
        draggable.dataset.originalPosition = draggable.style.position || 'static';
        draggable.dataset.originalZIndex = draggable.style.zIndex || 'auto';
        draggable.dataset.originalWidth = draggable.style.width || '';
        draggable.dataset.originalLeft = draggable.style.left || '';
        draggable.dataset.originalTop = draggable.style.top || '';
        
        // Make draggable float
        const rect = draggable.getBoundingClientRect();
        draggable.style.position = "fixed";
        draggable.style.zIndex = "10000";
        draggable.style.width = `${rect.width}px`;
        draggable.style.left = `${rect.left}px`;
        draggable.style.top = `${rect.top}px`;
        draggable.style.transition = "none";
        draggable.style.opacity = "0.9";
        draggable.style.pointerEvents = "none";
        
        // Insert placeholder where element was
        draggable.parentNode.insertBefore(placeholder, draggable.nextSibling);
      });

      dragHandle.addEventListener("touchmove", (e) => {
        if (!isDragging) return;
        
        e.preventDefault();
        e.stopPropagation();
        
        const touch = e.touches[0];
        const deltaY = touch.clientY - touchStartY;
        const deltaX = touch.clientX - touchStartX;
        
        // Move the element with touch
        const currentLeft = parseFloat(draggable.dataset.originalLeft) || touch.clientX - draggable.offsetWidth / 2;
        const currentTop = parseFloat(draggable.dataset.originalTop) || touch.clientY - draggable.offsetHeight / 2;
        
        draggable.style.left = `${touch.clientX - draggable.offsetWidth / 2}px`;
        draggable.style.top = `${touch.clientY - draggable.offsetHeight / 2}px`;
        
        // Find where to insert based on touch position
        const container = originalContainer;
        const children = Array.from(container.children).filter(child => 
          child !== draggable && child !== placeholder && child.classList.contains('draggable')
        );
        
        let insertBefore = null;
        let minDistance = Infinity;
        
        children.forEach(child => {
          const childRect = child.getBoundingClientRect();
          const childCenter = childRect.top + childRect.height / 2;
          const distance = Math.abs(touch.clientY - childCenter);
          
          if (distance < minDistance) {
            minDistance = distance;
            if (touch.clientY < childCenter) {
              insertBefore = child;
            } else {
              insertBefore = child.nextSibling;
            }
          }
        });
        
        // Move placeholder
        if (placeholder && placeholder.parentNode === container) {
          if (insertBefore === null) {
            container.appendChild(placeholder);
          } else if (insertBefore !== placeholder && insertBefore !== placeholder.nextSibling) {
            container.insertBefore(placeholder, insertBefore);
          }
        }
      });

      dragHandle.addEventListener("touchend", (e) => {
        if (!isDragging) return;
        
        e.preventDefault();
        e.stopPropagation();
        
        isDragging = false;
        
        // Reset styles
        draggable.style.position = draggable.dataset.originalPosition;
        draggable.style.zIndex = draggable.dataset.originalZIndex;
        draggable.style.width = draggable.dataset.originalWidth;
        draggable.style.left = draggable.dataset.originalLeft;
        draggable.style.top = draggable.dataset.originalTop;
        draggable.style.transition = "";
        draggable.style.opacity = "1";
        draggable.style.pointerEvents = "";
        
        // Replace placeholder with actual element
        if (placeholder && placeholder.parentNode) {
          placeholder.parentNode.insertBefore(draggable, placeholder);
          placeholder.remove();
        }
        
        placeholder = null;
        draggable.classList.remove("dragging");
        
        const newContainer = draggable.closest(".container");
        if (newContainer) {
          updateDisplayIndexes();
          playPop();
        }
      });

      // Handle touch cancel
      dragHandle.addEventListener("touchcancel", (e) => {
        if (!isDragging) return;
        
        isDragging = false;
        
        // Reset styles
        draggable.style.position = draggable.dataset.originalPosition;
        draggable.style.zIndex = draggable.dataset.originalZIndex;
        draggable.style.width = draggable.dataset.originalWidth;
        draggable.style.left = draggable.dataset.originalLeft;
        draggable.style.top = draggable.dataset.originalTop;
        draggable.style.opacity = "1";
        draggable.style.pointerEvents = "";
        
        if (placeholder && placeholder.parentNode) {
          placeholder.remove();
        }
        placeholder = null;
        draggable.classList.remove("dragging");
      });
    }

    // Prevent drag initiation if touch is not on the drag handle
    draggable.addEventListener("touchstart", (e) => {
      if (!dragHandle?.contains(e.target)) {
        e.stopPropagation();
      }
    });
  });

  // ============ DESKTOP CONTAINER DRAG OVER ============
  containers.forEach((container) => {
    container.addEventListener("dragover", (e) => {
      e.preventDefault();
      const afterElement = getDragAfterElement(container, e.clientX, e.clientY);
      const draggable = document.querySelector(".dragging");

      if (!draggable) return;

      // Handle insertion
      const firstChild = container.firstElementChild;
      const firstChildRect = firstChild?.getBoundingClientRect();
      
      // Top insertion
      if (firstChildRect && e.clientY < firstChildRect.top + firstChildRect.height / 4) {
        if (container.firstElementChild !== draggable) {
          container.insertBefore(draggable, container.firstElementChild);
        }
      } else if (afterElement == null) {
        container.appendChild(draggable);
      } else {
        container.insertBefore(draggable, afterElement);
      }
    });
  });
}

// Function to get the nearest element after which to place the dragged element
function getDragAfterElement(container, x, y) {
  const draggableElements = [
    ...container.querySelectorAll(".draggable:not(.dragging)"),
  ];

  return draggableElements.reduce(
    (closest, child, index) => {
      const box = child.getBoundingClientRect();
      const nextBox =
        draggableElements[index + 1] &&
        draggableElements[index + 1].getBoundingClientRect();

      // For vertical-only layout (mobile)
      if (isVerticalOnly) {
        const offsetY = y - (box.top + box.height / 2);
        if (offsetY < 0 && offsetY > closest.offset) {
          return { offset: offsetY, element: child };
        }
      } else {
        // For desktop grid layout
        const centerY = box.top + box.height / 2;
        const inRow = Math.abs(y - centerY) < box.height / 2;
        const offsetX = x - (box.left + box.width / 2);

        if (inRow) {
          if (offsetX < 0 && offsetX > closest.offset) {
            return { offset: offsetX, element: child };
          }
        } else if (
          nextBox &&
          y > box.bottom &&
          y < nextBox.top &&
          closest.offset === Number.NEGATIVE_INFINITY
        ) {
          return { offset: 0, element: draggableElements[index + 1] };
        }
      }
      
      return closest;
    },
    { offset: Number.NEGATIVE_INFINITY }
  ).element;
}

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

function handleDragHandleVisibility() {
  const dragHandles = document.querySelectorAll(".drag-handle");
  const draggables = document.querySelectorAll(".draggable");
  const isVerticalOnly = window.innerWidth <= 1000;

  dragHandles.forEach((handle) => {
    if (isVerticalOnly) {
      handle.style.display = "flex";
    } else {
      handle.style.display = "none";
    }
  });
  
  draggables.forEach((draggable) => {
    draggable.setAttribute("draggable", !isVerticalOnly);
  });
}