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

// Public CSV export link for the Google Sheet Make.com writes your synced
// Google Calendar events into. In the Sheet: Share > "Anyone with the link"
// can view, then use either:
//   https://docs.google.com/spreadsheets/d/SHEET_ID/export?format=csv&gid=GID
// or File > Share > Publish to web > (pick the tab) > CSV > Publish, which
// gives a  /pub?output=csv  link — that one is the most reliably fetchable
// from browser JS if the /export link ever hits a CORS error.
// Required header row (exact column names, any order): Title, Date, Time, Notes
// gid=0 assumes the calendar data is on the sheet's first tab. If it's on a
// different tab, open that tab in the browser and copy the #gid=NNNN number
// from the URL bar into the gid= param below.
const CALENDAR_SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/11Wbdtl829Fs0lkWyuQUnIaq07UD01A_TD_fwxw016sg/export?format=csv&gid=0";

// Bump this whenever sw.js changes so phones re-fetch it instead of serving
// a stale cached copy (must match CACHE_NAME's version in sw.js).
const SW_VERSION = "v7";

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

    let entry;
    try {
      const formData = new FormData(form);
      entry = {
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
    } catch (err) {
      statusEl.textContent = `Couldn't save: ${err.message}`;
      return;
    }

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
    notes: event.notes || null,
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
    <div class="calendar-event"${event.notes ? ` title="${escapeHtml(event.notes)}"` : ""}>
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

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function normalizeSheetDate(raw) {
  if (!raw) return null;
  const value = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

  const usMatch = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (usMatch) {
    const [, month, day, year] = usMatch;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : formatDateKey(parsed);
}

function normalizeSheetTime(raw) {
  if (!raw) return null;
  const value = raw.trim();
  const match = value.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM|am|pm)?$/);
  if (!match) return value;

  let [, hour, minute, meridiem] = match;
  hour = parseInt(hour, 10);
  if (meridiem) {
    const isPm = meridiem.toLowerCase() === "pm";
    if (isPm && hour !== 12) hour += 12;
    if (!isPm && hour === 12) hour = 0;
  }
  return `${String(hour).padStart(2, "0")}:${minute}`;
}

function parseSheetEvents(csvText) {
  const rows = parseCsv(csvText.trim());
  if (!rows.length) return [];

  const headers = rows[0].map((cell) => cell.trim().toLowerCase());
  const titleIndex = headers.indexOf("title");
  if (titleIndex === -1) return [];

  const dateIndex = headers.indexOf("date");
  const timeIndex = headers.indexOf("time");
  const notesIndex = headers.indexOf("notes");

  return rows
    .slice(1)
    .filter((cells) => cells[titleIndex] && cells[titleIndex].trim())
    .map((cells, index) => ({
      id: `sheet-${index}`,
      title: cells[titleIndex].trim(),
      date: dateIndex >= 0 ? normalizeSheetDate(cells[dateIndex]) : null,
      time: timeIndex >= 0 ? normalizeSheetTime(cells[timeIndex]) : null,
      notes: notesIndex >= 0 ? (cells[notesIndex] || "").trim() : "",
      local: false,
    }));
}

async function loadCalendarEvents() {
  if (!CALENDAR_SHEET_CSV_URL) {
    remoteCalendarData = { lastSynced: null, events: [] };
    renderCalendar();
    return;
  }

  try {
    const response = await fetch(CALENDAR_SHEET_CSV_URL, { cache: "no-store" });
    if (!response.ok) throw new Error("sheet fetch failed");
    const csvText = await response.text();
    remoteCalendarData = { lastSynced: new Date().toISOString(), events: parseSheetEvents(csvText) };
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
loadCalendarEvents();
registerServiceWorker();
