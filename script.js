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
const CALENDAR_EVENT_WEBHOOK_URL = "";

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
const CALENDAR_SHEET_CSV_URL = "";

// ---------- Direct Google Calendar API (replaces the Sheet/webhook flow
// above once configured) ----------
// Get GOOGLE_OAUTH_CLIENT_ID from Google Cloud Console: APIs & Services >
// Credentials > Create Credentials > OAuth client ID > Web application,
// with this site's origin (e.g. https://yourname.github.io) added under
// Authorized JavaScript origins. Leave it blank to keep using the Sheet
// CSV read / Make.com webhook write flow above exactly as-is — this
// feature does nothing at all until a Client ID is set, so it's always
// safe to leave unconfigured.
const GOOGLE_OAUTH_CLIENT_ID =
  "348927170919-rca6m1vh04emkv48vaggipbpjn77sg3r.apps.googleusercontent.com";

// Pinned to the actual family calendar's account rather than "primary" —
// "primary" would mean each signed-in person sees their OWN calendar, not
// the shared family one. Anyone else who signs in (a helper, etc.) needs
// this calendar shared with their Google account first (Google Calendar >
// this calendar's Settings and sharing > Share with specific people).
const GOOGLE_CALENDAR_ID = "family489764@gmail.com";

const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";

// Bump this whenever sw.js changes so phones re-fetch it instead of serving
// a stale cached copy (must match CACHE_NAME's version in sw.js).
const SW_VERSION = "v27";

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
    if (id.startsWith("google:")) {
      deleteGoogleCalendarEvent(id);
    } else if (id.startsWith("sheet:")) {
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

// Make.com's Google Calendar "Create an Event" module requires an end time.
// Default to one hour after the start time (wrapping past midnight if
// needed); for an all-day-ish entry with no start time, use 00:00–23:59.
function computeEndTime(startTime) {
  if (!startTime) return "23:59";
  const [hour, minute] = startTime.split(":").map(Number);
  const endMinutes = (hour * 60 + minute + 60) % (24 * 60);
  const endHour = Math.floor(endMinutes / 60);
  const endMinute = endMinutes % 60;
  return `${String(endHour).padStart(2, "0")}:${String(endMinute).padStart(2, "0")}`;
}

function setupEventForm() {
  const form = document.getElementById("sheet-form-event");
  const submitBtn = document.getElementById("sheet-event-submit");
  const statusEl = document.getElementById("sheet-event-status");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    // Signed into Google: create the event directly via the Calendar API.
    // Google is the source of truth here, so skip local storage entirely
    // and just re-fetch afterward — no separate "sheet:"/local dedup needed.
    if (googleAccessToken) {
      const title = document.getElementById("sheet-event-title").value.trim();
      if (!title) return;

      const startTime = document.getElementById("sheet-event-time").value || null;
      const entry = {
        title,
        date: document.getElementById("sheet-event-date").value || null,
        time: startTime,
        endTime: startTime ? computeEndTime(startTime) : null,
        notes: document.getElementById("sheet-event-notes").value.trim() || null,
      };

      submitBtn.disabled = true;
      submitBtn.textContent = "Syncing…";
      statusEl.textContent = "";

      try {
        await createGoogleCalendarEvent(entry);
        closeSheet();
        showToast("Event added to Google Calendar ✓");
        loadCalendarEvents();
      } catch {
        submitBtn.disabled = false;
        submitBtn.textContent = "Retry Sync";
        statusEl.textContent = "Couldn't reach Google Calendar — try again.";
      }
      return;
    }

    // Build + save locally only on the first attempt; a retry after a
    // failed sync reuses the same pending entry instead of duplicating it.
    if (!pendingEventEntry) {
      const title = document.getElementById("sheet-event-title").value.trim();
      if (!title) return;

      const startTime = document.getElementById("sheet-event-time").value || null;

      pendingEventEntry = {
        id: generateId(),
        type: "event",
        title,
        date: document.getElementById("sheet-event-date").value || null,
        time: startTime,
        endTime: startTime ? computeEndTime(startTime) : null,
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
          time: pendingEventEntry.time || "00:00",
          end_time: computeEndTime(pendingEventEntry.time),
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

// ---------- Direct Google Calendar API auth ----------

// Access tokens from Google last ~1 hour. Without this, googleAccessToken
// would only ever live in a JS variable, so any page reload (mobile browsers
// routinely reload backgrounded tabs) would silently sign you out.
const GOOGLE_TOKEN_STORAGE_KEY = "familyAdminGoogleToken";

function saveGoogleToken(token, expiresInSeconds) {
  localStorage.setItem(
    GOOGLE_TOKEN_STORAGE_KEY,
    JSON.stringify({ token, expiresAt: Date.now() + expiresInSeconds * 1000 })
  );
}

function loadStoredGoogleToken() {
  try {
    const stored = JSON.parse(localStorage.getItem(GOOGLE_TOKEN_STORAGE_KEY));
    if (stored && stored.expiresAt > Date.now()) return stored.token;
  } catch {
    // ignore
  }
  return null;
}

function clearStoredGoogleToken() {
  localStorage.removeItem(GOOGLE_TOKEN_STORAGE_KEY);
}

let googleAccessToken = loadStoredGoogleToken();
let googleTokenClient = null;

function updateGoogleSignInUI() {
  const signInBtn = document.getElementById("google-sign-in");
  const signOutBtn = document.getElementById("google-sign-out");
  if (!signInBtn || !signOutBtn) return;

  const configured = !!GOOGLE_OAUTH_CLIENT_ID;
  signInBtn.classList.toggle("hidden", !configured || !!googleAccessToken);
  signOutBtn.classList.toggle("hidden", !configured || !googleAccessToken);
}

function handleGoogleSignIn() {
  if (!googleTokenClient) return;
  googleTokenClient.requestAccessToken();
}

function handleGoogleSignOut() {
  if (googleAccessToken && window.google?.accounts?.oauth2) {
    google.accounts.oauth2.revoke(googleAccessToken, () => {});
  }
  googleAccessToken = null;
  clearStoredGoogleToken();
  updateGoogleSignInUI();
  loadCalendarEvents();
}

function initGoogleAuth() {
  updateGoogleSignInUI();
  document.getElementById("google-sign-in").addEventListener("click", handleGoogleSignIn);
  document.getElementById("google-sign-out").addEventListener("click", handleGoogleSignOut);

  if (!GOOGLE_OAUTH_CLIENT_ID) return; // feature not configured — stays fully inactive

  const trySetup = () => {
    if (!window.google?.accounts?.oauth2) {
      setTimeout(trySetup, 200);
      return;
    }
    googleTokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_OAUTH_CLIENT_ID,
      scope: GOOGLE_CALENDAR_SCOPE,
      callback: (response) => {
        if (response.error) {
          showToast("Google sign-in failed");
          return;
        }
        googleAccessToken = response.access_token;
        saveGoogleToken(response.access_token, response.expires_in);
        updateGoogleSignInUI();
        loadCalendarEvents();
      },
    });
  };

  trySetup();
}

function getLocalTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function combineDateTime(date, time) {
  return `${date}T${time}:00`;
}

function formatTimeFromDate(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

async function createGoogleCalendarEvent(entry) {
  const timeZone = getLocalTimeZone();
  const body = entry.time
    ? {
        summary: entry.title,
        description: entry.notes || undefined,
        start: { dateTime: combineDateTime(entry.date, entry.time), timeZone },
        end: { dateTime: combineDateTime(entry.date, entry.endTime || computeEndTime(entry.time)), timeZone },
      }
    : {
        summary: entry.title,
        description: entry.notes || undefined,
        start: { date: entry.date },
        end: { date: entry.date },
      };

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(GOOGLE_CALENDAR_ID)}/events`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${googleAccessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
  if (!response.ok) throw new Error(`Calendar API responded ${response.status}`);
  return response.json();
}

async function deleteGoogleCalendarEvent(id) {
  const eventId = id.slice("google:".length);
  try {
    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(GOOGLE_CALENDAR_ID)}/events/${encodeURIComponent(eventId)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${googleAccessToken}` },
      }
    );
    // 410 Gone means it was already deleted — treat as success.
    if (!response.ok && response.status !== 410) throw new Error(`Calendar API responded ${response.status}`);
    showToast("Event deleted from Google Calendar ✓");
    loadCalendarEvents();
  } catch {
    showToast("Couldn't delete — check your connection");
  }
}

function mapGoogleEventToLocal(item) {
  const start = item.start || {};
  const end = item.end || {};
  const isAllDay = !!start.date && !start.dateTime;

  let date = null;
  let time = null;
  let endTime = null;

  if (isAllDay) {
    date = start.date;
  } else if (start.dateTime) {
    const startDate = new Date(start.dateTime);
    date = formatDateKey(startDate);
    time = formatTimeFromDate(startDate);
    if (end.dateTime) endTime = formatTimeFromDate(new Date(end.dateTime));
  }

  return {
    id: `google:${item.id}`,
    title: cleanEventTitle(item.summary || "(untitled)"),
    date,
    time,
    endTime,
    notes: item.description || null,
    local: false,
  };
}

// Google returns one page (up to maxResults) per request. Recurring events
// get expanded into individual instances by singleEvents, so a busy calendar
// can exhaust a single page well before reaching future months — follow
// nextPageToken until Google says there's nothing left. The 20-page cap
// (~5000 events) just guards against an unbounded loop; no real family
// calendar should ever get close to it.
async function fetchGoogleCalendarPage(timeMin, pageToken) {
  const params = new URLSearchParams({
    singleEvents: "true",
    orderBy: "startTime",
    timeMin: timeMin.toISOString(),
    maxResults: "250",
  });
  if (pageToken) params.set("pageToken", pageToken);

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(GOOGLE_CALENDAR_ID)}/events?${params.toString()}`,
    { headers: { Authorization: `Bearer ${googleAccessToken}` } }
  );

  if (response.status === 401) {
    googleAccessToken = null;
    clearStoredGoogleToken();
    updateGoogleSignInUI();
    throw new Error("Google auth expired");
  }
  if (!response.ok) throw new Error(`Calendar API responded ${response.status}`);

  return response.json();
}

async function loadCalendarEventsFromGoogleApi() {
  try {
    const timeMin = new Date();
    timeMin.setMonth(timeMin.getMonth() - 2);

    const items = [];
    let pageToken;
    for (let page = 0; page < 20; page++) {
      const data = await fetchGoogleCalendarPage(timeMin, pageToken);
      items.push(...(data.items || []));
      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }

    remoteCalendarData = {
      lastSynced: new Date().toISOString(),
      events: items.map(mapGoogleEventToLocal),
    };
    lastSyncError = null;
  } catch (err) {
    console.error("Google Calendar sync failed:", err);
    // A 401 above already cleared googleAccessToken (real sign-out) — wipe
    // the view in that case. Anything else is a transient hiccup (network
    // blip, rate limit), so keep showing the last data that did load
    // instead of blanking the whole calendar over one failed refresh.
    if (!googleAccessToken) {
      remoteCalendarData = { lastSynced: null, events: [] };
      lastSyncError = null;
    } else {
      lastSyncError = err.message;
      showToast(`Sync failed: ${err.message}`);
    }
  }
  renderCalendar();
}

// ---------- Calendar Sync tile ----------

let remoteCalendarData = { lastSynced: null, events: [] };
// Kept separately from the toast so a failed sync stays visible in the
// status line — screenshots taken well after the fact still show the
// real reason instead of just "Not synced yet".
let lastSyncError = null;
let calendarCursor = startOfMonth(new Date());
let calendarExpanded = false;
let lastEventCount = 0;

// "month" = compact overview (tap a day to zoom in); "day" = full detail
// list for one date (tap back to zoom out).
let calendarViewMode = "month";
let selectedDayKey = null;

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

function dateFromKey(key) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
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
    .map((entry) => ({
      id: entry.id,
      title: entry.title,
      date: entry.date,
      time: entry.time,
      endTime: entry.endTime || null,
      local: true,
    }));

  const dismissedIds = loadDismissedSyncIds();
  const remoteEvents = (remoteCalendarData.events || [])
    .filter((event) => !dismissedIds.includes(event.id))
    .map((event) => ({
      id: event.id || null,
      title: cleanEventTitle(event.title),
      date: event.date || null,
      time: event.time || null,
      endTime: event.endTime || null,
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

  if (lastSyncError && googleAccessToken) {
    statusText += ` — sync error: ${lastSyncError}`;
  }

  const hint = calendarExpanded ? "tap to collapse" : "tap to view month grid";
  metaEl.textContent = `${statusText} · ${hint}`;
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
    const count = (eventsByDate[key] || []).length;

    html += `
      <button
        type="button"
        class="calendar-day${key === todayKey ? " is-today" : ""}${count ? " has-events" : ""}"
        data-day-key="${key}"
        ${count ? "" : "disabled"}
      >
        <span class="calendar-day-number">${dayNumber}</span>
        ${count ? `<span class="calendar-day-count">${count}</span>` : ""}
      </button>
    `;
  }

  grid.innerHTML = html;
}

function renderDayViewRow(event) {
  const title = cleanEventTitle(event.title);
  const timeLabel = event.time ? (event.endTime ? `${event.time}–${event.endTime}` : event.time) : "No time set";
  return `
    <div class="day-view-row">
      <div class="day-view-row-main">
        <span class="entry-row-content">
          ${event.local ? '<span class="badge-local">local</span>' : ""}
          <span>${escapeHtml(title)}</span>
        </span>
        <button type="button" class="delete-btn" data-delete-id="${escapeHtml(event.id)}" aria-label="Delete ${escapeHtml(title)}">🗑️</button>
      </div>
      <div class="day-view-row-meta">${escapeHtml(timeLabel)}</div>
      ${event.notes ? `<div class="day-view-row-notes">${escapeHtml(event.notes)}</div>` : ""}
    </div>
  `;
}

function renderDayView(dayKey, eventsByDate) {
  const container = document.getElementById("calendar-day-view");
  const events = eventsByDate[dayKey] || [];
  const heading = dateFromKey(dayKey).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  container.innerHTML = `
    <div class="day-view-header">
      <button type="button" class="calendar-nav-btn" id="calendar-day-back" aria-label="Back to month">‹</button>
      <span>${escapeHtml(heading)}</span>
    </div>
    <div class="day-view-list">
      ${events.length ? events.map(renderDayViewRow).join("") : '<p class="tile-empty">No events on this day.</p>'}
    </div>
  `;

  document.getElementById("calendar-day-back").addEventListener("click", () => {
    calendarViewMode = "month";
    selectedDayKey = null;
    renderCalendar();
  });
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

  const isDayMode = calendarViewMode === "day" && selectedDayKey;
  document.getElementById("calendar-header").classList.toggle("hidden", isDayMode);
  document.getElementById("calendar-weekdays").classList.toggle("hidden", isDayMode);
  document.getElementById("calendar-grid").classList.toggle("hidden", isDayMode);
  document.getElementById("calendar-unscheduled").classList.toggle("hidden", isDayMode);
  document.getElementById("calendar-day-view").classList.toggle("hidden", !isDayMode);
  if (isDayMode) renderDayView(selectedDayKey, eventsByDate);

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
  const endTimeIndex = headers.indexOf("end time");
  const notesIndex = headers.indexOf("notes");

  return rows
    .slice(1)
    .filter((cells) => cells[titleIndex] && cells[titleIndex].trim())
    .map((cells) => {
      const title = cleanEventTitle(cells[titleIndex].trim());
      const date = dateIndex >= 0 ? normalizeSheetDate(cells[dateIndex]) : null;
      const time = timeIndex >= 0 ? normalizeSheetTime(cells[timeIndex]) : null;
      const endTime = endTimeIndex >= 0 ? normalizeSheetTime(cells[endTimeIndex]) : null;
      return {
        // Content-derived (not row-index-based) so a dismissed event stays
        // dismissed across re-syncs even if the Sheet's row order shifts.
        id: `sheet:${title}|${date || ""}|${time || ""}`,
        title,
        date,
        time,
        endTime,
        notes: notesIndex >= 0 ? (cells[notesIndex] || "").trim() : "",
        local: false,
      };
    });
}

async function loadCalendarEvents() {
  if (googleAccessToken) {
    return loadCalendarEventsFromGoogleApi();
  }

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
    calendarViewMode = "month";
    renderCalendar();
  });
  document.getElementById("cal-next").addEventListener("click", () => {
    calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() + 1, 1);
    calendarViewMode = "month";
    renderCalendar();
  });
}

function setupCalendarDayClick() {
  document.getElementById("calendar-grid").addEventListener("click", (event) => {
    const button = event.target.closest(".calendar-day.has-events");
    if (!button) return;
    selectedDayKey = button.dataset.dayKey;
    calendarViewMode = "day";
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
initGoogleAuth();
setupFab();
setupEventForm();
setupInlineAdd("chore-add-toggle", "chore-add-form", "chore-add-input", "chore", renderChores);
setupInlineAdd("shopping-add-toggle", "shopping-add-form", "shopping-add-input", "shopping", renderShopping);
setupInlineAdd("meal-add-toggle", "meal-add-form", "meal-add-input", "meal", renderMeals);
setupInlineAdd("budget-add-toggle", "budget-add-form", "budget-add-input", "budget", renderBudget);
setupCalendarNav();
setupCalendarDayClick();
setupCalendarToggle();
setupDeleteDelegation();
renderChores();
renderShopping();
renderMeals();
renderBudget();
loadCalendarEvents();
setupCalendarAutoRefresh();
registerServiceWorker();
