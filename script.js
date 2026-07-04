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

const QUICK_ADD_STORAGE_KEY = "familyAdminQuickAdds";
const MAX_RECENT_ENTRIES = 10;

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value ?? "";
  return div.innerHTML;
}

function loadRecentEntries() {
  try {
    return JSON.parse(localStorage.getItem(QUICK_ADD_STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

function saveRecentEntry(entry) {
  const entries = [entry, ...loadRecentEntries()].slice(0, MAX_RECENT_ENTRIES);
  localStorage.setItem(QUICK_ADD_STORAGE_KEY, JSON.stringify(entries));
}

function renderRecentEntries() {
  const container = document.getElementById("qa-recent");
  const entries = loadRecentEntries();

  if (!entries.length) {
    container.innerHTML = "";
    return;
  }

  container.innerHTML = entries
    .map((entry) => {
      const when = [entry.date, entry.time].filter(Boolean).join(" ");
      return `
        <div class="qa-recent-item">
          <span class="badge">${escapeHtml(entry.type)}</span>
          <span>${escapeHtml(entry.title)}${when ? ` — ${escapeHtml(when)}` : ""}</span>
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
      type: formData.get("type"),
      title: formData.get("title"),
      date: formData.get("date") || null,
      time: formData.get("time") || null,
      assignee: formData.get("assignee") || null,
      notes: formData.get("notes") || null,
      createdAt: new Date().toISOString(),
    };

    saveRecentEntry(entry);
    renderRecentEntries();
    if (entry.type === "event") renderCalendarList();

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
  return loadRecentEntries()
    .filter((entry) => entry.type === "event")
    .map((entry) => ({
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
        (event) =>
          `<li>${event.local ? '<span class="badge badge-local">local</span> ' : ""}${escapeHtml(event.title)}${event.start ? ` — ${escapeHtml(event.start)}` : ""}</li>`
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

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

renderRecentEntries();
setupQuickAddForm();
loadCalendarStatus();
registerServiceWorker();
