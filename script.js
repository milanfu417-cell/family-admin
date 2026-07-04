document.getElementById("today").textContent = new Date().toLocaleDateString(undefined, {
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
});

// Paste your Make.com "Custom Webhook" URL here to have Quick Add entries
// sent straight to your Make.com scenario (e.g. to file into Gmail/Calendar).
// Leave blank to just save entries locally in the browser.
const MAKE_WEBHOOK_URL = "";

// Make.com can write to this file (e.g. via its GitHub module) each time it
// syncs your Google Calendar, so the dashboard can display the latest status.
const CALENDAR_STATUS_URL = "data/calendar-status.json";

// Bump this whenever sw.js changes so phones re-fetch it instead of serving
// a stale cached copy (must match CACHE_NAME's version in sw.js).
const SW_VERSION = "v3";

const QUICK_ADD_STORAGE_KEY = "familyAdminQuickAdds";
const MAX_STORED_ENTRIES = 50;

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value ?? "";
  return div.innerHTML;
}

function generateId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function loadEntries() {
  try {
    return JSON.parse(localStorage.getItem(QUICK_ADD_STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

function saveEntries(entries) {
  localStorage.setItem(QUICK_ADD_STORAGE_KEY, JSON.stringify(entries));
}

function addEntry(entry) {
  saveEntries([entry, ...loadEntries()].slice(0, MAX_STORED_ENTRIES));
}

function deleteEntry(id) {
  saveEntries(loadEntries().filter((entry) => entry.id !== id));
  renderRecentEntries();
  renderCalendarList();
}

function renderRecentEntries() {
  const container = document.getElementById("qa-recent");
  const entries = loadEntries();

  if (!entries.length) {
    container.innerHTML = "";
    return;
  }

  container.innerHTML = entries
    .map((entry) => {
      const when = [entry.date, entry.time].filter(Boolean).join(" ");
      return `
        <div class="qa-recent-item">
          <span class="qa-recent-item-content">
            <span class="badge">${escapeHtml(entry.type)}</span>
            <span>${escapeHtml(entry.title)}${when ? ` — ${escapeHtml(when)}` : ""}</span>
          </span>
          <button type="button" class="delete-btn" data-delete-id="${escapeHtml(entry.id)}" aria-label="Delete ${escapeHtml(entry.title)}">🗑️</button>
        </div>
      `;
    })
    .join("");
}

function setupQuickAddForm() {
  const form = document.getElementById("quick-add-form");
  const statusEl = document.getElementById("qa-status");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const entry = {
      id: generateId(),
      type: formData.get("type"),
      title: formData.get("title"),
      date: formData.get("date") || null,
      time: formData.get("time") || null,
      assignee: formData.get("assignee") || null,
      notes: formData.get("notes") || null,
      createdAt: new Date().toISOString(),
    };

    addEntry(entry);
    renderRecentEntries();
    // Re-derives from storage and filters for type "event" internally, so
    // any Event entry is guaranteed to show up in Calendar Sync right away.
    renderCalendarList();

    if (MAKE_WEBHOOK_URL) {
      statusEl.textContent = "Sending to Make.com…";
      try {
        const response = await fetch(MAKE_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(entry),
        });
        statusEl.textContent = response.ok
          ? "Sent to Make.com ✓"
          : "Saved locally — Make.com returned an error.";
      } catch {
        statusEl.textContent = "Saved locally — couldn't reach Make.com.";
      }
    } else {
      statusEl.textContent = "Saved locally. Add your Make.com webhook URL in script.js to sync automatically.";
    }

    form.reset();
  });
}

let remoteCalendarData = { lastSynced: null, events: [] };

function getLocalCalendarEvents() {
  return loadEntries()
    .filter((entry) => entry.type === "event")
    .map((entry) => ({
      id: entry.id,
      title: entry.title,
      start: [entry.date, entry.time].filter(Boolean).join(" "),
      local: true,
    }));
}

function renderCalendarList() {
  const metaEl = document.getElementById("calendar-sync-meta");
  const listEl = document.getElementById("calendar-events");

  const localEvents = getLocalCalendarEvents();
  const allEvents = [...localEvents, ...(remoteCalendarData.events || [])];

  if (remoteCalendarData.lastSynced) {
    metaEl.textContent = `Last synced ${new Date(remoteCalendarData.lastSynced).toLocaleString()}`;
  } else if (localEvents.length) {
    metaEl.textContent = "Not synced with Google Calendar yet — showing events added here.";
  } else {
    metaEl.textContent = "Not connected yet.";
  }

  if (allEvents.length) {
    listEl.innerHTML = allEvents
      .map(
        (event) => `
        <li class="event-item">
          <span class="event-item-content">
            ${event.local ? '<span class="badge badge-local">local</span> ' : ""}
            <span>${escapeHtml(event.title)}${event.start ? ` — ${escapeHtml(event.start)}` : ""}</span>
          </span>
          ${
            event.local
              ? `<button type="button" class="delete-btn" data-delete-id="${escapeHtml(event.id)}" aria-label="Delete ${escapeHtml(event.title)}">🗑️</button>`
              : ""
          }
        </li>
      `
      )
      .join("");
  } else {
    listEl.innerHTML =
      '<li class="muted">No events synced yet — connect Make.com to pull events from Google Calendar.</li>';
  }
}

async function loadCalendarStatus() {
  try {
    const response = await fetch(CALENDAR_STATUS_URL, { cache: "no-store" });
    if (!response.ok) throw new Error("status file not found");
    remoteCalendarData = await response.json();
  } catch {
    remoteCalendarData = { lastSynced: null, events: [] };
  }
  renderCalendarList();
}

function setupDeleteDelegation() {
  const handleDelete = (event) => {
    const button = event.target.closest("[data-delete-id]");
    if (!button) return;
    deleteEntry(button.dataset.deleteId);
  };

  document.getElementById("qa-recent").addEventListener("click", handleDelete);
  document.getElementById("calendar-events").addEventListener("click", handleDelete);
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });

  window.addEventListener("load", async () => {
    try {
      const registration = await navigator.serviceWorker.register(`sw.js?v=${SW_VERSION}`);
      registration.update();
    } catch {
      // ignore
    }
  });
}

renderRecentEntries();
setupQuickAddForm();
setupDeleteDelegation();
loadCalendarStatus();
registerServiceWorker();
