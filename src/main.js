import { updateDragDropListeners } from "./drag.js";
import { playPop } from "./sounds.js";
import { getDate } from "./util.js";

// Toast notification system
function showToast(title, message, type = 'error', duration = 5000) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  toast.innerHTML = `
    <div class="toast-content">
      <div class="toast-title">${title}</div>
      <div class="toast-message">${message}</div>
    </div>
    <button class="toast-close">&times;</button>
  `;

  const closeBtn = toast.querySelector('.toast-close');
  closeBtn.addEventListener('click', () => {
    toast.style.animation = 'slideIn 0.3s ease reverse';
    setTimeout(() => toast.remove(), 300);
  });

  container.appendChild(toast);

  // Auto-remove after duration
  setTimeout(() => {
    if (toast.parentElement) {
      toast.style.animation = 'slideIn 0.3s ease reverse';
      setTimeout(() => toast.remove(), 300);
    }
  }, duration);
}

// Helper to create Lucide icons programmatically
function createIcon(name, size = 20, options = {}) {
  if (window.lucide && lucide.icons && lucide.icons[name]) {
    // Use Lucide's createElement API for browser builds
    const svg = lucide.createElement(lucide.icons[name]);
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    // Apply any additional options as attributes
    Object.entries(options).forEach(([key, value]) => {
      svg.setAttribute(key, value);
    });
    return svg;
  }
  // Fallback: create placeholder element that will be converted by lucide.createIcons()
  const icon = document.createElement('i');
  icon.setAttribute('data-lucide', name);
  icon.style.width = `${size}px`;
  icon.style.height = `${size}px`;
  // Try to convert fallback icons when Lucide is ready
  setTimeout(() => {
    if (window.lucide) lucide.createIcons({ nodes: [icon.parentElement] });
  }, 0);
  return icon;
}

// Helper for star icon with fill state
function createStarIcon(filled = false, size = 20) {
  const svg = createIcon('star', size);
  if (svg && svg.tagName === 'svg' && filled) {
    svg.setAttribute('fill', 'currentColor');
  }
  return svg;
}

// Note color palette - lighter colors for better text readability
const NOTE_COLORS = [
  { name: 'purple', value: '#c4b5fd' },
  { name: 'teal', value: '#5eead4' },
  { name: 'coral', value: '#fda4af' },
  { name: 'sky', value: '#7dd3fc' },
  { name: 'yellow', value: '#fde047' },
  { name: 'orange', value: '#fdba74' },
  { name: 'slate', value: '#94a3b8' },
  { name: 'white', value: '#ffffff' },
];

// Tone options for AI rewriting
const TONE_OPTIONS = [
  { name: 'Friendly', icon: '😊', description: 'Warm and approachable' },
  { name: 'Professional', icon: '💼', description: 'Business appropriate' },
  { name: 'Concise', icon: '✂️', description: 'Short and to the point' },
  { name: 'Persuasive', icon: '🎯', description: 'Compelling and convincing' },
  { name: 'Casual', icon: '👋', description: 'Relaxed and informal' },
];

// Default color for new notes (purple lavender)
const DEFAULT_NOTE_COLOR = NOTE_COLORS[1].value;

// Track currently editing note
let currentlyEditingNote = null;

// Current view state
let currentView = 'all'; // 'all', 'favorites', 'archive', 'tags'

// Prevent concurrent/duplicate note loading
let isLoadingNotes = false;

// Helper function to highlight {{placeholder}} patterns and code blocks
function highlightPlaceholders(text) {
  if (!text) return "";

  // First, find and extract code blocks BEFORE HTML escaping
  // This preserves the code content exactly as intended
  const codeBlocks = [];
  let processedText = text.replace(/```([\s\S]*?)```/g, (match, code) => {
    const index = codeBlocks.length;
    codeBlocks.push(code.trim());
    return `__CODE_BLOCK_${index}__`;
  });

  // Escape HTML to prevent XSS
  const escaped = processedText
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

  // Restore code blocks with proper styling
  let result = escaped;
  codeBlocks.forEach((code, index) => {
    // Escape HTML inside code blocks too
    const escapedCode = code
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    result = result.replace(
      `__CODE_BLOCK_${index}__`,
      `<code class="code-block">${escapedCode}</code>`
    );
  });

  // Replace inline `code` with styled inline code (single backticks, no newlines)
  result = result.replace(
    /`([^`\n]+)`/g,
    '<code class="inline-code">$1</code>'
  );

  // Replace {{placeholder}} with highlighted version
  result = result.replace(
    /\{\{([^}]+)\}\}/g,
    '<span class="placeholder-highlight">{{$1}}</span>'
  );

  return result;
}

const input = document.getElementById("note-input");
const pasteButton = document.getElementById("instant-paste");
const aiCreateToggle = document.getElementById("ai-create-toggle");
const noteMessage = document.getElementById("note-message");
// Note section title removed for cleaner UI
const notes = document.getElementById("notes");

const zone = document.getElementById("input-zone");

// AI Create mode state
let isAICreateMode = false;
const defaultPlaceholder = "Tap / key to paste notes immediately. Organize your thoughts with beautiful, draggable notes.";
const aiPlaceholder = "Describe the note you want... e.g. 'cold email template for job applications'";

// Stats elements
const totalNotesElem = document.getElementById("total-notes");
const totalCharsElem = document.getElementById("total-chars");

// Search and filter elements
const searchInput = document.getElementById("search-input");
const filterButtons = document.querySelectorAll('[data-filter]');
const sortButtons = document.querySelectorAll('[data-sort]');
const searchFilterBar = document.getElementById("search-filter-bar");

// AI configuration elements
const openAIModalBtn = document.getElementById("open-ai-modal");
const closeAIModalBtn = document.getElementById("close-ai-modal");
const aiModal = document.getElementById("ai-modal");
const aiModalOverlay = aiModal?.querySelector(".modal-overlay");
const aiProviderSelect = document.getElementById("ai-provider-select");
const aiModelSelect = document.getElementById("ai-model-select");
const aiApiKeyInput = document.getElementById("ai-api-key-input");
const aiSaveBtn = document.getElementById("ai-save-btn");
const aiCancelBtn = document.getElementById("ai-cancel-btn");

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
    delete savedNotes[index];

    chrome.storage.local.set({ notes: savedNotes }, () => {
      if (chrome.runtime.lastError) {
        console.error("Storage error:", chrome.runtime.lastError);
        alert("Failed to save note. Chrome error.");
        return;
      }
      // Update after storage completes
      checkNoteMessage(savedNotes);
      updateStats();
      updateDragDropListeners();
    });

    const audio = new Audio("./public/audio/swish.mp3");
    audio.play();
  });
}

function checkNoteMessage(savedNotes, view = currentView) {
  // Always hide note-message on tags view
  if (view === 'tags') {
    noteMessage.style.display = "none";
    return;
  }

  // Count notes based on view filter
  let visibleCount = 0;
  if (view === 'favorites') {
    visibleCount = Object.values(savedNotes).filter(n => n.favorited && !n.archived).length;
  } else if (view === 'archive') {
    visibleCount = Object.values(savedNotes).filter(n => n.archived).length;
  } else {
    visibleCount = Object.values(savedNotes).filter(n => !n.archived).length;
  }

  if (visibleCount > 0) {
    noteMessage.style.display = "none";
    notes.style.display = "grid";
    // Respect the hidden state setting for search bar
    chrome.storage.local.get("settings", (data) => {
      const settings = data.settings || {};
      if (!settings.searchBarHidden) {
        searchFilterBar.style.display = "flex";
      }
    });
  } else {
    // Update message based on view
    const messageContent = noteMessage.querySelector('.note-message-content');
    if (messageContent) {
      if (view === 'favorites') {
        messageContent.innerHTML = `
          <div class="note-message-icon">⭐</div>
          <strong>No favorites yet!</strong>
          Click the star icon on any note to add it to your favorites.`;
      } else if (view === 'archive') {
        messageContent.innerHTML = `
          <div class="note-message-icon">📦</div>
          <strong>Archive is empty</strong>
          Archived notes will appear here. Click the archive icon on any note to archive it.`;
      } else {
        messageContent.innerHTML = `
          <div class="note-message-icon">📝</div>
          <strong>Welcome to BlockNotes!</strong> Your notes will appear here.
          <br /><br />
          Type <strong>/</strong> in any text field to quickly insert notes.`;
      }
    }
    noteMessage.style.display = "flex";
    notes.style.display = "none";
    searchFilterBar.style.display = "none";
  }
}

function saveLocalNote(noteData) {
  chrome.storage.local.get("notes", (data) => {
    const savedNotes = data.notes || {};

    // Use noteIndex as key (can be unique ID or legacy number)
    const key = noteData.noteIndex.toString();

    // Set default noteName if not present
    const noteCount = Object.keys(savedNotes).length;
    noteData.noteName = noteData.noteName || `Note ${noteCount + 1}`;
    noteData.noteName = noteData.noteName.slice(0, 100);

    // Store the note
    savedNotes[key] = noteData;

    chrome.storage.local.set({ notes: savedNotes }, () => {
      if (chrome.runtime.lastError) {
        console.error("Storage error:", chrome.runtime.lastError);
        alert("Failed to save note. Chrome error.");
        return;
      }
      checkNoteMessage(savedNotes);
      updateStats();
    });
  });
}

function loadNotes() {
  // Prevent concurrent loads that cause duplication
  if (isLoadingNotes) {
    console.log("Already loading notes, skipping...");
    return;
  }
  isLoadingNotes = true;

  chrome.storage.local.get("isInstalled", (data) => {
    let isInstalled = data.isInstalled;

    if (!isInstalled) {
      chrome.storage.local.set({ isInstalled: true }, () => {
        if (chrome.runtime.lastError) {
          console.error("Storage error:", chrome.runtime.lastError);
          alert("Failed to save note. Chrome error.");
          return;
        }
        console.log("You Installed Blocknotes. Cool!");
      });
    }

    chrome.storage.local.get(["notes", "noteCounter"], (data) => {
      const savedNotes = data.notes || {};

      console.log("Loaded Saved Notes: ", savedNotes);

      // Clear existing notes before loading to prevent duplication
      notes.innerHTML = "";

      let sortedNotes = Object.entries(savedNotes).sort(
        ([, a], [, b]) => a.displayIndex - b.displayIndex
      );

      sortedNotes.forEach(([_, noteData], index) => {
        createNote(noteData);
      });

      checkNoteMessage(savedNotes);
      updateStats();
      console.log("Done loading notes.");
      updateDragDropListeners();

      // Reinitialize Lucide icons in case any were added dynamically
      if (window.lucide) {
        lucide.createIcons();
      }

      // Allow next load after this one completes
      isLoadingNotes = false;
    });
  });
}

// AI naming function that supports multiple providers
async function generateNoteName(noteText, provider, model, apiKey, customBaseUrl = "") {
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

        // console.log("Gemini API response status:", response.status);
        // console.log("Gemini API response ok:", response.ok);

        const data = await response.json();
        // console.log("Gemini full response:", data);

        if (!response.ok) {
          throw new Error(`Gemini API error: ${response.status} - ${JSON.stringify(data)}`);
        }

        if (!data.candidates || !data.candidates[0]) {
          throw new Error(`No candidates in Gemini response: ${JSON.stringify(data)}`);
        }

        return data.candidates[0].content.parts[0].text.trim().replace(/^["'`]+|["'`]+$/g, '');
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

        if (!response.ok) {
          throw new Error(`OpenAI API error: ${response.status} - ${JSON.stringify(data)}`);
        }

        if (!data.choices || !data.choices[0] || !data.choices[0].message) {
          throw new Error(`Invalid OpenAI response: ${JSON.stringify(data)}`);
        }

        return data.choices[0].message.content.trim().replace(/^["'`]+|["'`]+$/g, '');
      }

      case "anthropic": {
        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: model,
            max_tokens: 20,
            messages: [{ role: "user", content: prompt }],
          }),
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(`Anthropic API error: ${response.status} - ${JSON.stringify(data)}`);
        }

        if (!data.content || !data.content[0] || !data.content[0].text) {
          throw new Error(`Invalid Anthropic response: ${JSON.stringify(data)}`);
        }

        return data.content[0].text.trim().replace(/^["'`]+|["'`]+$/g, '');
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

        if (!response.ok) {
          throw new Error(`Groq API error: ${response.status} - ${JSON.stringify(data)}`);
        }

        if (!data.choices || !data.choices[0] || !data.choices[0].message) {
          throw new Error(`Invalid Groq response: ${JSON.stringify(data)}`);
        }

        return data.choices[0].message.content.trim().replace(/^["'`]+|["'`]+$/g, '');
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

        if (!response.ok) {
          throw new Error(`Custom API error: ${response.status} - ${JSON.stringify(data)}`);
        }

        if (!data.choices || !data.choices[0] || !data.choices[0].message) {
          throw new Error(`Invalid Custom API response: ${JSON.stringify(data)}`);
        }

        return data.choices[0].message.content.trim().replace(/^["'`]+|["'`]+$/g, '');
      }

      default:
        throw new Error(`Unknown provider: ${provider}`);
    }
  } catch (error) {
    console.error(`Error with ${provider}:`, error);
    throw error;
  }
}

// Generic AI call function for reusable AI operations
async function callAI(prompt, provider, model, apiKey, maxTokens = 500, customBaseUrl = "") {
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
        if (!response.ok) {
          const errorMsg = data.error?.message || `Status ${response.status}`;
          throw new Error(`Gemini: ${errorMsg}`);
        }
        return data.candidates[0].content.parts[0].text.trim();
      }
      case "openai": {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: model,
            messages: [{ role: "user", content: prompt }],
            max_tokens: maxTokens,
            temperature: 0.7,
          }),
        });
        const data = await response.json();
        if (!response.ok) {
          const errorMsg = data.error?.message || `Status ${response.status}`;
          throw new Error(`OpenAI: ${errorMsg}`);
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
          },
          body: JSON.stringify({
            model: model,
            max_tokens: maxTokens,
            messages: [{ role: "user", content: prompt }],
          }),
        });
        const data = await response.json();
        if (!response.ok) {
          const errorMsg = data.error?.message || `Status ${response.status}`;
          throw new Error(`Anthropic: ${errorMsg}`);
        }
        return data.content[0].text.trim();
      }
      case "groq": {
        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: model,
            messages: [{ role: "user", content: prompt }],
            max_tokens: maxTokens,
            temperature: 0.7,
          }),
        });
        const data = await response.json();
        if (!response.ok) {
          const errorMsg = data.error?.message || `Status ${response.status}`;
          throw new Error(`Groq: ${errorMsg}`);
        }
        return data.choices[0].message.content.trim();
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
            max_tokens: maxTokens,
            temperature: 0.7,
          }),
        });
        const data = await response.json();
        if (!response.ok) {
          const errorMsg = data.error?.message || `Status ${response.status}`;
          throw new Error(`Custom API: ${errorMsg}`);
        }
        return data.choices[0].message.content.trim();
      }
      default:
        throw new Error(`Unknown provider: ${provider}`);
    }
  } catch (error) {
    console.error(`AI call error with ${provider}:`, error);
    throw error;
  }
}

// Rewrite note in a specific tone
async function rewriteInTone(noteText, tone, provider, model, apiKey, customBaseUrl = "") {
  const prompt = `Rewrite the following text in a ${tone.toLowerCase()} tone. Keep the same meaning and any {{placeholders}} exactly as they are. Only return the rewritten text, nothing else.

Original text:
${noteText}

Rewritten in ${tone.toLowerCase()} tone:`;

  return await callAI(prompt, provider, model, apiKey, 1000, customBaseUrl);
}

// Generate note from description (AI Template Generator)
async function generateNoteFromDescription(description, provider, model, apiKey, customBaseUrl = "") {
  // Detect if this looks like a filled template (reverse template mode)
  const looksLikeFilledText = !description.toLowerCase().includes('template') &&
    !description.toLowerCase().includes('create') &&
    !description.toLowerCase().includes('write') &&
    !description.toLowerCase().includes('make') &&
    description.length > 100 &&
    !description.includes('{{');

  let prompt;
  if (looksLikeFilledText) {
    // Reverse template mode - extract template from filled text
    prompt = `Analyze this text and extract a reusable template from it. Replace specific names, companies, dates, and other variable content with {{placeholder}} markers.

Text to convert:
${description}

Return ONLY a JSON object with this exact format (no markdown, no explanation):
{"name": "Template Name", "body": "Template body with {{placeholders}}"}

Example: If given "Hi John, I saw your work on React and loved it", return:
{"name": "Appreciation Outreach", "body": "Hi {{name}}, I saw your work on {{topic}} and loved it"}`;
  } else {
    // Normal mode - generate template from description
    prompt = `Create a reusable note template based on this description: "${description}"

Requirements:
- Use {{placeholder}} syntax for any variable content (names, dates, specifics)
- Make it practical and ready to use
- Keep it concise but complete

Return ONLY a JSON object with this exact format (no markdown, no explanation):
{"name": "Short Template Name", "body": "The template content with {{placeholders}}"}

Example for "cold email for job application":
{"name": "Job Application", "body": "Hi {{hiring manager}},\\n\\nI'm excited to apply for the {{position}} role at {{company}}..."}`;
  }

  const result = await callAI(prompt, provider, model, apiKey, 800, customBaseUrl);

  // Parse JSON response
  try {
    // Try to extract JSON from response (in case AI adds extra text)
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return JSON.parse(result);
  } catch (e) {
    console.error("Failed to parse AI response:", result);
    // Fallback: use the raw response as body
    return { name: "Generated Note", body: result };
  }
}

function makeNote(noteText) {
  if (!noteText || noteText.trim() === "") return;

  chrome.storage.local.get(["settings", "notes"], (data) => {
    const settings = data.settings || {};
    const savedNotes = data.notes || {};
    const AIKEY = settings.key;
    const provider = settings.aiProvider || "groq";
    const model = settings.aiModel || "llama-3.1-8b-instant";
    const customBaseUrl = settings.customBaseUrl || "";

    // Generate unique ID using timestamp + random to prevent collisions
    const timestamp = Date.now();
    const uniqueId = `${timestamp}_${Math.random().toString(36).substr(2, 9)}`;
    const date = getDate();

    // Calculate next display index (current count of notes)
    const noteCount = Object.keys(savedNotes).length;

    // Use color of first displayed note, or default if no notes exist
    let noteColor = DEFAULT_NOTE_COLOR;
    if (Object.keys(savedNotes).length > 0) {
      // Find note with lowest displayIndex (appears first)
      const firstNote = Object.values(savedNotes).reduce((first, note) =>
        note.displayIndex < first.displayIndex ? note : first
      );
      noteColor = firstNote.noteColor || DEFAULT_NOTE_COLOR;
    }

    const noteData = {
      noteText: noteText.trim(),
      date,
      timestamp,
      noteIndex: uniqueId, // Use unique ID instead of counter
      displayIndex: noteCount,
      noteColor,
      favorited: false,
      archived: false,
      usageCount: 0,
      lastUsedAt: null,
    };

    // Save immediately BEFORE creating DOM element to prevent race conditions
    savedNotes[uniqueId] = noteData;

    chrome.storage.local.set({ notes: savedNotes }, () => {
      if (chrome.runtime.lastError) {
        console.error("Storage error:", chrome.runtime.lastError);
        return;
      }

      // Create DOM element only after successful save
      const newNoteDOM = createNote(noteData);
      playPop();
      updateDragDropListeners();
      checkNoteMessage(savedNotes);
      updateStats();

      // Check if auto-naming is enabled for new notes (defaults to true)
      const hasAIConfigured = AIKEY && provider && provider !== "none" && model;
      const autonameEnabled = settings.autonameNewNotes !== false;

      if (autonameEnabled && hasAIConfigured) {
        generateNoteName(noteText, provider, model, AIKEY, customBaseUrl)
          .then((suggestedName) => {
            // console.log(`${provider} response:`, suggestedName);
            const truncatedName = suggestedName.slice(0, 100);
            const headingText = newNoteDOM.querySelector(".note-title");
            if (headingText) {
              headingText.textContent = truncatedName;
            }
            noteData.noteName = truncatedName;

            // Update storage with AI-generated name
            chrome.storage.local.get("notes", (data) => {
              const notes = data.notes || {};
              if (notes[uniqueId]) {
                notes[uniqueId].noteName = truncatedName;
                chrome.storage.local.set({ notes: notes });
              }
            });
          })
          .catch((error) => {
            console.error(`Error generating note name with ${provider}:`, error);
          });
      }
    });
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

input.addEventListener("keydown", async (event) => {
  if (event.key === "Enter" && input.value.trim() !== "") {
    if (isAICreateMode) {
      await handleAICreate(input.value.trim());
    } else {
      makeNote(input.value.trim());
    }
    input.value = "";
  }
});

// Handle AI note creation
async function handleAICreate(description) {
  const data = await new Promise(resolve => {
    chrome.storage.local.get(["settings", "notes"], data => resolve(data));
  });
  const settings = data.settings || {};
  const savedNotes = data.notes || {};

  if (!settings.key || !settings.aiProvider) {
    showToast("AI Not Configured", "Please configure AI settings first (click the sparkles icon)", "warning");
    return;
  }

  // Show loading state
  input.disabled = true;
  input.placeholder = "AI is generating your note...";

  try {
    const result = await generateNoteFromDescription(
      description,
      settings.aiProvider || "groq",
      settings.aiModel || "llama-3.1-8b-instant",
      settings.key,
      settings.customBaseUrl || ""
    );

    if (result && (result.body || result.content)) {
      // Generate unique ID
      const timestamp = Date.now();
      const uniqueId = `${timestamp}_${Math.random().toString(36).substr(2, 9)}`;
      const noteCount = Object.keys(savedNotes).length;

      const noteData = {
        noteText: result.body || result.content,
        noteName: (result.name || result.title || "AI Generated Note").slice(0, 100),
        date: getDate(),
        timestamp,
        noteIndex: uniqueId,
        displayIndex: noteCount,
        noteColor: DEFAULT_NOTE_COLOR,
        favorited: false,
        archived: false,
        usageCount: 0,
        lastUsedAt: null,
      };

      // Save to storage
      savedNotes[uniqueId] = noteData;
      chrome.storage.local.set({ notes: savedNotes }, () => {
        if (chrome.runtime.lastError) {
          console.error("Storage error:", chrome.runtime.lastError);
          showToast("Storage Error", "Failed to save note to Chrome storage.", "error");
          return;
        }

        // Create DOM element
        const newNote = createNote(noteData);
        playPop();
        updateDragDropListeners();
        checkNoteMessage(savedNotes);
        updateStats();
      });
    } else {
      showToast("Generation Failed", "AI returned an empty response. Please try again.", "error");
    }
  } catch (error) {
    console.error("AI create error:", error);
    showToast("AI Error", error.message, "error");
  } finally {
    input.disabled = false;
    input.placeholder = aiPlaceholder;
    input.focus();
  }
}

// AI Create toggle
if (aiCreateToggle) {
  aiCreateToggle.addEventListener("click", () => {
    isAICreateMode = !isAICreateMode;
    aiCreateToggle.classList.toggle("active", isAICreateMode);
    input.classList.toggle("ai-mode", isAICreateMode);
    input.placeholder = isAICreateMode ? aiPlaceholder : defaultPlaceholder;
    input.focus();
  });
}

function createNote({ noteText, date, noteIndex, displayIndex, noteName, noteColor, favorited, archived }) {
  // NOTE CONTENT
  const noteContent = document.createElement("div");
  noteContent.classList.add("note-content");

  const note = document.createElement("div");
  note.classList.add("draggable", "note");
  note.setAttribute("draggable", window.innerWidth > 1000);
  note.setAttribute("display-index", displayIndex ?? 0);
  note.setAttribute("key", noteIndex);
  note.setAttribute("data-favorited", favorited ? "true" : "false");
  note.setAttribute("data-archived", archived ? "true" : "false");

  // Apply note color (use saved color or default)
  const currentColor = noteColor || DEFAULT_NOTE_COLOR;
  note.style.backgroundColor = currentColor;
  note.setAttribute("data-color", currentColor);

  // HEADER START
  const noteHeader = document.createElement("div");
  noteHeader.classList.add("note-header");

  // Generate note name - handle both numeric and string IDs
  const defaultName = noteName || `Note ${displayIndex + 1}`;
  let noteHeading = document.createElement("h3");
  noteHeading.textContent = defaultName;
  noteHeading.classList.add("note-title");

  // Add placeholder indicator badge if note contains {{placeholders}}
  const hasPlaceholders = /\{\{[^}]+\}\}/.test(noteText);
  if (hasPlaceholders) {
    const placeholderBadge = document.createElement("span");
    placeholderBadge.classList.add("placeholder-badge");
    placeholderBadge.textContent = "{ }";
    placeholderBadge.title = "Contains placeholders";
    noteHeading.appendChild(placeholderBadge);
  }

  const editBtn = document.createElement("div");
  editBtn.classList.add("edit");
  editBtn.appendChild(createIcon('pencil', 20));

  const discardBtn = document.createElement("div");
  discardBtn.classList.add("discard");
  discardBtn.appendChild(createIcon('x', 20));

  const acceptBtn = document.createElement("div");
  acceptBtn.classList.add("accept");
  acceptBtn.appendChild(createIcon('check', 20));

  const dateElem = document.createElement("p");
  dateElem.textContent = date;
  dateElem.classList.add("note-date");

  let noteTextDiv = document.createElement("div");
  // Process text to highlight placeholders and code blocks
  noteTextDiv.innerHTML = highlightPlaceholders(noteText);
  noteTextDiv.dataset.rawText = noteText; // Store raw text for editing
  noteTextDiv.classList.add("note-text");

  // Favorite button (top right corner)
  const favoriteBtn = document.createElement("div");
  favoriteBtn.classList.add("favorite-btn");
  favoriteBtn.title = favorited ? "Remove from favorites" : "Add to favorites";
  favoriteBtn.appendChild(createStarIcon(favorited, 18));
  if (favorited) favoriteBtn.classList.add("active");

  const copyBtn = document.createElement("button");
  copyBtn.classList.add("copy-btn");
  copyBtn.title = "Copy note";
  copyBtn.appendChild(createIcon('copy', 18));

  const actionContainer = document.createElement("div");

  // Archive button (replaces delete in main actions)
  const archiveBtn = document.createElement("div");
  archiveBtn.classList.add("archive-btn");
  archiveBtn.title = archived ? "Unarchive note" : "Archive note";
  const archiveIcon = createIcon('archive', 18);
  if (archived && archiveIcon) archiveIcon.setAttribute('fill', 'currentColor');
  archiveBtn.appendChild(archiveIcon);

  // Delete button (bottom right, with confirmation)
  const deleteBtn = document.createElement("div");
  deleteBtn.classList.add("delete-btn");
  deleteBtn.title = "Delete note permanently";
  deleteBtn.appendChild(createIcon('trash-2', 18));

  // Color swatch trigger (shows current color, click to expand)
  const colorSwatchTrigger = document.createElement("div");
  colorSwatchTrigger.classList.add("color-swatch-trigger");
  colorSwatchTrigger.style.backgroundColor = currentColor;
  colorSwatchTrigger.title = "Change color";

  // Color picker popup
  const colorPickerPopup = document.createElement("div");
  colorPickerPopup.classList.add("color-picker-popup");
  NOTE_COLORS.forEach(({ value }) => {
    const swatch = document.createElement("div");
    swatch.className = "color-swatch";
    swatch.style.backgroundColor = value;
    if (value === currentColor) swatch.classList.add("active");
    swatch.addEventListener("click", (e) => {
      e.stopPropagation();
      // Update note color
      note.style.backgroundColor = value;
      note.setAttribute("data-color", value);
      colorSwatchTrigger.style.backgroundColor = value;
      // Update active state
      colorPickerPopup.querySelectorAll(".color-swatch").forEach(s => s.classList.remove("active"));
      swatch.classList.add("active");
      // Save to storage
      chrome.storage.local.get("notes", (data) => {
        const savedNotes = data.notes || {};
        if (savedNotes[noteIndex]) {
          savedNotes[noteIndex].noteColor = value;
          // Reset tagViewPosition so note appears at end of new color group
          delete savedNotes[noteIndex].tagViewPosition;
          chrome.storage.local.set({ notes: savedNotes }, () => {
            // Auto-refresh tags view if we're on it
            if (notes.classList.contains('tags-view')) {
              showNotesByView('tags');
            }
          });
        }
      });
      // Close popup
      colorPickerPopup.classList.remove("open");
    });
    colorPickerPopup.appendChild(swatch);
  });

  // Toggle color picker on trigger click
  colorSwatchTrigger.addEventListener("click", (e) => {
    e.stopPropagation();
    // Close any other open color pickers
    document.querySelectorAll(".color-picker-popup.open").forEach(p => {
      if (p !== colorPickerPopup) p.classList.remove("open");
    });
    colorPickerPopup.classList.toggle("open");
  });

  // Close color picker when clicking elsewhere
  document.addEventListener("click", () => {
    colorPickerPopup.classList.remove("open");
  });

  actionContainer.classList.add("note-actions");

  // DRAG HANDLE
  const dragHandle = document.createElement("div");
  dragHandle.appendChild(createIcon('grip-horizontal', 20));
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
  let originalText = noteTextDiv.dataset.rawText || noteTextDiv.textContent;

  const handleKeydown = (e) => {
    if (e.key === "Escape") {
      discardBtn.click();
    }
    // Only save on Enter if in the title input, not the textarea
    if (e.key === "Enter" && e.target.tagName === "INPUT") {
      acceptBtn.click();
    }
  };

  // Track current editing color
  let editingColor = currentColor;

  // Function to close editing mode
  const closeEditMode = () => {
    if (!note.classList.contains("editing")) return;

    const newHeading = document.createElement("h3");
    newHeading.textContent = originalTitle;
    newHeading.classList.add("note-title");

    const newTextDiv = document.createElement("div");
    newTextDiv.innerHTML = highlightPlaceholders(originalText);
    newTextDiv.dataset.rawText = originalText;
    newTextDiv.classList.add("note-text");

    noteHeading.replaceWith(newHeading);
    noteTextDiv.replaceWith(newTextDiv);

    noteHeading = newHeading;
    noteTextDiv = newTextDiv;

    // Restore original color
    note.style.backgroundColor = editingColor;

    actionContainer.classList.remove("note-background");
    note.classList.remove("editing");
    note.draggable = true;

    editBtn.style.display = "flex";
    acceptBtn.style.display = "none";
    discardBtn.style.display = "none";

    // Remove placeholder and code block buttons
    const placeholderBtn = note.querySelector(".insert-placeholder-btn");
    if (placeholderBtn) placeholderBtn.remove();
    const codeBtn = note.querySelector(".insert-code-btn");
    if (codeBtn) codeBtn.remove();

    document.removeEventListener("keydown", handleKeydown);
    currentlyEditingNote = null;
  };

  // Edit button
  editBtn.addEventListener("click", () => {
    // Close any other note being edited
    if (currentlyEditingNote && currentlyEditingNote !== note) {
      const otherDiscard = currentlyEditingNote.querySelector(".discard");
      if (otherDiscard) otherDiscard.click();
    }

    currentlyEditingNote = note;
    editBtn.style.display = "none";
    acceptBtn.style.display = "flex";
    discardBtn.style.display = "flex";

    // Add editing class for expanded view
    note.classList.add("editing");

    const input1 = document.createElement("input");
    input1.type = "text";
    input1.value = noteHeading.textContent;
    input1.maxLength = 100;
    input1.classList.add("note-title");
    noteHeading.replaceWith(input1);

    const input2 = document.createElement("textarea");
    input2.name = "post";
    input2.maxLength = "5000";
    // Use raw text (with markdown) for editing, fallback to textContent
    input2.value = noteTextDiv.dataset.rawText || noteTextDiv.textContent;
    input2.classList.add("note-text", "note-text-edit");
    noteTextDiv.replaceWith(input2);

    actionContainer.classList.add("note-background");
    note.draggable = false;

    const autoResize = () => (input2.style.height = `${input2.scrollHeight}px`);
    input2.addEventListener("input", autoResize);
    autoResize();

    // Add Insert Code Block button
    const insertCodeBtn = document.createElement("button");
    insertCodeBtn.className = "insert-code-btn";
    insertCodeBtn.appendChild(createIcon('code', 16));
    insertCodeBtn.title = "Insert code block";
    insertCodeBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const start = input2.selectionStart;
      const end = input2.selectionEnd;
      const text = input2.value;
      const before = text.substring(0, start);
      const after = text.substring(end);
      const selectedText = text.substring(start, end);
      // Insert code block with newlines around it
      const codeBlock = "\n```\n" + (selectedText || "") + "\n```\n";
      input2.value = before + codeBlock + after;
      // Position cursor inside the code block
      const cursorPos = start + 5 + (selectedText ? selectedText.length : 0);
      input2.selectionStart = input2.selectionEnd = cursorPos;
      input2.focus();
      autoResize();
    });
    acceptBtn.parentElement.insertBefore(insertCodeBtn, acceptBtn);

    // Add Insert Placeholder button (styled via CSS class)
    const insertPlaceholderBtn = document.createElement("button");
    insertPlaceholderBtn.className = "insert-placeholder-btn";
    insertPlaceholderBtn.textContent = "{{}}";
    insertPlaceholderBtn.title = "Insert placeholder";
    insertPlaceholderBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const start = input2.selectionStart;
      const end = input2.selectionEnd;
      const text = input2.value;
      const before = text.substring(0, start);
      const after = text.substring(end);
      // Use selected text as placeholder name if available, otherwise default to "placeholder"
      const selectedText = text.substring(start, end).trim();
      const placeholderName = selectedText || "placeholder";
      const placeholder = `{{${placeholderName}}}`;
      input2.value = before + placeholder + after;
      input2.selectionStart = input2.selectionEnd = start + placeholder.length;
      input2.focus();
      autoResize();
    });
    acceptBtn.parentElement.insertBefore(insertPlaceholderBtn, insertCodeBtn);

    // Add Tone Rewriter button and popup (only if AI is configured)
    chrome.storage.local.get("settings", (data) => {
      const settings = data.settings || {};
      if (!settings.key) return; // No AI key configured

      const toneContainer = document.createElement("div");
      toneContainer.className = "tone-picker-container";

      const toneTrigger = document.createElement("button");
      toneTrigger.className = "tone-trigger-btn";
      toneTrigger.appendChild(createIcon('type', 16));
      toneTrigger.title = "Rewrite in different tone (AI)";

      const tonePopup = document.createElement("div");
      tonePopup.className = "tone-picker-popup";

      TONE_OPTIONS.forEach(({ name, icon }) => {
        const toneBtn = document.createElement("button");
        toneBtn.className = "tone-option";
        toneBtn.innerHTML = `<span class="tone-icon">${icon}</span><span class="tone-name">${name}</span>`;
        toneBtn.title = name;
        toneBtn.addEventListener("click", async (e) => {
          e.preventDefault();
          e.stopPropagation();

          const currentText = input2.value;
          if (!currentText.trim()) return;

          // Show loading state
          toneBtn.classList.add("loading");
          toneTrigger.classList.add("loading");

          try {
            const rewritten = await rewriteInTone(
              currentText,
              name,
              settings.aiProvider || "groq",
              settings.aiModel || "llama-3.1-8b-instant",
              settings.key,
              settings.customBaseUrl || ""
            );
            input2.value = rewritten;
            autoResize();
          } catch (error) {
            console.error("Tone rewrite failed:", error);
            showToast("Tone Rewrite Failed", error.message, "error");
          } finally {
            toneBtn.classList.remove("loading");
            toneTrigger.classList.remove("loading");
            tonePopup.classList.remove("open");
          }
        });
        tonePopup.appendChild(toneBtn);
      });

      toneTrigger.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Close other popups
        document.querySelectorAll(".tone-picker-popup.open").forEach(p => p.classList.remove("open"));
        tonePopup.classList.toggle("open");
      });

      // Close popup when clicking elsewhere
      const closeTonePopup = (e) => {
        if (!toneContainer.contains(e.target)) {
          tonePopup.classList.remove("open");
        }
      };
      document.addEventListener("click", closeTonePopup);

      toneContainer.appendChild(toneTrigger);
      toneContainer.appendChild(tonePopup);
      acceptBtn.parentElement.insertBefore(toneContainer, insertPlaceholderBtn);
    });

    noteHeading = input1;
    noteTextDiv = input2;

    // Focus textarea and enable selection
    setTimeout(() => {
      input2.focus();
      input2.setSelectionRange(0, 0);
    }, 50);

    document.addEventListener("keydown", handleKeydown);
  });

  // Accept button
  acceptBtn.addEventListener("click", () => {
    originalTitle = noteHeading.value.slice(0, 100);
    originalText = noteTextDiv.value;

    const newHeading = document.createElement("h3");
    newHeading.textContent = originalTitle;
    newHeading.classList.add("note-title");

    const newTextDiv = document.createElement("div");
    newTextDiv.innerHTML = highlightPlaceholders(originalText);
    newTextDiv.dataset.rawText = originalText;
    newTextDiv.classList.add("note-text");

    noteHeading.replaceWith(newHeading);
    noteTextDiv.replaceWith(newTextDiv);
    noteHeading = newHeading;
    noteTextDiv = newTextDiv;

    // Get current color from note
    editingColor = note.getAttribute("data-color");

    // Update storage
    chrome.storage.local.get("notes", (data) => {
      const savedNotes = data.notes || {};
      const newDate = getDate();
      dateElem.textContent = newDate;
      const existingNote = savedNotes[noteIndex] || {};
      savedNotes[noteIndex] = {
        ...existingNote,
        noteText: originalText,
        date: newDate,
        noteIndex,
        displayIndex,
        noteName: originalTitle,
        noteColor: editingColor,
      };

      chrome.storage.local.set({ notes: savedNotes }, () => {
        if (chrome.runtime.lastError) {
          console.error("Storage error:", chrome.runtime.lastError);
          alert("Failed to save note. Chrome error.");
          return;
        }
        updateStats();
      });
    });

    actionContainer.classList.remove("note-background");
    note.classList.remove("editing");
    note.draggable = true;

    editBtn.style.display = "flex";
    acceptBtn.style.display = "none";
    discardBtn.style.display = "none";

    // Remove placeholder, code block, and tone buttons
    const placeholderBtn = note.querySelector(".insert-placeholder-btn");
    if (placeholderBtn) placeholderBtn.remove();
    const codeBtn = note.querySelector(".insert-code-btn");
    if (codeBtn) codeBtn.remove();
    const toneContainer = note.querySelector(".tone-picker-container");
    if (toneContainer) toneContainer.remove();

    document.removeEventListener("keydown", handleKeydown);
    currentlyEditingNote = null;
  });

  // Discard button
  discardBtn.addEventListener("click", () => {
    const newHeading = document.createElement("h3");
    newHeading.textContent = originalTitle;
    newHeading.classList.add("note-title");

    const newTextDiv = document.createElement("div");
    newTextDiv.innerHTML = highlightPlaceholders(originalText);
    newTextDiv.dataset.rawText = originalText;
    newTextDiv.classList.add("note-text");

    noteHeading.replaceWith(newHeading);
    noteTextDiv.replaceWith(newTextDiv);

    noteHeading = newHeading;
    noteTextDiv = newTextDiv;

    // Restore original color from data attribute
    const savedColor = note.getAttribute("data-color") || currentColor;
    note.style.backgroundColor = savedColor;
    editingColor = savedColor;

    actionContainer.classList.remove("note-background");
    note.classList.remove("editing");
    note.draggable = true;

    editBtn.style.display = "flex";
    acceptBtn.style.display = "none";
    discardBtn.style.display = "none";

    // Remove placeholder, code block, and tone buttons
    const placeholderBtn = note.querySelector(".insert-placeholder-btn");
    if (placeholderBtn) placeholderBtn.remove();
    const codeBtn = note.querySelector(".insert-code-btn");
    if (codeBtn) codeBtn.remove();
    const toneContainer = note.querySelector(".tone-picker-container");
    if (toneContainer) toneContainer.remove();

    document.removeEventListener("keydown", handleKeydown);
    currentlyEditingNote = null;
  });

  // Favorite button
  favoriteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isFavorited = note.getAttribute("data-favorited") === "true";
    const newFavorited = !isFavorited;

    note.setAttribute("data-favorited", newFavorited ? "true" : "false");
    favoriteBtn.classList.toggle("active", newFavorited);
    favoriteBtn.innerHTML = '';
    favoriteBtn.appendChild(createStarIcon(newFavorited, 18));
    favoriteBtn.title = newFavorited ? "Remove from favorites" : "Add to favorites";

    // Save to storage
    chrome.storage.local.get("notes", (data) => {
      const savedNotes = data.notes || {};
      if (savedNotes[noteIndex]) {
        savedNotes[noteIndex].favorited = newFavorited;
        chrome.storage.local.set({ notes: savedNotes });
      }
    });
  });

  // Archive button
  archiveBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isArchived = note.getAttribute("data-archived") === "true";
    const newArchived = !isArchived;

    note.setAttribute("data-archived", newArchived ? "true" : "false");
    archiveBtn.title = newArchived ? "Unarchive note" : "Archive note";
    // Update icon - show filled when archived
    archiveBtn.innerHTML = '';
    const newArchiveIcon = createIcon('archive', 18);
    if (newArchived && newArchiveIcon.tagName === 'svg') {
      newArchiveIcon.setAttribute('fill', 'currentColor');
    }
    archiveBtn.appendChild(newArchiveIcon);

    // Save to storage
    chrome.storage.local.get("notes", (data) => {
      const savedNotes = data.notes || {};
      if (savedNotes[noteIndex]) {
        savedNotes[noteIndex].archived = newArchived;
        chrome.storage.local.set({ notes: savedNotes }, () => {
          // If on main view and note is archived, hide it
          if (currentView === 'all' && newArchived) {
            note.style.display = 'none';
          } else if (currentView === 'archive' && !newArchived) {
            note.style.display = 'none';
          }
          updateStats();
        });
      }
    });

    const audio = new Audio("./public/audio/swish.mp3");
    audio.play();
  });

  // Delete button with confirmation
  deleteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (confirm("Are you sure you want to permanently delete this note? This cannot be undone.")) {
      note.remove();
      deleteLocalNote(noteIndex);
    }
  });

  // Copy button - No visual feedback, just copy
  copyBtn.addEventListener("click", () => {
    // Always get the current text from the note's text element
    const currentTextElement = note.querySelector(".note-text");
    const currentText = currentTextElement ? currentTextElement.textContent : "";

    navigator.clipboard
      .writeText(currentText)
      .catch((err) => console.error("Failed to copy text: ", err));
  });

  // Append elements
  noteHeader.appendChild(noteHeading);

  // Action buttons container (right side of header) - includes favorite, copy, edit
  const headerActions = document.createElement("div");
  headerActions.classList.add("header-actions");
  headerActions.appendChild(favoriteBtn);
  headerActions.appendChild(copyBtn);
  headerActions.appendChild(editBtn);
  headerActions.appendChild(acceptBtn);
  headerActions.appendChild(discardBtn);
  noteHeader.appendChild(headerActions);

  // Bottom action bar
  const actionsLeft = document.createElement("div");
  actionsLeft.classList.add("actions-left");
  actionsLeft.appendChild(colorSwatchTrigger);
  actionsLeft.appendChild(colorPickerPopup);

  const actionsRight = document.createElement("div");
  actionsRight.classList.add("actions-right");
  actionsRight.appendChild(dateElem);
  actionsRight.appendChild(archiveBtn);
  actionsRight.appendChild(deleteBtn);

  actionContainer.appendChild(actionsLeft);
  actionContainer.appendChild(actionsRight);

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

// Sort by date (newest first)
function sortNotesByDate() {
  chrome.storage.local.get("notes", (data) => {
    const savedNotes = data.notes || {};
    const isTagsView = notes.classList.contains('tags-view');

    if (isTagsView) {
      // Sort within each color group
      const colorGroups = document.querySelectorAll('.color-group-notes');
      colorGroups.forEach(group => {
        const groupNotes = Array.from(group.querySelectorAll('.note'));
        groupNotes.sort((a, b) => {
          const keyA = a.getAttribute("key");
          const keyB = b.getAttribute("key");
          const timestampA = savedNotes[keyA]?.timestamp || savedNotes[keyA]?.noteIndex || 0;
          const timestampB = savedNotes[keyB]?.timestamp || savedNotes[keyB]?.noteIndex || 0;
          return timestampB - timestampA;
        });
        groupNotes.forEach(elem => group.appendChild(elem));
      });
    } else {
      const noteElements = Array.from(notes.children);
      noteElements.sort((a, b) => {
        const keyA = a.getAttribute("key");
        const keyB = b.getAttribute("key");
        const timestampA = savedNotes[keyA]?.timestamp || savedNotes[keyA]?.noteIndex || 0;
        const timestampB = savedNotes[keyB]?.timestamp || savedNotes[keyB]?.noteIndex || 0;
        return timestampB - timestampA;
      });
      notes.innerHTML = "";
      noteElements.forEach((elem) => notes.appendChild(elem));
      updateDisplayIndices();
    }
  });
}

// Sort by title
function sortNotesByTitle() {
  chrome.storage.local.get("notes", (data) => {
    const savedNotes = data.notes || {};
    const isTagsView = notes.classList.contains('tags-view');

    if (isTagsView) {
      // Sort within each color group
      const colorGroups = document.querySelectorAll('.color-group-notes');
      colorGroups.forEach(group => {
        const groupNotes = Array.from(group.querySelectorAll('.note'));
        groupNotes.sort((a, b) => {
          const keyA = a.getAttribute("key");
          const keyB = b.getAttribute("key");
          const titleA = (savedNotes[keyA]?.noteName || "").toLowerCase();
          const titleB = (savedNotes[keyB]?.noteName || "").toLowerCase();
          return titleA.localeCompare(titleB);
        });
        groupNotes.forEach(elem => group.appendChild(elem));
      });
    } else {
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
    }
  });
}

// Clear all notes
function clearAllNotes() {
  if (
    confirm("Are you sure you want to delete all notes? This cannot be undone.")
  ) {
    chrome.storage.local.set({ notes: {}, noteCounter: 0 }, () => {
      if (chrome.runtime.lastError) {
        console.error("Storage error:", chrome.runtime.lastError);
        alert("Failed to save note. Chrome error.");
        return;
      }
      notes.innerHTML = "";
      updateStats();
      checkNoteMessage({});
      // Reinitialize all Lucide icons to ensure they render correctly
      if (window.lucide) {
        lucide.createIcons();
      }
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
      if (chrome.runtime.lastError) {
        console.error("Storage error:", chrome.runtime.lastError);
        alert("Failed to save note. Chrome error.");
        return;
      }
      console.log("Display indices updated");
    });
  });
}

// Search and filter functionality
function initSearchAndFilter() {
  // Track which filters are active (both can be selected)
  let activeFilters = { name: false, content: false };
  let currentSort = null;

  // Helper to get current filter type
  const getFilterType = () => {
    if (activeFilters.name && activeFilters.content) return "both";
    if (activeFilters.name) return "name";
    if (activeFilters.content) return "content";
    return "both"; // Default when none selected
  };

  // Search functionality
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      const query = e.target.value.toLowerCase().trim();
      filterNotes(query, getFilterType());
    });
  }

  // Filter buttons (name/content) - both can be active simultaneously
  filterButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const clickedFilter = btn.getAttribute("data-filter");

      // Toggle the clicked filter
      btn.classList.toggle("active");
      activeFilters[clickedFilter] = btn.classList.contains("active");

      const query = searchInput?.value.toLowerCase().trim() || "";
      filterNotes(query, getFilterType());
    });
  });

  // Sort buttons (recent/oldest/title) - click again to deselect
  sortButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const clickedSort = btn.getAttribute("data-sort");

      // If clicking the already active sort, deselect it (go to default order)
      if (btn.classList.contains("active")) {
        btn.classList.remove("active");
        currentSort = null;
        // Reset to default display order
        resetToDefaultOrder();
      } else {
        // Remove active class from all sort buttons
        sortButtons.forEach((b) => b.classList.remove("active"));
        // Add active class to clicked button
        btn.classList.add("active");
        currentSort = clickedSort;

        if (clickedSort === "recent") {
          sortNotesByDate();
        } else if (clickedSort === "oldest") {
          sortNotesByDateOldest();
        } else if (clickedSort === "title") {
          sortNotesByTitle();
        }
      }
    });
  });

  // No initial active state - all filters/sorts start deselected
}

// Reset notes to default display order
function resetToDefaultOrder() {
  chrome.storage.local.get("notes", (data) => {
    const savedNotes = data.notes || {};
    const noteElements = Array.from(notes.children);

    noteElements.sort((a, b) => {
      const keyA = a.getAttribute("key");
      const keyB = b.getAttribute("key");
      const displayIndexA = savedNotes[keyA]?.displayIndex ?? 0;
      const displayIndexB = savedNotes[keyB]?.displayIndex ?? 0;
      return displayIndexA - displayIndexB;
    });

    notes.innerHTML = "";
    noteElements.forEach((elem) => notes.appendChild(elem));
  });
}

function filterNotes(searchQuery, filterType) {
  chrome.storage.local.get("notes", (data) => {
    const savedNotes = data.notes || {};

    // Check if we're in tags view
    const isTagsView = notes.classList.contains('tags-view');

    if (isTagsView) {
      // Filter within each color group
      const colorGroups = document.querySelectorAll('.color-group');
      colorGroups.forEach(group => {
        const groupNotes = group.querySelectorAll('.note');
        let visibleCount = 0;

        groupNotes.forEach(elem => {
          const key = elem.getAttribute("key");
          const note = savedNotes[key];

          if (!note) {
            elem.style.display = "none";
            return;
          }

          const title = (note.noteName || "").toLowerCase();
          const content = (note.noteText || "").toLowerCase();
          let matchesSearch = false;

          if (!searchQuery) {
            matchesSearch = true;
          } else if (filterType === "name") {
            matchesSearch = title.includes(searchQuery);
          } else if (filterType === "content") {
            matchesSearch = content.includes(searchQuery);
          } else if (filterType === "both") {
            matchesSearch = title.includes(searchQuery) || content.includes(searchQuery);
          }

          elem.style.display = matchesSearch ? "flex" : "none";
          if (matchesSearch) visibleCount++;
        });

        // Hide entire group if no notes match
        group.style.display = visibleCount > 0 ? "flex" : "none";

        // Update count in header
        const countSpan = group.querySelector('.color-count');
        if (countSpan && searchQuery) {
          countSpan.textContent = `(${visibleCount})`;
        }
      });
    } else {
      // Standard filtering for non-tags views - use querySelectorAll to ensure we only get note elements
      const noteElements = Array.from(notes.querySelectorAll('.note'));

      noteElements.forEach((elem) => {
        const key = elem.getAttribute("key");
        const note = savedNotes[key];

        if (!note) {
          elem.style.display = "none";
          return;
        }

        const title = (note.noteName || "").toLowerCase();
        const content = (note.noteText || "").toLowerCase();

        let matchesSearch = false;

        if (!searchQuery) {
          matchesSearch = true;
        } else if (filterType === "name") {
          matchesSearch = title.includes(searchQuery);
        } else if (filterType === "content") {
          matchesSearch = content.includes(searchQuery);
        } else {
          // Default to searching both name and content
          matchesSearch = title.includes(searchQuery) || content.includes(searchQuery);
        }

        elem.style.display = matchesSearch ? "flex" : "none";
      });
    }
  });
}

// Sort by date (oldest first)
function sortNotesByDateOldest() {
  chrome.storage.local.get("notes", (data) => {
    const savedNotes = data.notes || {};
    const isTagsView = notes.classList.contains('tags-view');

    if (isTagsView) {
      // Sort within each color group
      const colorGroups = document.querySelectorAll('.color-group-notes');
      colorGroups.forEach(group => {
        const groupNotes = Array.from(group.querySelectorAll('.note'));
        groupNotes.sort((a, b) => {
          const keyA = a.getAttribute("key");
          const keyB = b.getAttribute("key");
          const timestampA = savedNotes[keyA]?.timestamp || savedNotes[keyA]?.noteIndex || 0;
          const timestampB = savedNotes[keyB]?.timestamp || savedNotes[keyB]?.noteIndex || 0;
          return timestampA - timestampB;
        });
        groupNotes.forEach(elem => group.appendChild(elem));
      });
    } else {
      const noteElements = Array.from(notes.children);
      noteElements.sort((a, b) => {
        const keyA = a.getAttribute("key");
        const keyB = b.getAttribute("key");
        const timestampA = savedNotes[keyA]?.timestamp || savedNotes[keyA]?.noteIndex || 0;
        const timestampB = savedNotes[keyB]?.timestamp || savedNotes[keyB]?.noteIndex || 0;
        return timestampA - timestampB;
      });
      notes.innerHTML = "";
      noteElements.forEach((elem) => notes.appendChild(elem));
      updateDisplayIndices();
    }
  });
}

// Global keyboard shortcuts
document.addEventListener("keydown", async (event) => {
  // "/" to directly create note from clipboard (preserves line breaks)
  if (event.key === "/" && document.activeElement !== input && document.activeElement !== searchInput) {
    event.preventDefault();
    try {
      const clipboardText = await navigator.clipboard.readText();
      if (clipboardText && clipboardText.trim()) {
        makeNote(clipboardText);
      }
    } catch (error) {
      console.error("Failed to read clipboard: ", error);
    }
  }
});

// AI Note Naming functionality
function initAIConfiguration() {
  // API key info for each provider
  const providerInfo = {
    none: {
      url: "",
      text: "AI features disabled - no API key required",
      free: true,
    },
    groq: {
      url: "https://console.groq.com/keys",
      text: "Get free API key at console.groq.com",
      free: true,
    },
    gemini: {
      url: "https://aistudio.google.com/apikey",
      text: "Get free API key at aistudio.google.com",
      free: true,
    },
    openai: {
      url: "https://platform.openai.com/api-keys",
      text: "Get API key at platform.openai.com (paid)",
      free: false,
    },
    anthropic: {
      url: "https://console.anthropic.com/settings/keys",
      text: "Get API key at console.anthropic.com (paid)",
      free: false,
    },
    custom: {
      url: "",
      text: "Enter your OpenAI-compatible API key",
      free: false,
    },
  };

  // Model options for each provider - Affordable options listed first
  const modelOptions = {
    openai: [
      { value: "gpt-4.1-nano", label: "GPT-4.1 Nano (Cheapest)" },
      { value: "gpt-4.1-mini", label: "GPT-4.1 Mini (Affordable)" },
      { value: "gpt-5-mini", label: "GPT-5 Mini (Recommended)" },
      { value: "gpt-5.1-nano", label: "GPT-5.1 Nano" },
      { value: "gpt-5.2-nano", label: "GPT-5.2 Nano" },
      { value: "gpt-4o-mini", label: "GPT-4o Mini" },
      { value: "gpt-4o", label: "GPT-4o" },
    ],
    anthropic: [
      { value: "claude-3-5-haiku-latest", label: "Claude 3.5 Haiku (Recommended - Fast & Affordable)" },
      { value: "claude-3-5-sonnet-latest", label: "Claude 3.5 Sonnet" },
      { value: "claude-3-haiku-20240307", label: "Claude 3 Haiku (Cheapest)" },
      { value: "claude-3-opus-latest", label: "Claude 3 Opus (Most Capable)" },
    ],
    gemini: [
      { value: "gemini-1.5-flash", label: "Gemini 1.5 Flash (Recommended - Fast & Cheap)" },
      { value: "gemini-1.5-flash-8b", label: "Gemini 1.5 Flash 8B (Cheapest)" },
      { value: "gemini-1.5-pro", label: "Gemini 1.5 Pro" },
      { value: "gemini-2.0-flash-exp", label: "Gemini 2.0 Flash (Experimental)" },
    ],
    groq: [
      { value: "llama-3.1-8b-instant", label: "Llama 3.1 8B (Recommended - Free & Fast)" },
      { value: "llama-3.3-70b-versatile", label: "Llama 3.3 70B (Free)" },
      { value: "mixtral-8x7b-32768", label: "Mixtral 8x7B (Free)" },
      { value: "gemma2-9b-it", label: "Gemma 2 9B (Free)" },
    ],
  };

  // Update models when provider changes
  function updateModels(provider) {
    const models = modelOptions[provider] || modelOptions.groq;
    aiModelSelect.innerHTML = models
      .map((m) => `<option value="${m.value}">${m.label}</option>`)
      .join("");
  }

  // Update API key help text and toggle fields visibility
  function updateKeyHelp(provider) {
    const helpEl = document.getElementById("ai-key-help");
    const keyField = aiApiKeyInput?.closest(".ai-form-field");
    const modelField = document.getElementById("ai-model-select-field");
    const baseUrlField = document.getElementById("ai-base-url-field");
    const customModelField = document.getElementById("ai-custom-model-field");

    if (!helpEl) return;
    const info = providerInfo[provider] || providerInfo.groq;

    if (provider === "none") {
      helpEl.textContent = info.text;
      if (keyField) keyField.style.display = "none";
      if (modelField) modelField.style.display = "none";
      if (baseUrlField) baseUrlField.style.display = "none";
      if (customModelField) customModelField.style.display = "none";
    } else if (provider === "custom") {
      helpEl.textContent = info.text;
      if (keyField) keyField.style.display = "";
      if (modelField) modelField.style.display = "none";
      if (baseUrlField) baseUrlField.style.display = "";
      if (customModelField) customModelField.style.display = "";
    } else {
      helpEl.innerHTML = `<a href="${info.url}" target="_blank" rel="noopener">${info.text}</a>`;
      if (keyField) keyField.style.display = "";
      if (modelField) modelField.style.display = "";
      if (baseUrlField) baseUrlField.style.display = "none";
      if (customModelField) customModelField.style.display = "none";
    }
  }

  // Open modal
  if (openAIModalBtn) {
    openAIModalBtn.addEventListener("click", () => {
      // Load current settings
      chrome.storage.local.get("settings", (data) => {
        const settings = data.settings || {};
        const savedProvider = settings.aiProvider || "groq";
        const savedModel = settings.aiModel;

        aiProviderSelect.value = savedProvider;
        updateModels(savedProvider);
        updateKeyHelp(savedProvider);

        if (savedModel) {
          aiModelSelect.value = savedModel;
        }

        if (settings.key) {
          aiApiKeyInput.value = settings.key;
        }

        // Load custom provider settings
        const baseUrlInput = document.getElementById("ai-base-url-input");
        const customModelInput = document.getElementById("ai-custom-model-input");
        if (baseUrlInput && settings.customBaseUrl) {
          baseUrlInput.value = settings.customBaseUrl;
        }
        if (customModelInput && settings.customModel) {
          customModelInput.value = settings.customModel;
        }
      });

      aiModal.classList.add("active");
      aiProviderSelect.focus();
    });
  }

  // Close modal function
  function closeModal() {
    aiModal.classList.remove("active");
    aiApiKeyInput.value = "";
  }

  // Close modal button
  if (closeAIModalBtn) {
    closeAIModalBtn.addEventListener("click", closeModal);
  }

  // Close modal when clicking overlay
  if (aiModalOverlay) {
    aiModalOverlay.addEventListener("click", closeModal);
  }

  // Provider change handler
  if (aiProviderSelect) {
    aiProviderSelect.addEventListener("change", () => {
      const provider = aiProviderSelect.value;
      updateModels(provider);
      updateKeyHelp(provider);
    });
  }

  // Save configuration
  if (aiSaveBtn) {
    aiSaveBtn.addEventListener("click", () => {
      const provider = aiProviderSelect.value;
      const model = aiModelSelect.value;
      const apiKey = aiApiKeyInput.value.trim();
      const baseUrlInput = document.getElementById("ai-base-url-input");
      const customModelInput = document.getElementById("ai-custom-model-input");
      const customBaseUrl = baseUrlInput ? baseUrlInput.value.trim() : "";
      const customModel = customModelInput ? customModelInput.value.trim() : "";

      // Require API key only if provider is not "none"
      if (provider !== "none" && !apiKey) {
        aiApiKeyInput.style.borderColor = "#ff6b6b";
        setTimeout(() => {
          aiApiKeyInput.style.borderColor = "";
        }, 500);
        return;
      }

      // Require base URL and model for custom provider
      if (provider === "custom" && !customBaseUrl) {
        if (baseUrlInput) {
          baseUrlInput.style.borderColor = "#ff6b6b";
          setTimeout(() => { baseUrlInput.style.borderColor = ""; }, 500);
        }
        return;
      }

      if (provider === "custom" && !customModel) {
        if (customModelInput) {
          customModelInput.style.borderColor = "#ff6b6b";
          setTimeout(() => { customModelInput.style.borderColor = ""; }, 500);
        }
        return;
      }

      chrome.storage.local.get("settings", (data) => {
        const updatedSettings = {
          ...(data.settings || {}),
          key: provider === "none" ? "" : apiKey,
          aiProvider: provider,
          aiModel: provider === "none" ? "" : (provider === "custom" ? customModel : model),
          customBaseUrl: provider === "custom" ? customBaseUrl : (data.settings?.customBaseUrl || ""),
          customModel: provider === "custom" ? customModel : (data.settings?.customModel || ""),
        };

        chrome.storage.local.set({ settings: updatedSettings }, () => {
          // Show success feedback
          const originalText = aiSaveBtn.textContent;
          aiSaveBtn.textContent = "✓ Saved!";
          aiSaveBtn.style.background = "#10b981";

          setTimeout(() => {
            aiSaveBtn.textContent = originalText;
            aiSaveBtn.style.background = "";
            closeModal();
          }, 1000);

          console.log(`Saved ${provider} configuration${provider !== "none" ? ` with model ${model}` : " (disabled)"}`);
        });
      });
    });
  }

  // Cancel button
  if (aiCancelBtn) {
    aiCancelBtn.addEventListener("click", closeModal);
  }

  // Close modal on Escape key
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && aiModal.classList.contains("active")) {
      closeModal();
    }
  });
}

// Note size slider functionality
function initNoteSizeSlider() {
  const slider = document.getElementById("note-size-slider");
  const notesContainer = document.getElementById("notes");

  if (!slider || !notesContainer) return;

  // Apply note size from settings
  function applyNoteSize(size) {
    notesContainer.style.setProperty("--note-size", `${size}px`);
  }

  // Load saved size from settings
  chrome.storage.local.get("settings", (data) => {
    const settings = data.settings || {};
    const savedSize = settings.noteSize || 320;
    slider.value = Math.min(savedSize, 600); // Clamp to new max
    applyNoteSize(savedSize);
  });

  // Handle slider changes
  slider.addEventListener("input", (e) => {
    const size = parseInt(e.target.value, 10);
    applyNoteSize(size);
    // Sync settings page slider if it exists
    const pageSlider = document.getElementById("page-note-size");
    const pageValue = document.getElementById("page-note-size-value");
    if (pageSlider) pageSlider.value = size;
    if (pageValue) pageValue.textContent = size + "px";
  });

  // Save on change (when user releases slider)
  slider.addEventListener("change", (e) => {
    const size = parseInt(e.target.value, 10);

    chrome.storage.local.get("settings", (data) => {
      const settings = data.settings || {};
      settings.noteSize = size;

      chrome.storage.local.set({ settings }, () => {
        console.log(`Note size saved: ${size}px`);
      });
    });
  });
}

// Sidebar toggle functionality
function initSidebar() {
  const sidebar = document.getElementById("sidebar");
  const sidebarToggle = document.getElementById("sidebar-toggle");

  if (!sidebar || !sidebarToggle) return;

  // Load saved sidebar state
  chrome.storage.local.get("settings", (data) => {
    const settings = data.settings || {};
    if (settings.sidebarExpanded) {
      sidebar.classList.add("expanded");
    }
  });

  // Toggle sidebar on button click
  sidebarToggle.addEventListener("click", () => {
    sidebar.classList.toggle("expanded");

    // Save state
    chrome.storage.local.get("settings", (data) => {
      const settings = data.settings || {};
      settings.sidebarExpanded = sidebar.classList.contains("expanded");
      chrome.storage.local.set({ settings });
    });
  });

  // Sidebar item click handler with view switching
  const sidebarItems = document.querySelectorAll(".sidebar-item");
  sidebarItems.forEach((item) => {
    item.addEventListener("click", (e) => {
      e.preventDefault();
      // Remove active from all items
      sidebarItems.forEach((i) => i.classList.remove("active"));
      // Add active to clicked item
      item.classList.add("active");

      // Get view from title attribute
      const title = item.getAttribute("title")?.toLowerCase() || "";

      if (title.includes("all")) {
        currentView = 'all';
        showNotesByView('all');
      } else if (title.includes("favorites")) {
        currentView = 'favorites';
        showNotesByView('favorites');
      } else if (title.includes("archive")) {
        currentView = 'archive';
        showNotesByView('archive');
      } else if (title.includes("tags")) {
        currentView = 'tags';
        showNotesByView('tags');
      } else if (title.includes("settings")) {
        currentView = 'settings';
        showSettingsPage();
      }
    });
  });
}

// Show notes based on view
function showNotesByView(view) {
  // Hide settings page when showing notes
  const settingsPage = document.getElementById('settings-page');
  if (settingsPage) {
    settingsPage.style.display = 'none';
  }

  // Show the notes container and search bar
  const notesContainer = document.getElementById('notes');
  const searchFilterBar = document.getElementById('search-filter-bar');
  if (notesContainer) notesContainer.style.display = view === 'tags' ? 'flex' : 'grid';

  // Hide input-zone on tags page
  const inputZone = document.getElementById('input-zone');
  if (inputZone) {
    inputZone.style.display = view === 'tags' ? 'none' : 'flex';
  }

  // Get ALL note elements, including those inside color groups
  const noteElements = Array.from(document.querySelectorAll('#notes .note'));

  chrome.storage.local.get(["notes", "settings"], (data) => {
    const savedNotes = data.notes || {};
    const settings = data.settings || {};
    const customColorNames = settings.customColorNames || {};

    // First, extract all notes from color groups back to main container
    const colorGroups = document.querySelectorAll('.color-group');
    colorGroups.forEach(group => {
      const notesInGroup = group.querySelectorAll('.note');
      notesInGroup.forEach(note => notes.appendChild(note));
      group.remove();
    });

    // Remove tags-view class first
    notes.classList.remove('tags-view');

    // Re-query note elements after extraction
    const allNoteElements = Array.from(document.querySelectorAll('#notes .note'));

    if (view === 'tags') {
      // Always hide note-message on tags view
      noteMessage.style.display = "none";

      // Group notes by color - initialize all colors first
      const colorGroupsMap = {};

      // Initialize all colors from NOTE_COLORS so empty columns show
      NOTE_COLORS.forEach(colorObj => {
        colorGroupsMap[colorObj.value] = [];
      });

      allNoteElements.forEach((elem) => {
        const key = elem.getAttribute("key");
        const noteData = savedNotes[key];
        if (noteData && !noteData.archived) {
          const color = elem.getAttribute("data-color") || '#ffffff';
          if (!colorGroupsMap[color]) {
            colorGroupsMap[color] = [];
          }
          colorGroupsMap[color].push(elem);
        } else {
          // Hide archived notes in tags view
          elem.style.display = 'none';
        }
      });

      // Add tags-view class
      notes.classList.add('tags-view');

      // Create groups for each color (full width rows)
      Object.entries(colorGroupsMap).forEach(([color, elements]) => {
        const defaultColorName = NOTE_COLORS.find(c => c.value === color)?.name || 'custom';
        // Use custom name if set, otherwise use default
        const displayName = customColorNames[color] || defaultColorName;

        const groupContainer = document.createElement('div');
        groupContainer.className = 'color-group';

        const groupHeader = document.createElement('div');
        groupHeader.className = 'color-group-header';

        const colorDot = document.createElement('span');
        colorDot.className = 'color-dot';
        colorDot.style.backgroundColor = color;

        const colorNameSpan = document.createElement('span');
        colorNameSpan.className = 'color-name';
        colorNameSpan.textContent = displayName;
        colorNameSpan.style.cursor = 'pointer';
        colorNameSpan.title = 'Click to rename';

        // Make color name editable on click
        colorNameSpan.addEventListener('click', (e) => {
          e.stopPropagation();

          // Create input element
          const input = document.createElement('input');
          input.type = 'text';
          input.value = colorNameSpan.textContent;
          input.className = 'color-name-input';
          input.style.cssText = `
            font-size: 0.85rem;
            font-weight: 600;
            color: var(--text-secondary);
            text-transform: capitalize;
            background: transparent;
            border: none;
            border-radius: 0;
            outline: none;
            padding: 0;
            width: 100%;
            font-family: inherit;
          `;

          // Replace span with input
          colorNameSpan.replaceWith(input);
          input.focus();
          input.select();

          // Save on blur or Enter
          const saveColorName = () => {
            const newName = input.value.trim() || defaultColorName;
            colorNameSpan.textContent = newName;
            input.replaceWith(colorNameSpan);

            // Save to storage
            chrome.storage.local.get("settings", (data) => {
              const settings = data.settings || {};
              const customNames = settings.customColorNames || {};

              if (newName === defaultColorName) {
                // Remove custom name if it matches default
                delete customNames[color];
              } else {
                customNames[color] = newName;
              }

              settings.customColorNames = customNames;
              chrome.storage.local.set({ settings });
            });
          };

          input.addEventListener('blur', saveColorName);
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              input.blur();
            } else if (e.key === 'Escape') {
              input.value = colorNameSpan.textContent;
              input.blur();
            }
          });
        });

        const colorCount = document.createElement('span');
        colorCount.className = 'color-count';
        colorCount.textContent = `(${elements.length})`;

        groupHeader.appendChild(colorDot);
        groupHeader.appendChild(colorNameSpan);
        groupHeader.appendChild(colorCount);

        const groupNotes = document.createElement('div');
        groupNotes.className = 'color-group-notes';
        groupNotes.setAttribute('data-color', color);

        // Sort elements by tagViewPosition before adding
        elements.sort((a, b) => {
          const keyA = a.getAttribute('key');
          const keyB = b.getAttribute('key');
          const posA = savedNotes[keyA]?.tagViewPosition ?? Infinity;
          const posB = savedNotes[keyB]?.tagViewPosition ?? Infinity;
          return posA - posB;
        });

        elements.forEach(elem => {
          elem.style.display = 'flex';
          groupNotes.appendChild(elem);
        });

        groupContainer.appendChild(groupHeader);
        groupContainer.appendChild(groupNotes);
        groupContainer.setAttribute('data-color', color);
        notes.appendChild(groupContainer);
      });

      // Sort color groups by saved order
      const colorOrder = settings.colorGroupOrder || [];
      if (colorOrder.length > 0) {
        const groups = Array.from(notes.querySelectorAll('.color-group'));
        groups.sort((a, b) => {
          const colorA = a.getAttribute('data-color');
          const colorB = b.getAttribute('data-color');
          const indexA = colorOrder.indexOf(colorA);
          const indexB = colorOrder.indexOf(colorB);
          // If color not in saved order, put at end
          return (indexA === -1 ? 999 : indexA) - (indexB === -1 ? 999 : indexB);
        });
        groups.forEach(group => notes.appendChild(group));
      }

      // Initialize Sortable for color group reordering (columns)
      if (window.Sortable) {
        new Sortable(notes, {
          animation: 200,
          handle: '.color-group-header',
          draggable: '.color-group',
          ghostClass: 'sortable-ghost',
          chosenClass: 'sortable-chosen',
          onEnd: () => {
            // Save new color order
            const groups = Array.from(notes.querySelectorAll('.color-group'));
            const newOrder = groups.map(g => g.getAttribute('data-color'));
            chrome.storage.local.get('settings', (data) => {
              const settings = data.settings || {};
              settings.colorGroupOrder = newOrder;
              chrome.storage.local.set({ settings });
            });
          }
        });

        // Initialize Sortable for note reordering within and between columns
        const groupNotesContainers = document.querySelectorAll('.color-group-notes');
        groupNotesContainers.forEach(container => {
          new Sortable(container, {
            animation: 200,
            draggable: '.note',
            ghostClass: 'sortable-ghost',
            chosenClass: 'sortable-chosen',
            group: 'shared-notes', // Allow dragging between columns
            onEnd: (evt) => {
              const noteElem = evt.item;
              const key = noteElem.getAttribute('key');
              const newContainer = evt.to;
              const newColor = newContainer.getAttribute('data-color');

              // Update note's visual color
              noteElem.style.backgroundColor = newColor;
              noteElem.setAttribute('data-color', newColor);

              // Update color swatch trigger if exists
              const colorTrigger = noteElem.querySelector('.color-swatch-trigger');
              if (colorTrigger) colorTrigger.style.backgroundColor = newColor;

              // Save changes to storage
              chrome.storage.local.get('notes', (data) => {
                const savedNotes = data.notes || {};

                // Update the moved note's color
                if (savedNotes[key]) {
                  savedNotes[key].noteColor = newColor;
                }

                // Update positions for all notes in the destination column
                const notesInNewColumn = Array.from(newContainer.querySelectorAll('.note'));
                notesInNewColumn.forEach((elem, index) => {
                  const noteKey = elem.getAttribute('key');
                  if (savedNotes[noteKey]) {
                    savedNotes[noteKey].tagViewPosition = index;
                  }
                });

                // Also update positions in the source column if different
                if (evt.from !== evt.to) {
                  const notesInOldColumn = Array.from(evt.from.querySelectorAll('.note'));
                  notesInOldColumn.forEach((elem, index) => {
                    const noteKey = elem.getAttribute('key');
                    if (savedNotes[noteKey]) {
                      savedNotes[noteKey].tagViewPosition = index;
                    }
                  });

                  // Update column counts
                  const oldColorGroup = evt.from.closest('.color-group');
                  const newColorGroup = newContainer.closest('.color-group');
                  if (oldColorGroup) {
                    const oldCount = oldColorGroup.querySelector('.color-count');
                    if (oldCount) oldCount.textContent = `(${evt.from.querySelectorAll('.note').length})`;
                  }
                  if (newColorGroup) {
                    const newCount = newColorGroup.querySelector('.color-count');
                    if (newCount) newCount.textContent = `(${newContainer.querySelectorAll('.note').length})`;
                  }
                }

                chrome.storage.local.set({ notes: savedNotes });
              });
            }
          });
        });
      }
    } else {
      // For non-tags views, show/hide notes based on view
      allNoteElements.forEach((elem) => {
        const key = elem.getAttribute("key");
        const noteData = savedNotes[key];

        if (!noteData) {
          elem.style.display = "none";
          return;
        }

        const isArchived = noteData.archived || false;
        const isFavorited = noteData.favorited || false;

        if (view === 'all') {
          // Show non-archived notes
          elem.style.display = isArchived ? "none" : "flex";
        } else if (view === 'favorites') {
          // Show favorited non-archived notes
          elem.style.display = (isFavorited && !isArchived) ? "flex" : "none";
        } else if (view === 'archive') {
          // Show archived notes
          elem.style.display = isArchived ? "flex" : "none";
        }
      });

      // Check if we need to show empty state message
      checkNoteMessage(savedNotes, view);
    }
  });
}

// Show settings page
function showSettingsPage() {
  // Hide notes-related elements
  const notesContainer = document.getElementById('notes');
  const noteMessage = document.getElementById('note-message');
  const inputZone = document.getElementById('input-zone');
  const searchFilterBar = document.getElementById('search-filter-bar');

  if (notesContainer) notesContainer.style.display = 'none';
  if (noteMessage) noteMessage.style.display = 'none';
  if (inputZone) inputZone.style.display = 'none';
  if (searchFilterBar) searchFilterBar.style.display = 'none';

  // Show settings page
  const settingsPage = document.getElementById('settings-page');
  if (settingsPage) {
    settingsPage.style.display = 'block';
    loadSettingsPageValues();
  }
}

// Load settings values into the settings page form
function loadSettingsPageValues() {
  chrome.storage.local.get("settings", (data) => {
    const settings = data.settings || {};

    const providerSelect = document.getElementById("page-ai-provider");
    const modelInput = document.getElementById("page-ai-model");
    const keyInput = document.getElementById("page-ai-key");
    const autofillCheckbox = document.getElementById("page-autofill");
    const playSoundsCheckbox = document.getElementById("page-play-sounds");
    const autonameNewNotesCheckbox = document.getElementById("page-autoname-newnotes");
    const autonameSelectionCheckbox = document.getElementById("page-autoname-selection");
    const noteSizeSlider = document.getElementById("page-note-size");
    const noteSizeValue = document.getElementById("page-note-size-value");

    if (providerSelect) providerSelect.value = settings.aiProvider || "none";
    if (modelInput) modelInput.value = settings.aiModel || "";
    if (keyInput) keyInput.value = settings.key || "";

    // Load custom provider fields
    const baseUrlInput = document.getElementById("page-ai-base-url");
    const baseUrlField = document.getElementById("page-ai-base-url-field");
    const modelField = document.getElementById("page-ai-model-field");
    if (baseUrlInput) baseUrlInput.value = settings.customBaseUrl || "";

    // Show/hide custom fields based on provider
    const currentProvider = settings.aiProvider || "none";
    if (baseUrlField) baseUrlField.style.display = currentProvider === "custom" ? "" : "none";
    if (modelField && currentProvider === "custom") {
      // For custom, the model field placeholder should indicate custom model name
      if (modelInput) modelInput.placeholder = "e.g. openai/gpt-4o";
    } else {
      if (modelInput) modelInput.placeholder = "e.g., gpt-4o-mini";
    }
    if (autofillCheckbox) autofillCheckbox.checked = settings.autoFillPlaceholders || false;
    if (playSoundsCheckbox) playSoundsCheckbox.checked = settings.playSounds !== false;
    // Auto-name settings default to true, user can disable them
    if (autonameNewNotesCheckbox) {
      autonameNewNotesCheckbox.checked = settings.autonameNewNotes !== false;
    }
    if (autonameSelectionCheckbox) {
      autonameSelectionCheckbox.checked = settings.autonameSelection !== false;
    }

    const savedSize = settings.noteSize || 320;
    if (noteSizeSlider) noteSizeSlider.value = savedSize;
    if (noteSizeValue) noteSizeValue.textContent = savedSize + "px";
  });
}

// Initialize settings page functionality
function initSettingsPage() {
  const saveBtn = document.getElementById("page-settings-save");
  const exportBtn = document.getElementById("page-export-btn");
  const importBtn = document.getElementById("page-import-btn");
  const importFile = document.getElementById("page-import-file");
  const noteSizeSlider = document.getElementById("page-note-size");
  const noteSizeValue = document.getElementById("page-note-size-value");

  // Function to mark save button as having unsaved changes
  const markUnsavedChanges = () => {
    if (saveBtn) {
      saveBtn.textContent = "Save Settings *";
      saveBtn.style.background = "#f59e0b"; // Amber/warning color
      saveBtn.style.boxShadow = "3px 3px 0 rgba(217, 119, 6, 0.6)"; // Amber shadow
    }
  };

  // Add change listeners to all settings inputs
  const settingsInputs = [
    "page-ai-provider",
    "page-ai-model",
    "page-ai-key",
    "page-ai-base-url",
    "page-autofill",
    "page-play-sounds",
    "page-autoname-newnotes",
    "page-autoname-selection",
    "page-note-size"
  ];

  settingsInputs.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener("change", markUnsavedChanges);
      el.addEventListener("input", markUnsavedChanges);
    }
  });

  // Toggle custom provider fields visibility when provider changes
  const pageProviderSelect = document.getElementById("page-ai-provider");
  const pageBaseUrlField = document.getElementById("page-ai-base-url-field");
  const pageModelInput = document.getElementById("page-ai-model");
  if (pageProviderSelect) {
    pageProviderSelect.addEventListener("change", () => {
      const isCustom = pageProviderSelect.value === "custom";
      if (pageBaseUrlField) pageBaseUrlField.style.display = isCustom ? "" : "none";
      if (pageModelInput) pageModelInput.placeholder = isCustom ? "e.g. openai/gpt-4o" : "e.g., gpt-4o-mini";
    });
  }

  // Update note size value display and apply in real-time
  noteSizeSlider?.addEventListener("input", () => {
    if (noteSizeValue) noteSizeValue.textContent = noteSizeSlider.value + "px";
    // Apply size immediately to notes container
    const notesContainer = document.getElementById("notes");
    if (notesContainer) {
      notesContainer.style.setProperty("--note-size", noteSizeSlider.value + "px");
    }
    // Also sync the toolbar slider
    const toolbarSlider = document.getElementById("note-size-slider");
    if (toolbarSlider) toolbarSlider.value = noteSizeSlider.value;
  });

  // Save settings
  saveBtn?.addEventListener("click", () => {
    const providerSelect = document.getElementById("page-ai-provider");
    const modelInput = document.getElementById("page-ai-model");
    const keyInput = document.getElementById("page-ai-key");
    const autofillCheckbox = document.getElementById("page-autofill");
    const playSoundsCheckbox = document.getElementById("page-play-sounds");
    const autonameNewNotesCheckbox = document.getElementById("page-autoname-newnotes");
    const autonameSelectionCheckbox = document.getElementById("page-autoname-selection");
    const noteSizeSlider = document.getElementById("page-note-size");

    chrome.storage.local.get("settings", (data) => {
      const settings = data.settings || {};

      const pageBaseUrlInput = document.getElementById("page-ai-base-url");
      settings.aiProvider = providerSelect?.value || "";
      settings.aiModel = modelInput?.value || "";
      settings.key = keyInput?.value || "";
      settings.customBaseUrl = pageBaseUrlInput?.value || settings.customBaseUrl || "";
      settings.autoFillPlaceholders = autofillCheckbox?.checked || false;
      settings.playSounds = playSoundsCheckbox?.checked !== false;
      settings.autonameNewNotes = autonameNewNotesCheckbox?.checked || false;
      settings.autonameSelection = autonameSelectionCheckbox?.checked || false;
      settings.noteSize = parseInt(noteSizeSlider?.value || 320);

      // Apply note size immediately to notes container
      const notesContainer = document.getElementById("notes");
      if (notesContainer) {
        notesContainer.style.setProperty("--note-size", settings.noteSize + "px");
      }
      // Sync toolbar slider
      const toolbarSlider = document.getElementById("note-size-slider");
      if (toolbarSlider) toolbarSlider.value = settings.noteSize;

      chrome.storage.local.set({ settings }, () => {
        // Broadcast settings to all tabs so they update without refresh
        chrome.tabs.query({}, (tabs) => {
          tabs.forEach((tab) => {
            if (tab.id) {
              chrome.tabs.sendMessage(tab.id, {
                action: "settingsUpdated",
                settings: settings
              }).catch(() => {}); // Ignore errors for tabs without content script
            }
          });
        });

        // Show save feedback and reset unsaved indicator
        if (saveBtn) {
          saveBtn.textContent = "Saved!";
          saveBtn.style.background = "#10b981"; // Green
          saveBtn.style.boxShadow = "3px 3px 0 rgba(5, 150, 105, 0.6)"; // Green shadow
          setTimeout(() => {
            saveBtn.textContent = "Save Settings";
            saveBtn.style.background = "";
            saveBtn.style.boxShadow = ""; // Reset to default purple shadow
          }, 1500);
        }
        console.log("Settings saved");
      });
    });
  });

  // Export notes
  exportBtn?.addEventListener("click", () => {
    chrome.storage.local.get("notes", (data) => {
      const notes = data.notes || {};
      const blob = new Blob([JSON.stringify(notes, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `blocknotes-export-${new Date().toISOString().split("T")[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });
  });

  // Import notes
  importBtn?.addEventListener("click", () => {
    importFile?.click();
  });

  importFile?.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const importedNotes = JSON.parse(event.target.result);
        if (typeof importedNotes !== "object") {
          alert("Invalid file format");
          return;
        }

        if (confirm(`Import ${Object.keys(importedNotes).length} notes? This will add to your existing notes.`)) {
          chrome.storage.local.get(["notes", "noteCounter"], (data) => {
            const existingNotes = data.notes || {};
            let counter = data.noteCounter || Object.keys(existingNotes).length;

            Object.values(importedNotes).forEach((note) => {
              const newId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}_${counter}`;
              existingNotes[newId] = {
                ...note,
                noteIndex: newId,
                displayIndex: counter,
              };
              counter++;
            });

            chrome.storage.local.set({ notes: existingNotes, noteCounter: counter }, () => {
              loadNotes();
              // Reinitialize all Lucide icons to ensure they render correctly
              if (window.lucide) {
                lucide.createIcons();
              }
              alert("Notes imported successfully!");
              // Switch to All Notes view
              const allNotesItem = document.querySelector('.sidebar-item[title="All Notes"]');
              if (allNotesItem) allNotesItem.click();
            });
          });
        }
      } catch (err) {
        alert("Failed to parse file: " + err.message);
      }
    };
    reader.readAsText(file);
    if (importFile) importFile.value = "";
  });
}

// Info modal functionality
function initInfoModal() {
  const openBtn = document.getElementById("open-info-modal");
  const closeBtn = document.getElementById("close-info-modal");
  const modal = document.getElementById("info-modal");
  const overlay = modal?.querySelector(".modal-overlay");

  if (!openBtn || !modal) return;

  const openModal = () => modal.classList.add("active");
  const closeModal = () => modal.classList.remove("active");

  openBtn.addEventListener("click", openModal);
  closeBtn?.addEventListener("click", closeModal);
  overlay?.addEventListener("click", closeModal);

  // Close on Escape key
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal.classList.contains("active")) {
      closeModal();
    }
  });
}

// Search bar toggle functionality
function initSearchBarToggle() {
  const toggleBtn = document.getElementById("toggle-search-bar");
  const searchBar = document.getElementById("search-filter-bar");

  if (!toggleBtn || !searchBar) {
    return;
  }

  // Load saved state and apply class for animation
  chrome.storage.local.get("settings", (data) => {
    const settings = data.settings || {};
    if (settings.searchBarHidden) {
      searchBar.classList.add("hidden");
      toggleBtn.classList.remove("active");
    } else {
      searchBar.classList.remove("hidden");
      toggleBtn.classList.add("active");
    }
  });

  toggleBtn.addEventListener("click", () => {
    const isCurrentlyHidden = searchBar.classList.contains("hidden");

    if (isCurrentlyHidden) {
      // Show the search bar (animate in)
      searchBar.classList.remove("hidden");
      toggleBtn.classList.add("active");
    } else {
      // Hide the search bar (animate out)
      searchBar.classList.add("hidden");
      toggleBtn.classList.remove("active");
    }

    // Save state
    chrome.storage.local.get("settings", (data) => {
      const settings = data.settings || {};
      settings.searchBarHidden = !isCurrentlyHidden;
      chrome.storage.local.set({ settings });
    });
  });
}

// Download notes functionality
function initDownloadNotes() {
  const downloadBtn = document.getElementById("download-notes");

  if (!downloadBtn) return;

  downloadBtn.addEventListener("click", () => {
    chrome.storage.local.get("notes", (data) => {
      const notes = data.notes || {};
      const noteCount = Object.keys(notes).length;

      if (noteCount === 0) {
        alert("No notes to download.");
        return;
      }

      // Create JSON blob
      const jsonData = JSON.stringify(notes, null, 2);
      const blob = new Blob([jsonData], { type: "application/json" });
      const url = URL.createObjectURL(blob);

      // Create download link
      const a = document.createElement("a");
      a.href = url;
      const date = new Date().toISOString().split("T")[0];
      a.download = `blocknotes-backup-${date}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      console.log(`Downloaded ${noteCount} notes`);
    });
  });
}

// Delete All Notes functionality
function initDeleteAllNotes() {
  const deleteBtn = document.getElementById("delete-all-notes");
  const modal = document.getElementById("delete-all-modal");
  const closeBtn = document.getElementById("close-delete-modal");
  const overlay = modal?.querySelector(".modal-overlay");
  const archiveAllBtn = document.getElementById("archive-all-btn");
  const deleteAllBtn = document.getElementById("delete-all-btn");
  const cancelBtn = document.getElementById("cancel-delete-btn");

  if (!deleteBtn || !modal) return;

  const openModal = () => modal.classList.add("active");
  const closeModal = () => modal.classList.remove("active");

  deleteBtn.addEventListener("click", openModal);
  closeBtn?.addEventListener("click", closeModal);
  overlay?.addEventListener("click", closeModal);
  cancelBtn?.addEventListener("click", closeModal);

  // Archive all notes
  archiveAllBtn?.addEventListener("click", () => {
    chrome.storage.local.get("notes", (data) => {
      const savedNotes = data.notes || {};

      // Set archived flag on all notes
      Object.keys(savedNotes).forEach((key) => {
        savedNotes[key].archived = true;
      });

      chrome.storage.local.set({ notes: savedNotes }, () => {
        closeModal();
        loadNotes();
        // Reinitialize all Lucide icons to ensure they render correctly
        if (window.lucide) {
          lucide.createIcons();
        }
        console.log("All notes archived");
      });
    });
  });

  // Delete all notes permanently
  deleteAllBtn?.addEventListener("click", () => {
    chrome.storage.local.set({ notes: {}, noteCounter: 0 }, () => {
      closeModal();
      loadNotes();
      // Reinitialize all Lucide icons to ensure they render correctly
      if (window.lucide) {
        lucide.createIcons();
      }
      console.log("All notes deleted");
    });
  });

  // Close on Escape
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal.classList.contains("active")) {
      closeModal();
    }
  });
}

// Walkthrough for first-time users
function initWalkthrough() {
  chrome.storage.local.get("walkthroughComplete", (data) => {
    if (data.walkthroughComplete) return;

    const modal = document.getElementById('walkthrough-modal');
    if (!modal) return;

    modal.style.display = 'flex';
    let currentStep = 1;
    const totalSteps = 4;

    const updateStep = (step) => {
      // Hide all steps
      modal.querySelectorAll('.walkthrough-step').forEach(s => {
        s.style.display = 'none';
      });
      // Show current step
      const stepEl = modal.querySelector(`.walkthrough-step[data-step="${step}"]`);
      if (stepEl) stepEl.style.display = 'block';

      // Update dots
      modal.querySelectorAll('.walkthrough-dots .dot').forEach(d => {
        d.classList.toggle('active', parseInt(d.dataset.step) === step);
      });

      // Update button text
      const nextBtn = modal.querySelector('.walkthrough-next');
      if (nextBtn) {
        nextBtn.textContent = step === totalSteps ? 'Get Started' : 'Next';
      }
    };

    const closeWalkthrough = () => {
      modal.style.display = 'none';
      chrome.storage.local.set({ walkthroughComplete: true });
    };

    // Next button
    modal.querySelector('.walkthrough-next')?.addEventListener('click', () => {
      if (currentStep < totalSteps) {
        currentStep++;
        updateStep(currentStep);
      } else {
        closeWalkthrough();
      }
    });

    // Skip button
    modal.querySelector('.walkthrough-skip')?.addEventListener('click', closeWalkthrough);

    // Click on background to skip
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        closeWalkthrough();
      }
    });

    // Dot navigation
    modal.querySelectorAll('.walkthrough-dots .dot').forEach(dot => {
      dot.addEventListener('click', () => {
        currentStep = parseInt(dot.dataset.step);
        updateStep(currentStep);
      });
    });
  });
}

// Initialize everything
console.log("Initializing BlockNotes...");
loadNotes();
initQuickActions();
initSearchAndFilter();
initAIConfiguration();
initNoteSizeSlider();
initSidebar();
initInfoModal();
initSearchBarToggle();
initDownloadNotes();
initDeleteAllNotes();
initSettingsPage();
initWalkthrough();
initMobileMenu();

// Mobile menu functionality
function initMobileMenu() {
  const menuBtn = document.getElementById('mobile-menu-btn');
  const dropdown = document.getElementById('mobile-dropdown');
  const overlay = document.getElementById('mobile-overlay');

  if (!menuBtn || !dropdown) return;

  const openMenu = () => {
    dropdown.classList.add('open');
    if (overlay) overlay.classList.add('active');
    menuBtn.innerHTML = '<i data-lucide="x"></i>';
    lucide.createIcons();
  };

  const closeMenu = () => {
    dropdown.classList.remove('open');
    if (overlay) overlay.classList.remove('active');
    menuBtn.innerHTML = '<i data-lucide="menu"></i>';
    lucide.createIcons();
  };

  menuBtn.addEventListener('click', () => {
    if (dropdown.classList.contains('open')) {
      closeMenu();
    } else {
      openMenu();
    }
  });

  if (overlay) {
    overlay.addEventListener('click', closeMenu);
  }

  // Handle dropdown item clicks
  dropdown.querySelectorAll('.mobile-dropdown-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const view = item.dataset.view;

      // Update active state
      dropdown.querySelectorAll('.mobile-dropdown-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');

      // Also update sidebar active state for consistency
      document.querySelectorAll('.sidebar-item').forEach(sidebarItem => {
        const title = sidebarItem.getAttribute('title')?.toLowerCase() || '';
        if (title.includes(view) || (view === 'all' && title.includes('all'))) {
          sidebarItem.classList.add('active');
        } else {
          sidebarItem.classList.remove('active');
        }
      });

      // Trigger the view change
      if (view === 'settings') {
        currentView = 'settings';
        showSettingsPage();
      } else {
        currentView = view;
        showNotesByView(view);
      }

      closeMenu();
    });
  });
}

// Listen for noteSaved message from content scripts only (not from extension itself)
chrome.runtime.onMessage.addListener((message, sender) => {
  // sender.tab exists only for messages from content scripts
  if (message.action === "noteSaved" && sender.tab) {
    console.log("Note saved from content script, reloading...");
    loadNotes();
  }
});

console.log("BlockNotes initialized successfully!");
