const STORAGE_KEY = "cubingAssistant.timerState";
const ACCOUNT_SWITCH_STORAGE_KEY = "cubingAssistant.pendingAccountSwitch";
const ACCOUNT_SWITCH_RESOLVED_STORAGE_KEY = "cubingAssistant.accountSwitchResolved";
const SYNC_DIRTY_STORAGE_KEY = "cubingAssistant.syncDirty";
const PLAYGROUND_SESSION_ID = "playground";
const IMPORT_DB_NAME = "cubingAssistantImports";
const IMPORT_DB_VERSION = 1;
const IMPORT_BATCH_SIZE = 500;
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
    statsConfig: null,
    statsConfigUpdatedAt: 0,
    selectedSessionId: PLAYGROUND_SESSION_ID,
    stagedSessions: [],
    importJobId: null,
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
const sessionSplitsEl = document.querySelector("#sessionSplits");
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
    closeDialogOnBackdrop(sessionDialogEl);
    closeDialogOnBackdrop(confirmDialogEl, () => {
        pendingConfirm = null;
        confirmDialogEl.close();
    });
    closeDialogOnBackdrop(importDialogEl, () => {
        abortImportDialog();
    });
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

function closeDialogOnBackdrop(dialog, close = () => dialog.close()) {
    dialog.addEventListener("click", (event) => {
        if (event.target !== dialog || !isBackdropClick(dialog, event)) return;
        close();
    });
}

function isBackdropClick(dialog, event) {
    const rect = dialog.getBoundingClientRect();
    return event.clientX < rect.left
        || event.clientX > rect.right
        || event.clientY < rect.top
        || event.clientY > rect.bottom;
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
    state.statsConfig = Array.isArray(saved.statsConfig) ? saved.statsConfig : null;
    state.statsConfigUpdatedAt = Number(saved.statsConfigUpdatedAt || 0);
    state.selectedSessionId = getVisibleSessions().some((session) => session.id === saved.activeSessionId) ? saved.activeSessionId : PLAYGROUND_SESSION_ID;
}

function normalizeSessions(sessions) {
    const playground = {id: PLAYGROUND_SESSION_ID, name: "Playground", event: null, createdAt: 0, updatedAt: 0};
    const named = Array.isArray(sessions) ? sessions.filter((session) => session.id && session.id !== PLAYGROUND_SESSION_ID) : [];
    return [playground, ...named];
}

function saveState({sync = true} = {}) {
    const raw = localStorage.getItem(STORAGE_KEY);
    let saved = {};
    try {
        saved = raw ? JSON.parse(raw) : {};
    } catch {
        saved = {};
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
        ...saved,
        sessions: state.sessions,
        solves: state.solves,
        sessionScrambleIndexes: state.sessionScrambleIndexes,
        ...(state.statsConfig ? {statsConfig: state.statsConfig} : {}),
        ...(state.statsConfig ? {statsConfigUpdatedAt: state.statsConfigUpdatedAt} : {}),
    }));
    if (sync) {
        localStorage.setItem(SYNC_DIRTY_STORAGE_KEY, String(Date.now()));
        pushRemoteState();
    }
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
    sessionSplitsEl.value = "0";
    sessionDialogEl.showModal();
}

function saveCreatedSession(event) {
    event.preventDefault();
    const name = sessionNameEl.value.trim();
    if (!name) return;
    const now = Date.now();
    const phaseCount = Math.min(20, Math.max(0, Math.floor(Number(sessionSplitsEl.value) || 0)));
    const session = {
        id: crypto.randomUUID(),
        name,
        event: sessionEventEl.value,
        createdAt: now,
        updatedAt: now,
        ...(phaseCount ? {phaseCount} : {}),
    };
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
    if (!("indexedDB" in window)) {
        showImportError("This browser does not support IndexedDB, which is required for resumable imports.");
        return;
    }
    setImportProgress(0, "Reading");
    cstimerFileEl.disabled = true;
    try {
        const job = await stageCstimerFile(file);
        state.importJobId = job.id;
        renderImportJob(job);
    } catch (error) {
        showImportError(error.message);
        cstimerFileEl.disabled = false;
        importProgressEl.hidden = true;
    }
}

async function stageCstimerFile(file) {
    let data;
    try {
        data = JSON.parse(await file.text());
    } catch (error) {
        throw new Error(`Could not parse the csTimer file: ${error.message}`);
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("The selected file is not a csTimer backup.");
    }

    const metadata = parseCstimerSessionMetadata(data.properties?.sessionData);
    const sourceKeys = Object.keys(data)
        .filter((key) => /^session\d+$/.test(key) && Array.isArray(data[key]) && data[key].length)
        .sort((left, right) => Number(left.slice(7)) - Number(right.slice(7)));
    if (!sourceKeys.length) throw new Error("No csTimer sessions were found in this backup.");

    const jobId = crypto.randomUUID();
    const sessions = sourceKeys.map((sourceKey) => {
        const number = sourceKey.slice(7);
        const sessionMetadata = metadata[number] && typeof metadata[number] === "object" ? metadata[number] : {};
        const phaseCount = normalizeCstimerPhaseCount(sessionMetadata.opt?.phases);
        return {
            key: sourceKey,
            name: String(sessionMetadata.name || `csTimer ${sourceKey}`),
            event: detectCstimerEvent(sessionMetadata),
            phaseCount,
            solveCount: data[sourceKey].length,
            action: "create",
            destination: "",
        };
    });
    const rawSolves = [];
    sourceKeys.forEach((sourceKey) => {
        data[sourceKey].forEach((rawSolve) => {
            rawSolves.push({jobId, index: rawSolves.length, sourceKey, rawSolve});
        });
    });
    const job = {
        id: jobId,
        fileName: file.name,
        status: "awaiting_configuration",
        sessions,
        totalSolves: rawSolves.length,
        processedSolves: 0,
        importedAt: Date.now(),
        result: {created: 0, added: 0, duplicates: 0},
        updatedAt: Date.now(),
    };
    await replaceImportJob(job, rawSolves);
    return job;
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
        const job = await getImportJob(state.importJobId);
        if (!job) throw new Error("The staged import is no longer available in this browser.");
        job.sessions = state.stagedSessions.map((session) => ({
            ...session,
            sessionId: session.action === "merge" ? session.destination : crypto.randomUUID(),
        }));
        job.status = "importing";
        job.processedSolves = 0;
        job.result = {created: 0, added: 0, duplicates: 0};
        job.syncToDrive = await importShouldSyncToDrive();
        job.updatedAt = Date.now();
        await putImportJob(job);
        await processIndexedImport(job);
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
        const job = await getActiveImportJob();
        if (!job) return;
        state.importJobId = job.id;
        renderImportJob(job);
        if (job.status === "importing") await processIndexedImport(job);
    } catch {
    }
}

function renderImportJob(job) {
    state.importJobId = job.id;
    cstimerFileEl.disabled = !["completed", "failed", "cancelled"].includes(job.status);
    cancelImportEl.hidden = ["awaiting_configuration", "completed", "failed", "cancelled"].includes(job.status);
    importErrorEl.hidden = true;

    if (job.status === "awaiting_configuration") {
        state.stagedSessions = (job.sessions || []).map((session) => ({...session}));
        importProgressEl.hidden = true;
        renderImportRows();
        return;
    }

    commitImportEl.disabled = true;
    if (job.status !== "completed") importRowsEl.replaceChildren();
    if (job.status === "importing") {
        const percent = job.totalSolves ? Math.round((job.processedSolves / job.totalSolves) * 100) : 0;
        importSummaryEl.textContent = job.syncToDrive
            ? "Importing staged solves into Google Drive. You can close this page and resume later."
            : "Importing staged solves into this browser. You can close this page and resume later.";
        setImportProgress(percent, `${job.processedSolves}/${job.totalSolves}`);
    }

    if (job.status === "failed") {
        showImportError(job.error || "The import failed.");
        cstimerFileEl.disabled = false;
    } else if (job.status === "cancelled") {
        importSummaryEl.textContent = "Import stopped.";
        cstimerFileEl.disabled = false;
    } else if (job.status === "completed" && state.importTerminalHandled !== job.id) {
        state.importTerminalHandled = job.id;
        const result = job.result || {};
        window.alert(`Import complete: ${result.created || 0} sessions created, ${result.added || 0} solves added, ${result.duplicates || 0} duplicates skipped.`);
        resetImport(true);
        state.importJobId = null;
    }
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
        const job = await getImportJob(state.importJobId);
        if (!job) return;
        job.status = "cancelled";
        job.updatedAt = Date.now();
        await putImportJob(job);
        renderImportJob(job);
    } catch (error) {
        showImportError(error.message);
    }
}

async function abortImportDialog() {
    if (state.importJobId) {
        await cancelImport();
        state.importJobId = null;
    }
    resetImport(true);
    importDialogEl.close();
}

async function processIndexedImport(job) {
    cancelImportEl.hidden = false;
    cstimerFileEl.disabled = true;
    while (job.status === "importing" && job.processedSolves < job.totalSolves) {
        const rawBatch = await getImportSolveBatch(job.id, job.processedSolves, IMPORT_BATCH_SIZE);
        if (!rawBatch.length) throw new Error("The staged import is incomplete. Select the csTimer file again.");
        const selectedByKey = new Map(job.sessions.map((session) => [session.key, session]));
        const converted = (await Promise.all(rawBatch.map(async (entry) => {
            const selected = selectedByKey.get(entry.sourceKey);
            if (!selected || selected.action === "skip") return null;
            return convertCstimerSolve(entry.sourceKey, selected.event, selected.sessionId, entry.rawSolve, job.importedAt);
        }))).filter(Boolean);
        const importSolves = restoreDeletedImportedSolves(converted);
        const sessions = buildImportSessions(job.sessions);
        if (importSolves.length || (job.processedSolves === 0 && sessions.length)) {
            let result;
            if (job.syncToDrive) {
                const response = await fetch("/api/import-batches", {
                    method: "POST",
                    headers: {"Content-Type": "application/json"},
                    body: JSON.stringify({
                        schemaVersion: 2,
                        updatedAt: Date.now(),
                        sessions,
                        solves: importSolves,
                        sessionScrambleIndexes: {},
                        theme: getStoredTheme(),
                        importMode: true,
                    }),
                });
                result = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(result.error || `Import batch failed (${response.status}).`);
            } else {
                result = applyLocalImportBatch(sessions, importSolves);
            }
            job.result.created += Number(result.created || 0);
            job.result.added += Number(result.added || 0);
            job.result.duplicates += Number(result.duplicates || 0);
            mergeRemote({sessions, solves: importSolves});
            saveState({sync: !job.syncToDrive});
        }
        job.processedSolves += rawBatch.length;
        job.updatedAt = Date.now();
        await putImportJob(job);
        renderImportJob(job);
        await new Promise((resolve) => window.setTimeout(resolve, 0));
        const refreshed = await getImportJob(job.id);
        if (!refreshed || refreshed.status === "cancelled") {
            job.status = "cancelled";
            renderImportJob(job);
            return;
        }
        job = refreshed;
    }

    job.status = "completed";
    job.updatedAt = Date.now();
    await putImportJob(job);
    render();
    renderImportJob(job);
    await deleteImportJob(job.id);
}

async function importShouldSyncToDrive() {
    try {
        const response = await fetch("/api/auth/status");
        if (!response.ok) return false;
        const status = await response.json();
        return Boolean(status.signedIn && status.driveConnected);
    } catch {
        return false;
    }
}

function applyLocalImportBatch(sessions, solves) {
    const existingSessionIds = new Set(state.sessions.map((session) => session.id));
    const existingSolves = new Map(state.solves.filter((solve) => solve.id).map((solve) => [solve.id, solve]));
    const seenSolveIds = new Set();
    const created = sessions.filter((session) => !existingSessionIds.has(session.id)).length;
    let added = 0;
    let duplicates = 0;
    solves.forEach((solve) => {
        if (seenSolveIds.has(solve.id)) {
            duplicates += 1;
            return;
        }
        seenSolveIds.add(solve.id);
        const existing = existingSolves.get(solve.id);
        if (existing && !existing.deletedAt) {
            duplicates += 1;
        } else {
            added += 1;
        }
    });
    return {created, added, duplicates};
}

function restoreDeletedImportedSolves(solves) {
    const existingSolves = new Map(state.solves.filter((solve) => solve.id).map((solve) => [solve.id, solve]));
    const now = Date.now();
    return solves.map((solve) => {
        const existing = existingSolves.get(solve.id);
        if (!existing) return solve;
        if (!existing.deletedAt && solve.phaseTimesMs?.length && !existing.phaseTimesMs?.length) {
            return {
                ...existing,
                phaseTimesMs: solve.phaseTimesMs,
                source: {
                    ...(existing.source || {}),
                    ...(solve.source?.cstimerCumulativeSplitsMs ? {
                        cstimerCumulativeSplitsMs: solve.source.cstimerCumulativeSplitsMs,
                    } : {}),
                },
                updatedAt: Math.max(now, updatedAt(existing) + 1, updatedAt(solve) + 1),
            };
        }
        if (!existing.deletedAt) return solve;
        const {deletedAt, redoneAt, ...restored} = solve;
        return {
            ...restored,
            updatedAt: Math.max(now, updatedAt(existing) + 1, updatedAt(solve) + 1),
        };
    });
}

function buildImportSessions(configuredSessions) {
    const now = Date.now();
    return configuredSessions
        .filter((session) => session.action !== "skip")
        .map((session) => {
            if (session.action === "merge") {
                const existing = state.sessions.find((entry) => entry.id === session.sessionId);
                if (!existing) throw new Error(`The destination for ${session.name} is no longer available.`);
                return {
                    ...existing,
                    ...(session.phaseCount && !existing.phaseCount ? {phaseCount: session.phaseCount} : {}),
                    updatedAt: session.phaseCount && !existing.phaseCount ? now : existing.updatedAt,
                };
            }
            return {
                id: session.sessionId,
                name: session.name || `${getEventLabel(session.event)} import`,
                event: session.event,
                createdAt: now,
                updatedAt: now,
                ...(session.phaseCount ? {phaseCount: session.phaseCount} : {}),
            };
        });
}

function parseCstimerSessionMetadata(value) {
    if (value && typeof value === "object") return value;
    if (typeof value !== "string") return {};
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

function normalizeCstimerPhaseCount(value) {
    const count = Math.floor(Number(value));
    return Number.isFinite(count) && count >= 2 ? Math.min(count, 20) : null;
}

function detectCstimerEvent(metadata) {
    const scrambleType = metadata?.opt?.scrType || "";
    if (CSTIMER_EVENTS[scrambleType]) return CSTIMER_EVENTS[scrambleType];
    const name = String(metadata?.name || "").toLowerCase();
    return EVENTS.find(([, label]) => name.includes(label.toLowerCase()))?.[0] || "333";
}

async function convertCstimerSolve(sourceKey, event, sessionId, rawSolve, importedAt) {
    if (!Array.isArray(rawSolve) || !Array.isArray(rawSolve[0])) {
        throw new Error(`${sourceKey} contains an invalid solve.`);
    }
    const penaltyValue = Number(rawSolve[0][0] || 0);
    const timeMs = Number(rawSolve[0][1]);
    const timestampSeconds = Number(rawSolve[3] || 0);
    if (![penaltyValue, timeMs, timestampSeconds].every(Number.isFinite)) {
        throw new Error(`${sourceKey} contains an invalid solve.`);
    }
    const scramble = String(rawSolve[1] || "");
    const comment = String(rawSolve[2] || "");
    const fingerprintSource = [
        "cstimer",
        sourceKey,
        jsNumberString(penaltyValue),
        jsNumberString(timeMs),
        scramble,
        comment,
        jsNumberString(timestampSeconds),
    ].join("\x1f");
    const fingerprint = await sha256Hex(fingerprintSource);
    const timestampMs = timestampSeconds * 1000;
    const solve = {
        id: `cstimer:${fingerprint}`,
        sessionId,
        event,
        timeMs,
        scramble,
        comment,
        createdAt: timestampMs,
        updatedAt: timestampMs,
        penalty: penaltyValue < 0 ? "DNF" : penaltyValue > 0 ? "+2" : "OK",
        source: {
            provider: "cstimer",
            sessionKey: sourceKey,
            fingerprint,
            importedAt,
        },
    };
    const cumulativeSplits = rawSolve[0].slice(2).map(Number);
    if (cumulativeSplits.length) {
        if (cumulativeSplits.some((value) => !Number.isFinite(value))) {
            throw new Error(`${sourceKey} contains an invalid split time.`);
        }
        const boundaries = [timeMs, ...cumulativeSplits, 0];
        if (boundaries.some((value) => value < 0)
            || boundaries.some((value, index) => index < boundaries.length - 1 && value < boundaries[index + 1])) {
            throw new Error(`${sourceKey} contains split times outside the solve duration.`);
        }
        solve.phaseTimesMs = [];
        for (let index = boundaries.length - 2; index >= 0; index -= 1) {
            solve.phaseTimesMs.push(boundaries[index] - boundaries[index + 1]);
        }
        solve.source.cstimerCumulativeSplitsMs = cumulativeSplits;
    }
    return solve;
}

function jsNumberString(value) {
    return Number.isInteger(value) ? String(value) : String(Number(value));
}

async function sha256Hex(value) {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function openImportDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(IMPORT_DB_NAME, IMPORT_DB_VERSION);
        request.addEventListener("upgradeneeded", () => {
            const database = request.result;
            if (!database.objectStoreNames.contains("jobs")) {
                database.createObjectStore("jobs", {keyPath: "id"});
            }
            if (!database.objectStoreNames.contains("solves")) {
                const store = database.createObjectStore("solves", {keyPath: ["jobId", "index"]});
                store.createIndex("jobId", "jobId");
            }
        });
        request.addEventListener("success", () => resolve(request.result));
        request.addEventListener("error", () => reject(request.error || new Error("Could not open import storage.")));
    });
}

async function replaceImportJob(job, solves) {
    const database = await openImportDb();
    await new Promise((resolve, reject) => {
        const transaction = database.transaction(["jobs", "solves"], "readwrite");
        const solveStore = transaction.objectStore("solves");
        const range = IDBKeyRange.bound([job.id, 0], [job.id, Number.MAX_SAFE_INTEGER]);
        solveStore.delete(range);
        transaction.objectStore("jobs").put(job);
        solves.forEach((solve) => solveStore.put(solve));
        transaction.addEventListener("complete", resolve);
        transaction.addEventListener("error", () => reject(transaction.error));
        transaction.addEventListener("abort", () => reject(transaction.error));
    });
    database.close();
}

async function putImportJob(job) {
    const database = await openImportDb();
    await idbRequest(database.transaction("jobs", "readwrite").objectStore("jobs").put(job));
    database.close();
}

async function getImportJob(jobId) {
    const database = await openImportDb();
    const job = await idbRequest(database.transaction("jobs").objectStore("jobs").get(jobId));
    database.close();
    return job || null;
}

async function getActiveImportJob() {
    const database = await openImportDb();
    const jobs = await idbRequest(database.transaction("jobs").objectStore("jobs").getAll());
    database.close();
    return jobs
        .filter((job) => !["completed", "cancelled"].includes(job.status))
        .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))[0] || null;
}

async function getImportSolveBatch(jobId, offset, limit) {
    const database = await openImportDb();
    const transaction = database.transaction("solves");
    const store = transaction.objectStore("solves");
    const range = IDBKeyRange.bound([jobId, offset], [jobId, Number.MAX_SAFE_INTEGER]);
    const rows = await new Promise((resolve, reject) => {
        const results = [];
        const request = store.openCursor(range);
        request.addEventListener("success", () => {
            const cursor = request.result;
            if (!cursor || results.length >= limit) {
                resolve(results);
                return;
            }
            results.push(cursor.value);
            cursor.continue();
        });
        request.addEventListener("error", () => reject(request.error));
    });
    database.close();
    return rows;
}

async function deleteImportJob(jobId) {
    const database = await openImportDb();
    await new Promise((resolve, reject) => {
        const transaction = database.transaction(["jobs", "solves"], "readwrite");
        transaction.objectStore("jobs").delete(jobId);
        transaction.objectStore("solves").delete(IDBKeyRange.bound(
            [jobId, 0],
            [jobId, Number.MAX_SAFE_INTEGER],
        ));
        transaction.addEventListener("complete", resolve);
        transaction.addEventListener("error", () => reject(transaction.error));
        transaction.addEventListener("abort", () => reject(transaction.error));
    });
    database.close();
}

function idbRequest(request) {
    return new Promise((resolve, reject) => {
        request.addEventListener("success", () => resolve(request.result));
        request.addEventListener("error", () => reject(request.error));
    });
}

async function pullRemoteState() {
    if (localStorage.getItem(ACCOUNT_SWITCH_STORAGE_KEY)) return;
    try {
        mergeRemote(await window.CubingAssistantSync.downloadSnapshot());
        saveState({sync: false});
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
            sessionScrambleIndexes: state.sessionScrambleIndexes,
            ...(state.statsConfig ? {statsConfig: state.statsConfig} : {}),
            ...(state.statsConfig ? {statsConfigUpdatedAt: state.statsConfigUpdatedAt} : {}),
        }));
        localStorage.removeItem(SYNC_DIRTY_STORAGE_KEY);
        render();
    } catch {
    }
}

function mergeRemote(remote) {
    state.solves = mergeById(state.solves, remote.solves || []);
    state.sessions = normalizeSessions(mergeById(state.sessions, remote.sessions || []));
    state.sessionScrambleIndexes = {...state.sessionScrambleIndexes, ...(remote.sessionScrambleIndexes || {})};
    if (Array.isArray(remote.statsConfig) && Number(remote.statsConfigUpdatedAt || 0) >= state.statsConfigUpdatedAt) {
        state.statsConfig = remote.statsConfig;
        state.statsConfigUpdatedAt = Number(remote.statsConfigUpdatedAt || 0);
    }
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
        ...(state.statsConfig ? {statsConfig: state.statsConfig} : {}),
        ...(state.statsConfig ? {statsConfigUpdatedAt: state.statsConfigUpdatedAt} : {}),
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
