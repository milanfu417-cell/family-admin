document.getElementById("today").textContent = new Date().toLocaleDateString(undefined, {
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
});

// Paste your Make.com "Custom Webhook" URL here to have new items sent
// straight to your Make.com scenario. Leave blank to just save locally.
const MAKE_WEBHOOK_URL = "";

// Make.com Custom Webhook for bi-directional calendar sync: every "Add
// Calendar Event" submission POSTs { title, date, time, notes } here so
// Make.com can file it into Google Calendar. Leave blank to skip syncing
// and just save the event locally.
const CALENDAR_EVENT_WEBHOOK_URL = "https://hook.eu1.make.com/rh5fp1wrqsdxkawkt4lwqec74mc8rs1g";

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
const SW_VERSION = "v15";

const ENTRIES_STORAGE_KEY = "familyAdminQuickAdds";
const SEED_FLAG_KEY = "familyAdminSeeded";
const MAX_STORED_ENTRIES = 100;

// One-time starter items so every list has *something* deletable in it
// rather than permanently-fixed placeholder text.
const SEED_ITEMS = [
  { type: "chore", title: "Take out the trash" },
  { type: "chore", title: "Load the dishwasher" },
  { type: "shopping", title: "Milk" },
  { type: "shopping", title: "Eggs" },
];

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
    return JSON.parse(localStorage.getItem(ENTRIES_STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

function saveEntries(entries) {
  localStorage.setItem(ENTRIES_STORAGE_KEY, JSON.stringify(entries));
}

function addEntry(entry) {
  saveEntries([entry, ...loadEntries()].slice(0, MAX_STORED_ENTRIES));
}

function ensureSeeded() {
  if (localStorage.getItem(SEED_FLAG_KEY)) return;
  const seeded = SEED_ITEMS.map((item) => ({
    id: generateId(),
    type: item.type,
    title: item.title,
    createdAt: new Date().toISOString(),
  }));
  saveEntries([...loadEntries(), ...seeded]);
  localStorage.setItem(SEED_FLAG_KEY, "1");
}

function deleteEntry(id) {
  saveEntries(loadEntries().filter((entry) => entry.id !== id));
  renderCalendar();
  renderChores();
  renderShopping();
  renderMeals();
  renderBudget();
}

// Synced events aren't stored locally — they're re-fetched from the Sheet
// every load — so "deleting" one just remembers its id here and filters it
// out of the view permanently, regardless of what the Sheet keeps sending.
const DISMISSED_SYNC_KEY = "familyAdminDismissedSync";

function loadDismissedSyncIds() {
  try {
    return JSON.parse(localStorage.getItem(DISMISSED_SYNC_KEY)) || [];
  } catch {
    return [];
  }
}

function dismissSyncedEvent(id) {
  const dismissed = loadDismissedSyncIds();
  if (!dismissed.includes(id)) {
    dismissed.push(id);
    localStorage.setItem(DISMISSED_SYNC_KEY, JSON.stringify(dismissed));
  }
  renderCalendar();
}

function notifyMake(entry) {
  if (!MAKE_WEBHOOK_URL) return;
  fetch(MAKE_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(entry),
  }).catch(() => {});
}

function setupDeleteDelegation() {
  document.querySelector(".dashboard-tiles").addEventListener("click", (event) => {
    const button = event.target.closest("[data-delete-id]");
    if (!button) return;
    const id = button.dataset.deleteId;
    if (id.startsWith("sheet:")) {
      dismissSyncedEvent(id);
    } else {
      deleteEntry(id);
    }
  });
}

// ---------- Simple list tiles (Chores / Shopping / Meal Plan / Budget) ----------

function getItemsByType(type) {
  return loadEntries().filter((entry) => entry.type === type);
}

function renderSimpleList(type, listElId, emptyText) {
  const list = document.getElementById(listElId);
  const rows = getItemsByType(type)
    .map(
      (item) => `
      <li class="tile-list-row">
        <span>${escapeHtml(item.title)}</span>
        <button type="button" class="delete-btn" data-delete-id="${escapeHtml(item.id)}" aria-label="Delete ${escapeHtml(item.title)}">🗑️</button>
      </li>
    `
    )
    .join("");

  list.innerHTML = rows || `<li class="muted">${escapeHtml(emptyText)}</li>`;
}

function renderChores() {
  renderSimpleList("chore", "chores-list", "No chores yet.");
}

function renderShopping() {
  renderSimpleList("shopping", "shopping-list", "Shopping list is empty.");
}

function renderMeals() {
  renderSimpleList("meal", "meal-list", "Nothing planned for today.");
}

function renderBudget() {
  renderSimpleList("budget", "budget-list", "Track shared family expenses here.");
}

function setupInlineAdd(toggleId, formId, inputId, type, renderFn) {
  const toggle = document.getElementById(toggleId);
  const form = document.getElementById(formId);
  const input = document.getElementById(inputId);

  toggle.addEventListener("click", () => {
    form.classList.remove("hidden");
    toggle.classList.add("hidden");
    input.focus();
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const title = input.value.trim();
    if (!title) return;

    const entry = { id: generateId(), type, title, createdAt: new Date().toISOString() };
    addEntry(entry);
    renderFn();
    notifyMake(entry);
    form.reset();
    form.classList.add("hidden");
    toggle.classList.remove("hidden");
  });
}

// ---------- Toast (temporary success indicator) ----------

let toastTimer = null;

function showToast(message) {
  let toast = document.getElementById("toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toast";
    toast.className = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2500);
}

// ---------- Floating Action Button + bottom sheet (Calendar Event only) ----------

// Holds the event already saved locally while its Make.com sync is in
// flight or being retried, so a retry never creates a duplicate entry.
let pendingEventEntry = null;

function resetEventForm() {
  const form = document.getElementById("sheet-form-event");
  const submitBtn = document.getElementById("sheet-event-submit");
  const statusEl = document.getElementById("sheet-event-status");

  pendingEventEntry = null;
  form.reset();
  submitBtn.disabled = false;
  submitBtn.textContent = "Add Event";
  statusEl.textContent = "";
}

function openSheet() {
  document.getElementById("sheet-overlay").classList.add("open");
}

function closeSheet() {
  document.getElementById("sheet-overlay").classList.remove("open");
  resetEventForm();
}

function setupFab() {
  const overlay = document.getElementById("sheet-overlay");

  document.getElementById("fab-add").addEventListener("click", openSheet);
  document.getElementById("sheet-cancel").addEventListener("click", closeSheet);

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeSheet();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && overlay.classList.contains("open")) closeSheet();
  });
}

function setupEventForm() {
  const form = document.getElementById("sheet-form-event");
  const submitBtn = document.getElementById("sheet-event-submit");
  const statusEl = document.getElementById("sheet-event-status");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    // Build + save locally only on the first attempt; a retry after a
    // failed sync reuses the same pending entry instead of duplicating it.
    if (!pendingEventEntry) {
      const title = document.getElementById("sheet-event-title").value.trim();
      if (!title) return;

      pendingEventEntry = {
        id: generateId(),
        type: "event",
        title,
        date: document.getElementById("sheet-event-date").value || null,
        time: document.getElementById("sheet-event-time").value || null,
        notes: document.getElementById("sheet-event-notes").value.trim() || null,
        createdAt: new Date().toISOString(),
      };

      addEntry(pendingEventEntry);
      renderCalendar();
    }

    if (!CALENDAR_EVENT_WEBHOOK_URL) {
      closeSheet();
      showToast("Event added ✓");
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Syncing…";
    statusEl.textContent = "";

    try {
      const response = await fetch(CALENDAR_EVENT_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: pendingEventEntry.title,
          date: pendingEventEntry.date,
          time: pendingEventEntry.time,
          notes: pendingEventEntry.notes,
        }),
      });
      if (!response.ok) throw new Error(`Webhook responded ${response.status}`);

      closeSheet();
      showToast("Event added · sent to Make.com ✓");
    } catch {
      submitBtn.disabled = false;
      submitBtn.textContent = "Retry Sync";
      statusEl.textContent = "Saved locally — couldn't reach Make.com.";
    }
  });
}

// ---------- Calendar Sync tile ----------

let remoteCalendarData = { lastSynced: null, events: [] };
let calendarCursor = startOfMonth(new Date());
let calendarExpanded = false;
let lastEventCount = 0;

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function formatDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Some sync sources append a raw date or ISO timestamp to the title (e.g.
// "Natalie Debate - 2026-07-07" or "School Off - 2026-09-14T16:00:00.000Z")
// — strip that off so only the human-readable title ever renders. Applied
// both when a synced row is parsed and again right before render, as a
// defensive double-check.
function cleanEventTitle(title) {
  if (!title) return title;
  return title
    .replace(/\s*[-–—]\s*\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)?\s*$/i, "")
    .trim();
}

function getVisibleEvents() {
  const localEvents = loadEntries()
    .filter((entry) => entry.type === "event")
    .map((entry) => ({ id: entry.id, title: entry.title, date: entry.date, time: entry.time, local: true }));

  const dismissedIds = loadDismissedSyncIds();
  const remoteEvents = (remoteCalendarData.events || [])
    .filter((event) => !dismissedIds.includes(event.id))
    .map((event) => ({
      id: event.id || null,
      title: cleanEventTitle(event.title),
      date: event.date || null,
      time: event.time || null,
      notes: event.notes || null,
      local: false,
    }));

  return [...localEvents, ...remoteEvents];
}

function renderSyncMeta(eventCount) {
  lastEventCount = eventCount;
  const metaEl = document.getElementById("calendar-sync-meta");

  let statusText;
  if (remoteCalendarData.lastSynced) {
    statusText = `Last synced ${new Date(remoteCalendarData.lastSynced).toLocaleString()}`;
  } else if (eventCount) {
    statusText = "Not synced with Google Calendar yet";
  } else {
    statusText = "Not connected yet";
  }

  const hint = calendarExpanded ? "tap to collapse" : "tap to view month grid";
  metaEl.textContent = `${statusText} · ${hint}`;
}

function renderEventChip(event) {
  const title = cleanEventTitle(event.title);
  return `
    <div class="calendar-event"${event.notes ? ` title="${escapeHtml(event.notes)}"` : ""}>
      <span class="calendar-event-title">${escapeHtml(title)}${event.time ? ` · ${escapeHtml(event.time)}` : ""}</span>
      <button type="button" class="delete-btn" data-delete-id="${escapeHtml(event.id)}" aria-label="Delete ${escapeHtml(title)}">🗑️</button>
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
      .map((event) => {
        const title = cleanEventTitle(event.title);
        return `
      <div class="entry-row">
        <span class="entry-row-content">
          ${event.local ? '<span class="badge-local">local</span>' : ""}
          <span>${escapeHtml(title)}</span>
        </span>
        <button type="button" class="delete-btn" data-delete-id="${escapeHtml(event.id)}" aria-label="Delete ${escapeHtml(title)}">🗑️</button>
      </div>
    `;
      })
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
  refreshCalendarBodyHeight();
}

// ---------- Collapsible calendar body ----------

function refreshCalendarBodyHeight() {
  if (!calendarExpanded) return;
  const body = document.getElementById("calendar-body");
  body.style.maxHeight = `${body.scrollHeight}px`;
}

function setCalendarExpanded(expanded) {
  calendarExpanded = expanded;
  const toggle = document.getElementById("calendar-toggle");
  const body = document.getElementById("calendar-body");

  toggle.setAttribute("aria-expanded", String(expanded));
  body.style.maxHeight = expanded ? `${body.scrollHeight}px` : "0px";
  renderSyncMeta(lastEventCount);
}

function setupCalendarToggle() {
  document.getElementById("calendar-toggle").addEventListener("click", () => {
    setCalendarExpanded(!calendarExpanded);
  });
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

// Some sync sources (e.g. Make.com writing a full datetime into a Date or
// Time cell) produce values like "2026-07-05T06:00:00.000Z" instead of a
// plain date or time. Detect that shape so both normalizers can convert it
// to the viewer's local date/time instead of falling through unparsed.
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function normalizeSheetDate(raw) {
  if (!raw) return null;
  const value = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

  if (ISO_DATETIME_RE.test(value)) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : formatDateKey(parsed);
  }

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

  if (ISO_DATETIME_RE.test(value)) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    return `${String(parsed.getHours()).padStart(2, "0")}:${String(parsed.getMinutes()).padStart(2, "0")}`;
  }

  const match = value.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM|am|pm)?$/);
  if (!match) return null; // unrecognized format — never leak raw text into the UI

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
    .map((cells) => {
      const title = cleanEventTitle(cells[titleIndex].trim());
      const date = dateIndex >= 0 ? normalizeSheetDate(cells[dateIndex]) : null;
      const time = timeIndex >= 0 ? normalizeSheetTime(cells[timeIndex]) : null;
      return {
        // Content-derived (not row-index-based) so a dismissed event stays
        // dismissed across re-syncs even if the Sheet's row order shifts.
        id: `sheet:${title}|${date || ""}|${time || ""}`,
        title,
        date,
        time,
        notes: notesIndex >= 0 ? (cells[notesIndex] || "").trim() : "",
        local: false,
      };
    });
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

// How often to re-fetch the Sheet while the app is open and visible, so
// changes made in Google Calendar show up without a manual reload. Paused
// while the tab/app is backgrounded to avoid wasting battery/network.
const CALENDAR_REFRESH_INTERVAL_MS = 3 * 60 * 1000;

function setupCalendarAutoRefresh() {
  let intervalId = null;

  function startPolling() {
    if (intervalId) return;
    intervalId = setInterval(loadCalendarEvents, CALENDAR_REFRESH_INTERVAL_MS);
  }

  function stopPolling() {
    clearInterval(intervalId);
    intervalId = null;
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      loadCalendarEvents(); // catch up immediately on returning to the app
      startPolling();
    } else {
      stopPolling();
    }
  });

  startPolling();
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

ensureSeeded();
setupFab();
setupEventForm();
setupInlineAdd("chore-add-toggle", "chore-add-form", "chore-add-input", "chore", renderChores);
setupInlineAdd("shopping-add-toggle", "shopping-add-form", "shopping-add-input", "shopping", renderShopping);
setupInlineAdd("meal-add-toggle", "meal-add-form", "meal-add-input", "meal", renderMeals);
setupInlineAdd("budget-add-toggle", "budget-add-form", "budget-add-input", "budget", renderBudget);
setupCalendarNav();
setupCalendarToggle();
setupDeleteDelegation();
renderChores();
renderShopping();
renderMeals();
renderBudget();
loadCalendarEvents();
setupCalendarAutoRefresh();
registerServiceWorker();
