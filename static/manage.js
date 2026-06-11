const STORAGE_KEY = "cubingAssistant.timerState";
const ACCOUNT_SWITCH_STORAGE_KEY = "cubingAssistant.pendingAccountSwitch";
const ACCOUNT_SWITCH_RESOLVED_STORAGE_KEY = "cubingAssistant.accountSwitchResolved";
const PLAYGROUND_SESSION_ID = "playground";
const EVENTS = [["222", "2x2"], ["333", "3x3"], ["444", "4x4"], ["555", "5x5"], ["666", "6x6"], ["777", "7x7"], ["333oh", "3x3 OH"], ["333bf", "3x3 Blindfolded"], ["333fm", "3x3 Fewest Moves"], ["333mbf", "3x3 Multi-Blind"], ["clock", "Clock"], ["minx", "Megaminx"], ["pyram", "Pyraminx"], ["skewb", "Skewb"], ["sq1", "Square-1"],];

window.addEventListener("storage", (event) => {
    if (event.key === ACCOUNT_SWITCH_RESOLVED_STORAGE_KEY) {
        window.location.reload();
    }
});

const state = {
    sessions: [],
    solves: [],
    sessionScrambleIndexes: {},
    selectedSessionId: PLAYGROUND_SESSION_ID,
    stagedSessions: [],
    importJobId: null,
    importPollTimer: null,
    importTerminalHandled: null,
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
const cancelImportEl = document.querySelector("#cancelImport");
const importProgressEl = document.querySelector("#importProgress");
const importProgressBarEl = document.querySelector("#importProgressBar");
const importProgressTextEl = document.querySelector("#importProgressText");
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
    await resumeActiveImport();
}

function bindEvents() {
    searchEl.addEventListener("input", renderSessionList);
    filterEl.addEventListener("change", renderSessionList);
    document.querySelector("#newSession").addEventListener("click", openCreateDialog);
    document.querySelector("#importCstimer").addEventListener("click", () => {
        if (!importDialogEl.open) importDialogEl.showModal();
    });
    document.querySelector("#exportBackup").addEventListener("click", exportBackup);
    document.querySelector("#saveSession").addEventListener("click", saveCreatedSession);
    cstimerFileEl.addEventListener("change", readCstimerFile);
    commitImportEl.addEventListener("click", commitImport);
    cancelImportEl.addEventListener("click", cancelImport);
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
    setImportProgress(0, "Uploading");
    cstimerFileEl.disabled = true;
    try {
        const job = await uploadImportFile(file);
        state.importJobId = job.id;
        renderImportJob(job);
        scheduleImportPoll();
    } catch (error) {
        showImportError(error.message);
        cstimerFileEl.disabled = false;
        importProgressEl.hidden = true;
    }
}

function uploadImportFile(file) {
    return new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open("POST", "/api/imports");
        request.setRequestHeader("Content-Type", "application/octet-stream");
        request.setRequestHeader("X-File-Name", file.name);
        request.upload.addEventListener("progress", (event) => {
            if (event.lengthComputable) {
                const percent = Math.round((event.loaded / event.total) * 100);
                setImportProgress(percent, `Uploading ${percent}%`);
            }
        });
        request.addEventListener("load", () => {
            let payload = {};
            try {
                payload = JSON.parse(request.responseText || "{}");
            } catch {
            }
            if (request.status >= 200 && request.status < 300) resolve(payload);
            else reject(new Error(payload.error || `Upload failed (${request.status}).`));
        });
        request.addEventListener("error", () => reject(new Error("The upload connection failed.")));
        request.addEventListener("abort", () => reject(new Error("The upload was cancelled.")));
        request.send(file);
    });
}

function renderImportRows() {
    const solveCount = state.stagedSessions.reduce((sum, session) => sum + session.solveCount, 0);
    importSummaryEl.textContent = `${state.stagedSessions.length} sessions and ${solveCount} solves detected. Review each destination before importing.`;
    importRowsEl.replaceChildren();
    state.stagedSessions.forEach((session, index) => {
        const row = document.createElement("tr");
        row.innerHTML = `<td><input data-field="name"></td><td><select data-field="event"></select></td><td></td><td><select data-field="action"><option value="create">Create new</option><option value="merge">Merge into existing</option><option value="skip">Skip</option></select></td><td><select data-field="destination"></select></td>`;
        row.querySelector('[data-field="name"]').value = session.name;
        const eventSelect = row.querySelector('[data-field="event"]');
        EVENTS.forEach(([id, label]) => eventSelect.append(new Option(label, id)));
        eventSelect.value = session.event;
        row.children[2].textContent = String(session.solveCount);
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
    for (const staged of state.stagedSessions) {
        if (staged.action === "merge" && !getVisibleSessions().some((session) => session.id === staged.destination)) {
            showImportError(`Choose a destination for ${staged.name}.`);
            commitImportEl.disabled = false;
            return;
        }
    }
    try {
        const response = await fetch(`/api/imports/${state.importJobId}/start`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({sessions: state.stagedSessions}),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Could not start the import.");
        renderImportJob(payload);
        scheduleImportPoll();
    } catch (error) {
        showImportError(error.message);
        commitImportEl.disabled = false;
    }
}

function resetImport(clearFile = false) {
    state.stagedSessions = [];
    importRowsEl.replaceChildren();
    importErrorEl.hidden = true;
    commitImportEl.disabled = true;
    cancelImportEl.hidden = true;
    importProgressEl.hidden = true;
    cstimerFileEl.disabled = false;
    if (clearFile) cstimerFileEl.value = "";
}

async function resumeActiveImport() {
    try {
        const response = await fetch("/api/imports/active");
        if (!response.ok) return;
        const job = await response.json();
        if (!job.id) return;
        state.importJobId = job.id;
        renderImportJob(job);
        scheduleImportPoll();
    } catch {
    }
}

function scheduleImportPoll() {
    window.clearTimeout(state.importPollTimer);
    state.importPollTimer = window.setTimeout(pollImportJob, 900);
}

async function pollImportJob() {
    if (!state.importJobId) return;
    try {
        const response = await fetch(`/api/imports/${state.importJobId}`);
        const job = await response.json();
        if (!response.ok) throw new Error(job.error || "Could not read import status.");
        renderImportJob(job);
        if (!["completed", "failed", "cancelled"].includes(job.status)) scheduleImportPoll();
    } catch (error) {
        showImportError(error.message);
        scheduleImportPoll();
    }
}

function renderImportJob(job) {
    state.importJobId = job.id;
    cstimerFileEl.disabled = !["completed", "failed", "cancelled"].includes(job.status);
    cancelImportEl.hidden = ["awaiting_configuration", "completed", "failed", "cancelled"].includes(job.status);
    importErrorEl.hidden = true;

    if (job.status === "awaiting_configuration") {
        state.stagedSessions = (job.sessions || []).map((session) => ({
            ...session, action: "create", destination: ""
        }));
        importProgressEl.hidden = true;
        renderImportRows();
        return;
    }

    commitImportEl.disabled = true;
    if (job.status !== "completed") importRowsEl.replaceChildren();
    const status = importStatus(job);
    importSummaryEl.textContent = status.summary;
    setImportProgress(status.percent, status.label);

    if (job.status === "failed") {
        showImportError(job.error || "The import failed.");
        cstimerFileEl.disabled = false;
    } else if (job.status === "cancelled") {
        importSummaryEl.textContent = "Import stopped.";
        cstimerFileEl.disabled = false;
    } else if (job.status === "completed" && state.importTerminalHandled !== job.id) {
        state.importTerminalHandled = job.id;
        const result = job.result || {};
        pullRemoteState();
        window.alert(`Import complete: ${result.created || 0} sessions created, ${result.added || 0} solves added, ${result.duplicates || 0} duplicates skipped.`);
        resetImport(true);
        state.importJobId = null;
    }
}

function importStatus(job) {
    if (job.status === "uploading") return {percent: 0, label: "Uploading", summary: "Receiving the backup file."};
    if (job.status === "uploaded" || job.status === "inspecting") return {percent: 5, label: "Inspecting", summary: "Inspecting sessions on the server."};
    if (job.status === "queued") return {percent: 8, label: "Queued", summary: "Import queued. You can close this page."};
    if (job.status === "parsing") {
        const percent = job.totalSolves ? 10 + Math.round((job.processedSolves / job.totalSolves) * 65) : 10;
        return {percent, label: `${job.processedSolves}/${job.totalSolves}`, summary: "Parsing and deduplicating solves on the server. You can close this page."};
    }
    if (job.status === "merging") return {percent: 78, label: "Merging", summary: "Merging imported solves with the Drive snapshot."};
    if (job.status === "drive_uploading") {
        const fraction = job.uploadTotalBytes ? job.uploadSentBytes / job.uploadTotalBytes : 0;
        return {percent: 80 + Math.round(fraction * 19), label: `Drive ${Math.round(fraction * 100)}%`, summary: "Uploading the merged snapshot to Google Drive. You can close this page."};
    }
    if (job.status === "completed") return {percent: 100, label: "Complete", summary: "Import complete."};
    return {percent: 0, label: job.status, summary: "Import stopped."};
}

function setImportProgress(percent, text) {
    importProgressEl.hidden = false;
    importProgressBarEl.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    importProgressTextEl.textContent = text;
}

function showImportError(message) {
    importErrorEl.hidden = false;
    importErrorEl.textContent = message;
}

async function cancelImport() {
    if (!state.importJobId) return;
    try {
        const response = await fetch(`/api/imports/${state.importJobId}`, {method: "DELETE"});
        if (!response.ok) throw new Error("Could not stop the import.");
        renderImportJob({...await response.json(), id: state.importJobId});
    } catch (error) {
        showImportError(error.message);
    }
}

async function pullRemoteState() {
    if (localStorage.getItem(ACCOUNT_SWITCH_STORAGE_KEY)) return;
    try {
        mergeRemote(await window.CubingAssistantSync.downloadSnapshot());
        saveState();
        render();
    } catch {
    }
}

async function pushRemoteState() {
    if (localStorage.getItem(ACCOUNT_SWITCH_STORAGE_KEY)) return;
    try {
        mergeRemote(await window.CubingAssistantSync.uploadSnapshot(createSnapshot()));
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
