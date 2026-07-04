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
// Expected shape: { lastSynced: ISOString, events: [{ id, title, date: "YYYY-MM-DD", time: "HH:MM" }] }
const CALENDAR_STATUS_URL = "data/calendar-status.json";

// Bump this whenever sw.js changes so phones re-fetch it instead of serving
// a stale cached copy (must match CACHE_NAME's version in sw.js).
const SW_VERSION = "v4";

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
  renderCalendar();
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
    renderCalendar();

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
let calendarCursor = startOfMonth(new Date());

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function parseDateOnly(dateStr) {
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function formatDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isPastDate(dateStr) {
  if (!dateStr) return false;
  return parseDateOnly(dateStr) < startOfToday();
}

function getVisibleEvents() {
  const localEvents = loadEntries()
    .filter((entry) => entry.type === "event")
    .map((entry) => ({ id: entry.id, title: entry.title, date: entry.date, time: entry.time, local: true }));

  const remoteEvents = (remoteCalendarData.events || []).map((event) => ({
    id: event.id || null,
    title: event.title,
    date: event.date || null,
    time: event.time || null,
    local: false,
  }));

  // Hide anything dated before today so past events never clutter the view.
  return [...localEvents, ...remoteEvents].filter((event) => !isPastDate(event.date));
}

function renderSyncMeta(eventCount) {
  const metaEl = document.getElementById("calendar-sync-meta");
  if (remoteCalendarData.lastSynced) {
    metaEl.textContent = `Last synced ${new Date(remoteCalendarData.lastSynced).toLocaleString()}`;
  } else if (eventCount) {
    metaEl.textContent = "Not synced with Google Calendar yet — showing events added here.";
  } else {
    metaEl.textContent = "Not connected yet.";
  }
}

function renderEventChip(event) {
  return `
    <div class="calendar-event">
      <span class="calendar-event-title">${escapeHtml(event.title)}${event.time ? ` · ${escapeHtml(event.time)}` : ""}</span>
      ${
        event.local
          ? `<button type="button" class="delete-btn" data-delete-id="${escapeHtml(event.id)}" aria-label="Delete ${escapeHtml(event.title)}">🗑️</button>`
          : ""
      }
    </div>
  `;
}

function renderMonthGrid(eventsByDate) {
  const grid = document.getElementById("calendar-grid");
  const label = document.getElementById("calendar-month-label");

  label.textContent = calendarCursor.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  const year = calendarCursor.getFullYear();
  const month = calendarCursor.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const totalCells = Math.ceil((firstWeekday + daysInMonth) / 7) * 7;
  const todayKey = formatDateKey(startOfToday());

  let html = "";
  for (let i = 0; i < totalCells; i++) {
    const dayNumber = i - firstWeekday + 1;
    if (dayNumber < 1 || dayNumber > daysInMonth) {
      html += '<div class="calendar-day calendar-day-outside"></div>';
      continue;
    }

    const key = formatDateKey(new Date(year, month, dayNumber));
    const dayEvents = eventsByDate[key] || [];

    html += `
      <div class="calendar-day${key === todayKey ? " is-today" : ""}">
        <span class="calendar-day-number">${dayNumber}</span>
        <div class="calendar-day-events">${dayEvents.map(renderEventChip).join("")}</div>
      </div>
    `;
  }

  grid.innerHTML = html;
}

function renderUnscheduled(events) {
  const container = document.getElementById("calendar-unscheduled");

  if (!events.length) {
    container.innerHTML = "";
    return;
  }

  container.innerHTML = `
    <p class="unscheduled-label">No date set</p>
    ${events
      .map(
        (event) => `
      <div class="entry-row">
        <span class="entry-row-content">
          ${event.local ? '<span class="badge-local">local</span>' : ""}
          <span>${escapeHtml(event.title)}</span>
        </span>
        ${
          event.local
            ? `<button type="button" class="delete-btn" data-delete-id="${escapeHtml(event.id)}" aria-label="Delete ${escapeHtml(event.title)}">🗑️</button>`
            : ""
        }
      </div>
    `
      )
      .join("")}
  `;
}

function renderCalendar() {
  const events = getVisibleEvents();
  const scheduled = events.filter((event) => event.date);
  const unscheduled = events.filter((event) => !event.date);

  const eventsByDate = {};
  scheduled.forEach((event) => {
    (eventsByDate[event.date] ||= []).push(event);
  });

  renderMonthGrid(eventsByDate);
  renderUnscheduled(unscheduled);
  renderSyncMeta(events.length);
}

async function loadCalendarStatus() {
  try {
    const response = await fetch(CALENDAR_STATUS_URL, { cache: "no-store" });
    if (!response.ok) throw new Error("status file not found");
    remoteCalendarData = await response.json();
  } catch {
    remoteCalendarData = { lastSynced: null, events: [] };
  }
  renderCalendar();
}

function setupCalendarNav() {
  document.getElementById("cal-prev").addEventListener("click", () => {
    calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() - 1, 1);
    renderCalendar();
  });
  document.getElementById("cal-next").addEventListener("click", () => {
    calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() + 1, 1);
    renderCalendar();
  });
}

function setupDeleteDelegation() {
  const handleDelete = (event) => {
    const button = event.target.closest("[data-delete-id]");
    if (!button) return;
    deleteEntry(button.dataset.deleteId);
  };

  document.getElementById("calendar-grid").addEventListener("click", handleDelete);
  document.getElementById("calendar-unscheduled").addEventListener("click", handleDelete);
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

setupQuickAddForm();
setupCalendarNav();
setupDeleteDelegation();
loadCalendarStatus();
registerServiceWorker();
