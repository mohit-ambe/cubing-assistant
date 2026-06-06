const STORAGE_KEY = "cubingAssistant.timerState";
const PLAYGROUND_SESSION_ID = "playground";
const EVENTS = [["222", "2x2"], ["333", "3x3"], ["444", "4x4"], ["555", "5x5"], ["666", "6x6"], ["777", "7x7"], ["333oh", "3x3 OH"], ["333bf", "3x3 Blindfolded"], ["333fm", "3x3 Fewest Moves"], ["333mbf", "3x3 Multi-Blind"], ["clock", "Clock"], ["minx", "Megaminx"], ["pyram", "Pyraminx"], ["skewb", "Skewb"], ["sq1", "Square-1"],];
const CSTIMER_EVENTS = {
    "222so": "222",
    "333": "333",
    "333oh": "333oh",
    "333ni": "333bf",
    "333fm": "333fm",
    "r3ni": "333mbf",
    "444wca": "444",
    "555wca": "555",
    "666wca": "666",
    "777wca": "777",
    "clkwca": "clock",
    "mgmp": "minx",
    "pyrso": "pyram",
    "skbso": "skewb",
    "sqrs": "sq1",
};

const state = {
    sessions: [], solves: [], sessionScrambleIndexes: {}, selectedSessionId: PLAYGROUND_SESSION_ID, stagedSessions: []
};
const sessionListEl = document.querySelector("#sessionList");
const sessionDetailEl = document.querySelector("#sessionDetail");
const searchEl = document.querySelector("#sessionSearch");
const filterEl = document.querySelector("#eventFilter");
const sessionDialogEl = document.querySelector("#sessionDialog");
const sessionDialogTitleEl = document.querySelector("#sessionDialogTitle");
const sessionNameEl = document.querySelector("#sessionName");
const sessionEventEl = document.querySelector("#sessionEvent");
const importDialogEl = document.querySelector("#importDialog");
const cstimerFileEl = document.querySelector("#cstimerFile");
const importRowsEl = document.querySelector("#importRows");
const importSummaryEl = document.querySelector("#importSummary");
const importErrorEl = document.querySelector("#importError");
const commitImportEl = document.querySelector("#commitImport");
const confirmDialogEl = document.querySelector("#confirmDialog");
const confirmTitleEl = document.querySelector("#confirmTitle");
const confirmTextEl = document.querySelector("#confirmText");
let pendingConfirm = null;

init();

async function init() {
    loadState();
    renderEventOptions();
    bindEvents();
    render();
    await pullRemoteState();
}

function bindEvents() {
    searchEl.addEventListener("input", renderSessionList);
    filterEl.addEventListener("change", renderSessionList);
    document.querySelector("#newSession").addEventListener("click", openCreateDialog);
    document.querySelector("#importCstimer").addEventListener("click", () => importDialogEl.showModal());
    document.querySelector("#exportBackup").addEventListener("click", exportBackup);
    document.querySelector("#saveSession").addEventListener("click", saveCreatedSession);
    cstimerFileEl.addEventListener("change", readCstimerFile);
    commitImportEl.addEventListener("click", commitImport);
    sessionListEl.addEventListener("click", (event) => {
        const item = event.target.closest("[data-session-id]");
        if (!item) return;
        state.selectedSessionId = item.dataset.sessionId;
        render();
    });
    sessionDetailEl.addEventListener("click", onDetailAction);
    document.querySelector("#confirmAction").addEventListener("click", () => {
        if (pendingConfirm) pendingConfirm();
        pendingConfirm = null;
    });
}

function loadState() {
    const raw = localStorage.getItem(STORAGE_KEY);
    let saved = {};
    try {
        saved = raw ? JSON.parse(raw) : {};
    } catch {
        saved = {};
    }
    state.sessions = normalizeSessions(saved.sessions);
    state.solves = Array.isArray(saved.solves) ? saved.solves : [];
    state.sessionScrambleIndexes = saved.sessionScrambleIndexes || {};
    state.selectedSessionId = getVisibleSessions().some((session) => session.id === saved.activeSessionId) ? saved.activeSessionId : PLAYGROUND_SESSION_ID;
}

function normalizeSessions(sessions) {
    const playground = {id: PLAYGROUND_SESSION_ID, name: "Playground", event: null, createdAt: 0, updatedAt: 0};
    const named = Array.isArray(sessions) ? sessions.filter((session) => session.id && session.id !== PLAYGROUND_SESSION_ID) : [];
    return [playground, ...named];
}

function saveState() {
    const raw = localStorage.getItem(STORAGE_KEY);
    let saved = {};
    try {
        saved = raw ? JSON.parse(raw) : {};
    } catch {
        saved = {};
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
        ...saved, sessions: state.sessions, solves: state.solves, sessionScrambleIndexes: state.sessionScrambleIndexes
    }));
    pushRemoteState();
}

function renderEventOptions() {
    filterEl.innerHTML = '<option value="all">All formats</option>';
    sessionEventEl.replaceChildren();
    EVENTS.forEach(([id, label]) => {
        filterEl.append(new Option(label, id));
        sessionEventEl.append(new Option(label, id));
    });
}

function render() {
    renderSessionList();
    renderSessionDetail();
}

function renderSessionList() {
    const query = searchEl.value.trim().toLowerCase();
    const event = filterEl.value;
    const sessions = getVisibleSessions().filter((session) => {
        const matchesText = session.name.toLowerCase().includes(query);
        const matchesEvent = event === "all" || session.event === event || session.id === PLAYGROUND_SESSION_ID;
        return matchesText && matchesEvent;
    });
    sessionListEl.replaceChildren();
    sessions.forEach((session) => {
        const solves = getSessionSolves(session.id);
        const item = document.createElement("li");
        item.className = `session-item ${session.id === state.selectedSessionId ? "active" : ""}`;
        item.dataset.sessionId = session.id;
        item.innerHTML = `<div class="session-title-row"><span class="session-title"></span><span class="session-badge"></span></div><div class="session-meta"></div>`;
        item.querySelector(".session-title").textContent = session.name;
        item.querySelector(".session-badge").textContent = session.id === PLAYGROUND_SESSION_ID ? "FLEX" : getEventLabel(session.event);
        item.querySelector(".session-meta").textContent = `${solves.length} solves${solves.length ? ` · ${formatDate(getLastSolveAt(solves))}` : ""}`;
        sessionListEl.append(item);
    });
}

function renderSessionDetail() {
    const session = getSelectedSession();
    const solves = getSessionSolves(session.id);
    sessionDetailEl.innerHTML = `
    <div class="detail-heading">
      <div><h2></h2><p></p></div>
      <div class="detail-actions">
        ${session.id === PLAYGROUND_SESSION_ID ? "" : '<button data-action="rename"><span class="material-symbols-outlined">edit</span> Rename</button>'}
        <button data-action="export"><span class="material-symbols-outlined">download</span> Export</button>
        ${session.id === PLAYGROUND_SESSION_ID ? "" : '<button data-action="merge"><span class="material-symbols-outlined">merge</span> Merge</button><button class="danger" data-action="delete"><span class="material-symbols-outlined">delete</span> Delete</button>'}
      </div>
    </div>
    <div class="summary-grid">
      <div class="summary-cell"><span>Cube type</span><strong></strong></div>
      <div class="summary-cell"><span>Solves</span><strong>${solves.length}</strong></div>
      <div class="summary-cell"><span>Last solve</span><strong>${solves.length ? formatDate(getLastSolveAt(solves)) : "--"}</strong></div>
    </div>
    <div class="solve-section"><h3>Recent solves</h3><div class="solve-table-wrap"><table><thead><tr><th>Date</th><th>Time</th><th>Penalty</th><th>Scramble</th></tr></thead><tbody></tbody></table></div></div>`;
    sessionDetailEl.querySelector("h2").textContent = session.name;
    sessionDetailEl.querySelector(".detail-heading p").textContent = session.id === PLAYGROUND_SESSION_ID ? "Flexible scratch session" : "Fixed-format practice session";
    sessionDetailEl.querySelector(".summary-cell strong").textContent = session.id === PLAYGROUND_SESSION_ID ? "Flexible" : getEventLabel(session.event);
    const tbody = sessionDetailEl.querySelector("tbody");
    solves.slice(0, 100).forEach((solve) => {
        const row = document.createElement("tr");
        row.append(cell(formatDateTime(solve.createdAt)), cell(formatTime(solve.timeMs)), cell(solve.penalty || "OK"), cell(solve.scramble || "", "scramble-cell"));
        tbody.append(row);
    });
    if (!solves.length) tbody.append(cellRow("No solves in this session."));
}

function onDetailAction(event) {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (!action) return;
    const session = getSelectedSession();
    if (action === "export") return exportSession(session);
    if (action === "rename") return renameSession(session);
    if (action === "merge") return mergeSession(session);
    if (action === "delete") return confirmDeleteSession(session);
}

function openCreateDialog() {
    sessionDialogTitleEl.textContent = "New session";
    sessionNameEl.value = "";
    sessionEventEl.value = "333";
    sessionDialogEl.showModal();
}

function saveCreatedSession(event) {
    event.preventDefault();
    const name = sessionNameEl.value.trim();
    if (!name) return;
    const now = Date.now();
    const session = {id: crypto.randomUUID(), name, event: sessionEventEl.value, createdAt: now, updatedAt: now};
    state.sessions.push(session);
    state.selectedSessionId = session.id;
    sessionDialogEl.close();
    saveState();
    render();
}

function renameSession(session) {
    const name = window.prompt("Session name", session.name)?.trim();
    if (!name || name === session.name) return;
    session.name = name;
    session.updatedAt = Date.now();
    saveState();
    render();
}

function mergeSession(source) {
    const targets = getVisibleSessions().filter((session) => session.id !== source.id && session.id !== PLAYGROUND_SESSION_ID && session.event === source.event);
    if (!targets.length) return window.alert("Create another session with the same cube type before merging.");
    const choices = targets.map((session, index) => `${index + 1}. ${session.name}`).join("\n");
    const index = Number(window.prompt(`Merge ${source.name} into which session?\n\n${choices}`)) - 1;
    const target = targets[index];
    if (!target) return;
    showConfirm("Merge sessions?", `${getSessionSolves(source.id).length} solves from ${source.name} will be appended to ${target.name}. The source session will remain available.`, () => {
        getSessionSolves(source.id).forEach((solve) => {
            solve.sessionId = target.id;
            solve.updatedAt = Date.now();
        });
        saveState();
        render();
    });
}

function confirmDeleteSession(session) {
    showConfirm("Delete session?", `${session.name} and its ${getSessionSolves(session.id).length} solves will be removed.`, () => {
        const deletedAt = Date.now();
        session.deletedAt = deletedAt;
        session.updatedAt = deletedAt;
        getSessionSolves(session.id).forEach((solve) => {
            solve.deletedAt = deletedAt;
            solve.updatedAt = deletedAt;
        });
        state.selectedSessionId = PLAYGROUND_SESSION_ID;
        saveState();
        render();
    });
}

function showConfirm(title, text, action) {
    confirmTitleEl.textContent = title;
    confirmTextEl.textContent = text;
    pendingConfirm = action;
    confirmDialogEl.showModal();
}

async function readCstimerFile() {
    resetImport();
    const file = cstimerFileEl.files[0];
    if (!file) return;
    try {
        const data = JSON.parse(await file.text());
        state.stagedSessions = parseCstimerBackup(data);
        if (!state.stagedSessions.length) throw new Error("No csTimer sessions were found.");
        renderImportRows();
    } catch (error) {
        importErrorEl.hidden = false;
        importErrorEl.textContent = `Could not read this backup: ${error.message}`;
    }
}

function parseCstimerBackup(data) {
    if (!data || typeof data !== "object") throw new Error("The file is not a JSON object.");
    let metadata = {};
    try {
        metadata = JSON.parse(data.properties?.sessionData || "{}");
    } catch {
        metadata = {};
    }
    return Object.keys(data).filter((key) => /^session\d+$/.test(key) && Array.isArray(data[key])).map((key) => {
        const number = key.replace("session", "");
        const meta = metadata[number] || {};
        const event = detectCstimerEvent(meta);
        if (data[key].some((solve) => !Array.isArray(solve) || !Array.isArray(solve[0]) || !Number.isFinite(Number(solve[0][1])))) {
            throw new Error(`${key} contains an invalid solve.`);
        }
        return {key, name: meta.name || `csTimer ${key}`, event, solves: data[key], action: "create", destination: ""};
    }).sort((a, b) => Number(a.key.replace("session", "")) - Number(b.key.replace("session", "")));
}

function detectCstimerEvent(meta) {
    const scrType = meta.opt?.scrType || "";
    if (CSTIMER_EVENTS[scrType]) return CSTIMER_EVENTS[scrType];
    const name = String(meta.name || "").toLowerCase();
    for (const [id, label] of EVENTS) if (name.includes(label.toLowerCase())) return id;
    return "333";
}

function renderImportRows() {
    const solveCount = state.stagedSessions.reduce((sum, session) => sum + session.solves.length, 0);
    importSummaryEl.textContent = `${state.stagedSessions.length} sessions and ${solveCount} solves detected. Review each destination before importing.`;
    importRowsEl.replaceChildren();
    state.stagedSessions.forEach((session, index) => {
        const row = document.createElement("tr");
        row.innerHTML = `<td><input data-field="name"></td><td><select data-field="event"></select></td><td></td><td><select data-field="action"><option value="create">Create new</option><option value="merge">Merge into existing</option><option value="skip">Skip</option></select></td><td><select data-field="destination"></select></td>`;
        row.querySelector('[data-field="name"]').value = session.name;
        const eventSelect = row.querySelector('[data-field="event"]');
        EVENTS.forEach(([id, label]) => eventSelect.append(new Option(label, id)));
        eventSelect.value = session.event;
        row.children[2].textContent = String(session.solves.length);
        const destination = row.querySelector('[data-field="destination"]');
        destination.append(new Option("New session", ""));
        getVisibleSessions().filter((entry) => entry.id !== PLAYGROUND_SESSION_ID).forEach((entry) => destination.append(new Option(`${entry.name} · ${getEventLabel(entry.event)}`, entry.id)));
        destination.disabled = true;
        row.querySelectorAll("[data-field]").forEach((control) => control.addEventListener("change", () => updateStagedSession(index, row)));
        importRowsEl.append(row);
    });
    commitImportEl.disabled = false;
}

function updateStagedSession(index, row) {
    const session = state.stagedSessions[index];
    session.name = row.querySelector('[data-field="name"]').value.trim();
    session.event = row.querySelector('[data-field="event"]').value;
    session.action = row.querySelector('[data-field="action"]').value;
    session.destination = row.querySelector('[data-field="destination"]').value;
    const destination = row.querySelector('[data-field="destination"]');
    destination.disabled = session.action !== "merge";
    if (session.action !== "merge") destination.value = "";
}

async function commitImport() {
    commitImportEl.disabled = true;
    importErrorEl.hidden = true;
    let created = 0, added = 0, duplicates = 0;
    const existingIds = new Set(state.solves.map((solve) => solve.id));
    for (const staged of state.stagedSessions) {
        if (staged.action === "skip") continue;
        let sessionId = staged.destination;
        if (staged.action === "merge" && !getVisibleSessions().some((session) => session.id === sessionId)) {
            importErrorEl.hidden = false;
            importErrorEl.textContent = `Choose a destination for ${staged.name}.`;
            commitImportEl.disabled = false;
            return;
        }
        const newSolves = [];
        for (const rawSolve of staged.solves) {
            const solve = await convertCstimerSolve(staged, sessionId, rawSolve);
            if (existingIds.has(solve.id)) {
                duplicates += 1;
                continue;
            }
            existingIds.add(solve.id);
            newSolves.push(solve);
        }
        if (!newSolves.length) continue;
        if (staged.action === "create") {
            const now = Date.now();
            sessionId = crypto.randomUUID();
            state.sessions.push({
                id: sessionId,
                name: staged.name || `${getEventLabel(staged.event)} import`,
                event: staged.event,
                createdAt: now,
                updatedAt: now
            });
            created += 1;
        }
        for (const solve of newSolves) {
            solve.sessionId = sessionId;
            state.solves.push(solve);
            added += 1;
        }
    }
    saveState();
    render();
    importDialogEl.close();
    window.alert(`Import complete: ${created} sessions created, ${added} solves added, ${duplicates} duplicates skipped.`);
    resetImport(true);
}

async function convertCstimerSolve(staged, sessionId, rawSolve) {
    if (!Array.isArray(rawSolve) || !Array.isArray(rawSolve[0])) throw new Error(`Invalid solve in ${staged.name}.`);
    const penaltyValue = Number(rawSolve[0][0]) || 0;
    const timeMs = Number(rawSolve[0][1]);
    const scramble = String(rawSolve[1] || "");
    const comment = String(rawSolve[2] || "");
    const timestampSeconds = Number(rawSolve[3]) || 0;
    const fingerprint = await sha256(["cstimer", staged.key, penaltyValue, timeMs, scramble, comment, timestampSeconds].join("\u001f"));
    return {
        id: `cstimer:${fingerprint}`,
        sessionId,
        event: staged.event,
        timeMs,
        scramble,
        comment,
        createdAt: timestampSeconds * 1000,
        updatedAt: timestampSeconds * 1000,
        penalty: penaltyValue < 0 ? "DNF" : penaltyValue > 0 ? "+2" : "OK",
        source: {provider: "cstimer", sessionKey: staged.key, fingerprint, importedAt: Date.now()},
    };
}

async function sha256(text) {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function resetImport(clearFile = false) {
    state.stagedSessions = [];
    importRowsEl.replaceChildren();
    importErrorEl.hidden = true;
    commitImportEl.disabled = true;
    if (clearFile) cstimerFileEl.value = "";
}

async function pullRemoteState() {
    try {
        const response = await fetch("/api/sync");
        if (!response.ok) return;
        mergeRemote(await response.json());
        saveState();
        render();
    } catch {
    }
}

async function pushRemoteState() {
    try {
        const response = await fetch("/api/sync", {
            method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(createSnapshot())
        });
        if (!response.ok) return;
        mergeRemote(await response.json());
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"),
            sessions: state.sessions,
            solves: state.solves,
            sessionScrambleIndexes: state.sessionScrambleIndexes
        }));
        render();
    } catch {
    }
}

function mergeRemote(remote) {
    state.solves = mergeById(state.solves, remote.solves || []);
    state.sessions = normalizeSessions(mergeById(state.sessions, remote.sessions || []));
    state.sessionScrambleIndexes = {...state.sessionScrambleIndexes, ...(remote.sessionScrambleIndexes || {})};
}

function mergeById(left, right) {
    const records = new Map();
    [...left, ...right].forEach((record) => {
        if (!record.id) return;
        const current = records.get(record.id);
        if (!current || updatedAt(record) >= updatedAt(current)) records.set(record.id, record);
    });
    return [...records.values()];
}

function updatedAt(record) {
    return Number(record.updatedAt || record.deletedAt || record.createdAt || 0);
}

function createSnapshot() {
    return {
        schemaVersion: 2,
        updatedAt: Date.now(),
        sessions: state.sessions,
        solves: state.solves,
        sessionScrambleIndexes: state.sessionScrambleIndexes,
        theme: getStoredTheme()
    };
}

function getVisibleSessions() {
    return state.sessions.filter((session) => !session.deletedAt);
}

function getSelectedSession() {
    return getVisibleSessions().find((session) => session.id === state.selectedSessionId) || getVisibleSessions()[0];
}

function getSessionSolves(sessionId) {
    return state.solves.filter((solve) => !solve.deletedAt && (solve.sessionId || PLAYGROUND_SESSION_ID) === sessionId).sort((a, b) => b.createdAt - a.createdAt);
}

function getLastSolveAt(solves) {
    return Math.max(...solves.map((solve) => Number(solve.createdAt) || 0));
}

function getEventLabel(id) {
    return EVENTS.find(([eventId]) => eventId === id)?.[1] || id || "Flexible";
}

function formatDate(timestamp) {
    return new Intl.DateTimeFormat(undefined, {
        month: "short", day: "numeric", year: "numeric"
    }).format(new Date(timestamp));
}

function formatDateTime(timestamp) {
    return new Intl.DateTimeFormat(undefined, {
        month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit"
    }).format(new Date(timestamp));
}

function formatTime(ms) {
    const cs = Math.floor(ms / 10), seconds = Math.floor(cs / 100) % 60, minutes = Math.floor(cs / 6000);
    return `${minutes ? `${minutes}:${String(seconds).padStart(2, "0")}` : seconds}.${String(cs % 100).padStart(2, "0")}`;
}

function cell(text, className = "") {
    const td = document.createElement("td");
    td.textContent = text;
    td.className = className;
    return td;
}

function cellRow(text) {
    const row = document.createElement("tr");
    const td = cell(text);
    td.colSpan = 4;
    row.append(td);
    return row;
}

function exportSession(session) {
    downloadJson(`cubing-assistant-${slugify(session.name)}.json`, {
        exportedAt: new Date().toISOString(), session, solves: getSessionSolves(session.id)
    });
}

function exportBackup() {
    downloadJson(`cubing-assistant-backup-${new Date().toISOString().slice(0, 10)}.json`, createSnapshot());
}

function downloadJson(name, payload) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], {type: "application/json"}));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
}

function slugify(value) {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "session";
}

function getStoredTheme() {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}").theme || {};
    } catch {
        return {};
    }
}