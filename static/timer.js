const READY_DELAY_MS = 500;
const SPLIT_INPUT_GRACE_MS = 150;
const INSPECTION_DURATION_MS = 15_000;
const INSPECTION_HOLD_THRESHOLD_MS = 7_000;
const INSPECTION_DANGER_THRESHOLD_MS = 3_000;
const STORAGE_KEY = "cubingAssistant.timerState";
const LAYOUT_STORAGE_KEY = "cubingAssistant.layout";
const LAST_SYNC_STORAGE_KEY = "cubingAssistant.lastAutoSync";
const SYNC_DIRTY_STORAGE_KEY = "cubingAssistant.syncDirty";
const ACCOUNT_SWITCH_STORAGE_KEY = "cubingAssistant.pendingAccountSwitch";
const ACCOUNT_SWITCH_RESOLVED_STORAGE_KEY = "cubingAssistant.accountSwitchResolved";
const SYNC_DEBOUNCE_MS = 1500;
const DIRTY_SYNC_INTERVAL_MS = 30_000;
const PLAYGROUND_SESSION_ID = "playground";
const DEFAULT_TIMES_MIN_WIDTH_PX = 352;
const RESIZE_HANDLE_WIDTH_PX = 16;
const DEFAULT_SCRAMBLE_DRAWING_WIDTH_PX = 288;
const MIN_SCRAMBLE_DRAWING_WIDTH_PX = 192;
const SINGLE_STAT_CONFIG = {id: "single", type: "mean", size: 1};
const DEFAULT_STATS_CONFIG = [
    {id: "mo3", type: "mean", size: 3},
    {id: "ao5", type: "average", size: 5, trimValue: 1, trimUnit: "solves"},
    {id: "ao12", type: "average", size: 12, trimValue: 1, trimUnit: "solves"},
    {id: "ao100", type: "average", size: 100, trimValue: 5, trimUnit: "percent"},
];
const MOUSE_ONLY_NAVIGATION_SELECTOR = [
    "button",
    "select",
    "a",
    ".toolbar-switch",
    "[role='separator']",
    ".scramble-panel",
    ".times-list",
    ".average-times",
    ".scramble-drawing-panel",
].join(", ");
const KEYBOARD_SCROLL_KEYS = new Set(["Space", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"]);

const EVENTS = [["222", "2x2"], ["333", "3x3"], ["444", "4x4"], ["555", "5x5"], ["666", "6x6"], ["777", "7x7"], ["333oh", "3x3 OH"], ["333bf", "3x3 Blindfolded"], ["333fm", "3x3 Fewest Moves"], ["333mbf", "3x3 Multi-Blind"], ["clock", "Clock"], ["minx", "Megaminx"], ["pyram", "Pyraminx"], ["skewb", "Skewb"], ["sq1", "Square-1"],];

const appEl = document.querySelector(".app");
const scramblePanelEl = document.querySelector(".scramble-panel");
const scrambleMetaEl = document.querySelector(".scramble-meta");
const timerPanelEl = document.querySelector(".timer-panel");
const timerEl = document.querySelector("#timer");
const statusEl = document.querySelector("#status");
const inspectionEnabledEl = document.querySelector("#inspectionEnabled");
const drawingEnabledEl = document.querySelector("#drawingEnabled");
const timerUpdateMsEl = document.querySelector("#timerUpdateMs");
const scrambleEl = document.querySelector("#scramble");
const scrambleDrawingEl = document.querySelector("#scrambleDrawing");
const scrambleDrawingPanelEl = document.querySelector(".scramble-drawing-panel");
const scrambleDrawingHeadingEl = document.querySelector(".scramble-drawing-heading");
const scrambleDrawingResizeEls = document.querySelectorAll(".scramble-drawing-resize");
const sessionSelectEl = document.querySelector("#sessionSelect");
const createSessionEl = document.querySelector("#createSession");
const eventSelectEl = document.querySelector("#eventSelect");
const fixedEventLabelEl = document.querySelector("#fixedEventLabel");
const timesPanelEl = document.querySelector(".times-panel");
const randomScrambleEl = document.querySelector("#randomScramble");
const resetLayoutEl = document.querySelector("#resetLayout");
const decreaseScrambleFontEl = document.querySelector("#decreaseScrambleFont");
const increaseScrambleFontEl = document.querySelector("#increaseScrambleFont");
const statsBodyEl = document.querySelector("#statsBody");
const editStatsEl = document.querySelector("#editStats");
const statsEditorDialogEl = document.querySelector("#statsEditorDialog");
const statsEditorListEl = document.querySelector("#statsEditorList");
const newStatTypeEl = document.querySelector("#newStatType");
const newStatSizeEl = document.querySelector("#newStatSize");
const addStatEl = document.querySelector("#addStat");
const statsEditorStatusEl = document.querySelector("#statsEditorStatus");
const timesListEl = document.querySelector("#timesList");
const exportTimesEl = document.querySelector("#exportTimes");
const clearTimesEl = document.querySelector("#clearTimes");
const clearConfirmDialogEl = document.querySelector("#clearConfirmDialog");
const confirmClearTimesEl = document.querySelector("#confirmClearTimes");
const createSessionDialogEl = document.querySelector("#createSessionDialog");
const newSessionNameEl = document.querySelector("#newSessionName");
const newSessionEventEl = document.querySelector("#newSessionEvent");
const newSessionSplitsEl = document.querySelector("#newSessionSplits");
const confirmCreateSessionEl = document.querySelector("#confirmCreateSession");
const averageDialogEl = document.querySelector("#averageDialog");
const averageDialogTitleEl = document.querySelector("#averageDialogTitle");
const averageDialogSummaryEl = document.querySelector("#averageDialogSummary");
const averageDialogTimesEl = document.querySelector("#averageDialogTimes");
const copyAverageLogEl = document.querySelector("#copyAverageLog");
let averageDialogLog = "";

const state = {
    scrambles: [],
    activeEvent: "333",
    playgroundEvent: "333",
    activeSessionId: PLAYGROUND_SESSION_ID,
    sessions: [createPlaygroundSession()],
    sessionScrambleIndexes: {},
    solves: [],
    timerState: "idle",
    startTime: 0,
    elapsedMs: 0,
    lastDisplayMs: 0,
    holdTimeout: null,
    animationFrame: null,
    inspectionAnimationFrame: null,
    inspectionDeadline: 0,
    inspectionEnabled: false,
    drawingEnabled: true,
    timerUpdateMs: 10,
    touchIdentifier: null,
    phaseTimesMs: [],
    splitInputReadyAt: 0,
    redoSolveId: null,
    redoScramble: "",
    scrambleFontSize: 1.9,
    statsConfig: createDefaultStatsConfig(),
    syncReady: false,
    syncTimeout: null,
    syncInterval: null,
    syncRevision: 0,
    syncedRevision: 0,
    syncInFlight: false,
    timesLoadingInterval: null,
    theme: {},
};

init();

async function init() {
    loadLayout();
    loadSavedState();
    renderEventOptions();
    renderSessionOptions();
    bindEvents();

    await switchSession(state.activeSessionId, {deferHistory: true});
    await pullRemoteState();
    state.syncReady = true;
    state.syncInterval = window.setInterval(syncDirtyState, DIRTY_SYNC_INTERVAL_MS);
    scheduleSync();
    renderSessionOptions();
    render();
}

async function loadScrambles(eventId) {
    const response = await fetch(`/scramble/${eventId}.txt`);
    if (!response.ok) {
        throw new Error(`Missing /scramble/${eventId}.txt`);
    }

    const text = await response.text();
    const scrambles = text
        .split(/\r?\n/)
        .map((line) => normalizeScramble(line))
        .filter(Boolean);

    if (scrambles.length === 0) {
        throw new Error(`No scrambles found in /scramble/${eventId}.txt`);
    }

    return scrambles;
}

function bindEvents() {
    document.addEventListener("keydown", onControlKeyDown, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("resize", onWindowResize);

    document.addEventListener("touchstart", onTouchStart, {passive: false});
    document.addEventListener("touchend", onTouchEnd, {passive: false});
    document.addEventListener("touchcancel", onTouchEnd, {passive: false});
    window.addEventListener("pagehide", flushSyncWithBeacon);
    window.addEventListener("storage", (event) => {
        if (event.key === ACCOUNT_SWITCH_RESOLVED_STORAGE_KEY) {
            window.location.reload();
        }
    });

    scrambleEl.addEventListener("dblclick", () => {
        copyScrambleText(getCurrentScramble());
    });

    sessionSelectEl.addEventListener("change", async () => {
        if (state.timerState === "running" || isInspectionState()) {
            sessionSelectEl.value = state.activeSessionId;
            return;
        }

        await switchSession(sessionSelectEl.value);
    });

    createSessionEl.addEventListener("click", () => {
        if (state.timerState === "running" || isInspectionState()) return;
        newSessionNameEl.value = "";
        newSessionEventEl.value = state.activeEvent;
        newSessionSplitsEl.value = "0";
        createSessionDialogEl.showModal();
    });

    confirmCreateSessionEl.addEventListener("click", async (event) => {
        event.preventDefault();
        await createSession();
    });

    eventSelectEl.addEventListener("change", async () => {
        if (state.timerState === "running" || isInspectionState()) {
            eventSelectEl.value = state.activeEvent;
            return;
        }

        await switchEvent(eventSelectEl.value);
    });

    randomScrambleEl.addEventListener("click", () => {
        if (state.timerState === "running" || isInspectionState() || state.scrambles.length === 0) return;
        cancelRedo();
        setScrambleIndex(getRandomScrambleIndex());
        state.lastDisplayMs = 0;
        saveState();
        render();
    });

    resetLayoutEl.addEventListener("click", resetLayout);

    decreaseScrambleFontEl.addEventListener("click", () => {
        state.scrambleFontSize = clamp(state.scrambleFontSize - 0.1, 0.9, 3.2);
        saveState();
        renderScrambleFontSize();
        syncScrambleMinHeight();
    });

    increaseScrambleFontEl.addEventListener("click", () => {
        state.scrambleFontSize = clamp(state.scrambleFontSize + 0.1, 0.9, 3.2);
        saveState();
        renderScrambleFontSize();
        syncScrambleMinHeight();
    });

    inspectionEnabledEl.addEventListener("change", () => {
        state.inspectionEnabled = inspectionEnabledEl.checked;
        saveState();
        renderTimerState();
    });

    drawingEnabledEl.addEventListener("change", () => {
        state.drawingEnabled = drawingEnabledEl.checked;
        saveState();
        renderScrambleDrawingVisibility();
    });

    timerUpdateMsEl.addEventListener("change", () => {
        state.timerUpdateMs = normalizeTimerUpdateMs(timerUpdateMsEl.value);
        timerUpdateMsEl.value = String(state.timerUpdateMs);
        saveState();
        renderTimerState();
    });

    exportTimesEl.addEventListener("click", exportActiveSession);
    editStatsEl.addEventListener("click", openStatsEditor);
    addStatEl.addEventListener("click", addConfiguredStat);
    newStatTypeEl.addEventListener("change", syncNewStatSizeMinimum);
    statsEditorListEl.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-remove-stat]");
        if (!button) return;
        removeConfiguredStat(button.dataset.removeStat);
    });
    statsEditorListEl.addEventListener("change", onStatsEditorConfigChange);
    statsEditorListEl.addEventListener("pointerdown", onStatsEditorPointerDown);

    clearTimesEl.addEventListener("click", () => {
        if (state.timerState === "running" || isInspectionState()) return;
        clearConfirmDialogEl.showModal();
    });

    confirmClearTimesEl.addEventListener("click", () => {
        clearActiveSession();
    });

    statsBodyEl.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-stat-average]");
        if (!button || state.timerState === "running" || isInspectionState()) return;
        showAverageDialog(button.dataset.statAverage, button.dataset.statColumn);
    });

    copyAverageLogEl.addEventListener("click", copyAverageLog);
    averageDialogEl.addEventListener("click", (event) => {
        if (event.target === averageDialogEl) {
            averageDialogEl.close();
        }
    });

    timesListEl.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-action]");
        if (!button || state.timerState === "running" || isInspectionState()) {
            return;
        }

        const solveId = button.dataset.solveId;
        if (button.dataset.action === "delete") {
            deleteSolve(solveId);
            return;
        }

        if (button.dataset.action === "redo") {
            startRedo(solveId);
            return;
        }

        if (button.dataset.action === "penalty") {
            updateSolvePenalty(solveId, button.dataset.penalty);
        }
    });

    timesListEl.addEventListener("dblclick", (event) => {
        const phaseHeader = event.target.closest("[data-phase-index]");
        if (phaseHeader) {
            editPhaseName(phaseHeader);
            return;
        }

        const scramble = event.target.closest(".time-scramble");
        if (!scramble) return;

        copyScrambleText(scramble.textContent);
    });

    document.querySelectorAll("[data-resize]").forEach((handle) => {
        handle.addEventListener("pointerdown", onResizeStart);
    });
    scrambleDrawingHeadingEl.addEventListener("pointerdown", onScrambleDrawingDragStart);
    scrambleDrawingResizeEls.forEach((handle) => {
        handle.addEventListener("pointerdown", onScrambleDrawingResizeStart);
    });

    enforceMouseOnlyNavigation();
}

function onControlKeyDown(event) {
    if (event.key === "Tab") {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
    }

    if (!isTextEntryTarget(event.target) && event.target.closest(".times-list") && KEYBOARD_SCROLL_KEYS.has(event.code)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
    }

    if (event.code !== "Space") return;
    if (!event.target.closest(MOUSE_ONLY_NAVIGATION_SELECTOR)) return;

    event.preventDefault();
    event.stopImmediatePropagation();
}

function enforceMouseOnlyNavigation(root = document) {
    root.querySelectorAll(MOUSE_ONLY_NAVIGATION_SELECTOR).forEach(makeMouseOnlyControl);
}

function makeMouseOnlyControl(control) {
    control.tabIndex = -1;
    if (control.dataset.mouseOnlyNavigation === "true") return;

    control.dataset.mouseOnlyNavigation = "true";
    if (control.matches("button, a, [role='separator']")) {
        control.addEventListener("mousedown", (event) => event.preventDefault());
    }
    if (control.matches(".scramble-panel, .times-list, .average-times")) {
        control.addEventListener("pointerup", () => control.blur());
        control.addEventListener("focus", () => {
            window.requestAnimationFrame(() => control.blur());
        });
    }
}

function onKeyDown(event) {
    if (event.code === "Space" && !isTextEntryTarget(event.target)) {
        event.preventDefault();
    }
    if (event.repeat) return;

    if (state.timerState === "running") {
        event.preventDefault();
        recordPhaseOrStop();
        return;
    }

    if (isInteractiveTarget(event.target)) return;

    if (event.key === "Enter" && (
        state.timerState === "holding"
        || state.timerState === "ready"
        || isInspectionState()
    )) {
        event.preventDefault();
        if (isInspectionState()) cancelInspection();
        else cancelTimerReadying();
        return;
    }

    if (event.key === "Enter" && state.timerState === "idle") {
        event.preventDefault();
        resetTimerDisplay();
        return;
    }

    if (event.code !== "Space") return;
    pressTimer();
}

function onKeyUp(event) {
    if (event.code !== "Space") return;
    event.preventDefault();
    releaseTimer();
}

function onTouchStart(event) {
    if (isInteractiveTarget(event.target)) return;
    if (state.touchIdentifier !== null) return;
    event.preventDefault();
    state.touchIdentifier = event.changedTouches[0].identifier;
    pressTimer();
}

function onTouchEnd(event) {
    const finishedTouch = Array.from(event.changedTouches).find((touch) => touch.identifier === state.touchIdentifier,);
    if (!finishedTouch) return;

    event.preventDefault();
    state.touchIdentifier = null;
    releaseTimer();
}

function pressTimer() {
    if (state.timerState === "running") {
        recordPhaseOrStop();
        return;
    }

    if (isInspectionState()) {
        if (state.timerState !== "inspection") return;
        state.timerState = "inspection-holding";
        state.holdTimeout = window.setTimeout(() => {
            if (state.timerState !== "inspection-holding") return;
            state.timerState = "inspection-ready";
            renderTimerState();
        }, READY_DELAY_MS);
        renderTimerState();
        return;
    }

    if (!state.redoSolveId && state.scrambles.length === 0) {
        statusEl.textContent = `No ${getEventLabel(state.activeEvent)} scrambles loaded`;
        return;
    }

    if (state.timerState !== "idle") return;

    state.timerState = "holding";
    state.holdTimeout = window.setTimeout(() => {
        if (state.timerState !== "holding") return;
        state.timerState = "ready";
        renderTimerState();
    }, READY_DELAY_MS);
    renderTimerState();
}

function releaseTimer() {
    if (state.timerState === "inspection-holding") {
        clearHoldTimeout();
        state.timerState = "inspection";
        renderTimerState();
        return;
    }

    if (state.timerState === "inspection-ready") {
        clearHoldTimeout();
        startTimer();
        return;
    }

    if (state.timerState === "holding") {
        cancelTimerReadying();
        return;
    }

    if (state.timerState === "ready") {
        clearHoldTimeout();
        if (state.inspectionEnabled) beginInspection();
        else startTimer();
    }
}

function cancelTimerReadying() {
    clearHoldTimeout();
    state.timerState = "idle";
    renderTimerState();
}

function resetTimerDisplay() {
    state.lastDisplayMs = 0;
    saveState();
    renderTimerState();
}

function startTimer() {
    clearInspection();
    state.timerState = "running";
    state.startTime = performance.now();
    state.elapsedMs = 0;
    state.lastDisplayMs = 0;
    state.phaseTimesMs = [];
    state.splitInputReadyAt = 0;
    renderTimerState();
    tick();
}

function beginInspection() {
    clearHoldTimeout();
    clearInspection();
    state.timerState = "inspection";
    state.inspectionDeadline = performance.now() + INSPECTION_DURATION_MS;
    renderTimerState();
    renderInspectionCountdown();
}

function renderInspectionCountdown() {
    if (!isInspectionState()) return;

    const remaining = Math.max(0, state.inspectionDeadline - performance.now());
    timerEl.className = `timer ${getInspectionColorClass(remaining)}`;
    timerEl.textContent = formatTime(remaining);
    inspectionEnabledEl.disabled = true;

    if (remaining <= 0) {
        startTimer();
        return;
    }

    state.inspectionAnimationFrame = requestAnimationFrame(renderInspectionCountdown);
}

function getInspectionColorClass(remaining) {
    if (remaining <= INSPECTION_DANGER_THRESHOLD_MS) return "inspection-danger";
    if (remaining <= INSPECTION_HOLD_THRESHOLD_MS) return "inspection-hold";
    return "inspection-ready";
}

function isInspectionState() {
    return state.timerState === "inspection"
        || state.timerState === "inspection-holding"
        || state.timerState === "inspection-ready";
}

function clearInspection() {
    cancelAnimationFrame(state.inspectionAnimationFrame);
    state.inspectionAnimationFrame = null;
    state.inspectionDeadline = 0;
}

function cancelInspection() {
    clearHoldTimeout();
    clearInspection();
    state.timerState = "idle";
    renderTimerState();
}

function recordPhaseOrStop() {
    const phaseCount = getActivePhaseCount();
    if (!phaseCount) {
        stopTimer();
        return;
    }

    const now = performance.now();
    if (now < state.splitInputReadyAt) return;
    state.splitInputReadyAt = now + SPLIT_INPUT_GRACE_MS;

    const elapsed = now - state.startTime;
    const previousTotal = state.phaseTimesMs.reduce((sum, value) => sum + value, 0);
    state.phaseTimesMs.push(Math.max(0, Math.round(elapsed) - previousTotal));
    if (state.phaseTimesMs.length >= phaseCount) {
        stopTimer(elapsed);
    } else {
        renderTimerState();
    }
}

function stopTimer(elapsed = performance.now() - state.startTime) {
    state.elapsedMs = elapsed;
    state.lastDisplayMs = state.elapsedMs;
    state.timerState = "idle";
    state.splitInputReadyAt = 0;
    cancelAnimationFrame(state.animationFrame);

    const solve = {
        id: crypto.randomUUID(),
        event: state.activeEvent,
        sessionId: state.activeSessionId,
        timeMs: Math.round(state.elapsedMs),
        scramble: getCurrentScramble(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        penalty: "OK",
        ...(state.phaseTimesMs.length ? {phaseTimesMs: [...state.phaseTimesMs]} : {}),
    };

    if (state.redoSolveId) {
        replaceRedoneSolve(solve);
        cancelRedo();
    } else {
        state.solves.unshift(solve);
        setScrambleIndex(getRandomScrambleIndex());
    }

    saveState({sync: true});
    render();
}

function tick() {
    if (state.timerState !== "running") return;

    state.elapsedMs = performance.now() - state.startTime;
    renderRunningTimerValue(state.elapsedMs);
    state.animationFrame = requestAnimationFrame(tick);
}

function renderRunningTimerValue(elapsed) {
    if (state.timerUpdateMs === 0) {
        timerEl.textContent = "Solve!";
        return;
    }

    const displayedElapsed = Math.floor(elapsed / state.timerUpdateMs) * state.timerUpdateMs;
    timerEl.textContent = formatTime(displayedElapsed);
}

function render() {
    renderTimerState();
    renderScrambleFontSize();
    renderScramble();
    syncScrambleMinHeight();
    enforceMouseOnlyNavigation();
    renderStats();
    renderTimes();
    renderScrambleDrawingVisibility();
}

function renderScrambleDrawingVisibility() {
    drawingEnabledEl.checked = state.drawingEnabled;
    scrambleDrawingPanelEl.hidden = !state.drawingEnabled;
}

function renderScrambleFontSize() {
    scrambleEl.style.fontSize = `${state.scrambleFontSize.toFixed(1)}rem`;
}

function renderEventOptions() {
    eventSelectEl.replaceChildren();
    newSessionEventEl.replaceChildren();

    EVENTS.forEach(([eventId, label]) => {
        const option = document.createElement("option");
        option.value = eventId;
        option.textContent = label;
        eventSelectEl.append(option);

        const sessionOption = option.cloneNode(true);
        newSessionEventEl.append(sessionOption);
    });

    eventSelectEl.value = state.activeEvent;
}

function renderSessionOptions() {
    sessionSelectEl.replaceChildren();
    if (!getVisibleSessions().some((session) => session.id === state.activeSessionId)) {
        state.activeSessionId = PLAYGROUND_SESSION_ID;
    }

    getVisibleSessions().forEach((session) => {
        const option = document.createElement("option");
        option.value = session.id;
        option.textContent = session.name;
        sessionSelectEl.append(option);
    });

    sessionSelectEl.value = state.activeSessionId;
    renderSessionEventControl();
}

function renderSessionEventControl() {
    const session = getActiveSession();
    const isPlayground = session.id === PLAYGROUND_SESSION_ID;
    eventSelectEl.closest(".event-picker").hidden = !isPlayground;
    fixedEventLabelEl.hidden = isPlayground;
    fixedEventLabelEl.textContent = getEventLabel(getActiveEvent());
}

async function createSession() {
    const event = getValidEventId(newSessionEventEl.value);
    const name = newSessionNameEl.value.trim() || `${getEventLabel(event)} session`;
    const phaseCount = readPhaseCount(newSessionSplitsEl.value);
    const now = Date.now();
    const session = {
        id: crypto.randomUUID(),
        name,
        event,
        createdAt: now,
        updatedAt: now,
        ...(phaseCount ? {phaseCount} : {}),
    };

    state.sessions.push(session);
    saveState({sync: true});
    createSessionDialogEl.close();
    renderSessionOptions();
    await switchSession(session.id);
}

async function switchSession(sessionId, {deferHistory = false} = {}) {
    const session = getVisibleSessions().find((entry) => entry.id === sessionId) || createPlaygroundSession();
    state.activeSessionId = session.id;
    sessionSelectEl.value = session.id;
    renderSessionEventControl();
    await switchEvent(session.event || state.playgroundEvent, {updatePlayground: false, deferHistory});
}

async function switchEvent(eventId, {
    updatePlayground = isPlaygroundSession(),
    deferHistory = false,
} = {}) {
    const nextEvent = getValidEventId(eventId);
    const previousEvent = state.activeEvent;

    state.activeEvent = nextEvent;
    if (updatePlayground) {
        state.playgroundEvent = nextEvent;
    }
    eventSelectEl.value = nextEvent;
    cancelRedo();
    state.lastDisplayMs = 0;
    state.scrambles = [];
    scrambleEl.textContent = `Loading ${getEventLabel(nextEvent)} scrambles...`;
    if (deferHistory) {
        renderTimesLoading();
    } else {
        renderStats();
        renderTimes();
    }

    try {
        state.scrambles = await loadScrambles(nextEvent);
        setScrambleIndex(clampScrambleIndex(getScrambleIndex()));
        saveState();
        if (deferHistory) renderBeforeHistory();
        else render();
    } catch (error) {
        state.activeEvent = nextEvent;
        state.scrambles = [];
        saveState();
        render();
        scrambleEl.textContent = error.message;
        statusEl.textContent = previousEvent === nextEvent ? "Add the scramble file, then reload or choose this event again" : "Add the scramble file, then choose this event again";
    }
}

function renderBeforeHistory() {
    renderTimerState();
    renderScrambleFontSize();
    renderScramble();
    syncScrambleMinHeight();
    enforceMouseOnlyNavigation();
    renderScrambleDrawingVisibility();
}

function createPlaygroundSession() {
    return {
        id: PLAYGROUND_SESSION_ID, name: "Playground", event: null, createdAt: 0, updatedAt: 0,
    };
}

function getActiveSession() {
    return getVisibleSessions().find((session) => session.id === state.activeSessionId) || createPlaygroundSession();
}

function getActiveEvent() {
    return getActiveSession().event || state.playgroundEvent;
}

function isPlaygroundSession() {
    return state.activeSessionId === PLAYGROUND_SESSION_ID;
}

function renderScramble() {
    const total = state.scrambles.length;
    const scramble = getCurrentScramble();
    scrambleEl.textContent = scramble || "No scramble loaded";
    scrambleDrawingEl.setAttribute("event", state.activeEvent);
    scrambleDrawingEl.setAttribute("scramble", scramble);
}

function syncScrambleMinHeight() {
    const panelStyle = getComputedStyle(scramblePanelEl);
    const metaStyle = getComputedStyle(scrambleMetaEl);
    const baseMinHeight = getCssPixelValue("--scramble-base-min-height") || 160;
    const verticalPadding = Number.parseFloat(panelStyle.paddingTop) + Number.parseFloat(panelStyle.paddingBottom);
    const metaHeight = scrambleMetaEl.offsetHeight + Number.parseFloat(metaStyle.marginTop) + Number.parseFloat(metaStyle.marginBottom);
    const requiredHeight = Math.ceil(verticalPadding + metaHeight + scrambleEl.scrollHeight + 6);
    const nextMinHeight = Math.max(baseMinHeight, requiredHeight);

    appEl.style.setProperty("--scramble-min-height", `${nextMinHeight}px`);

    if (getCssPixelValue("--scramble-height") < nextMinHeight) {
        appEl.style.setProperty("--scramble-height", `${nextMinHeight}px`);
    }
}

function renderTimerState() {
    inspectionEnabledEl.checked = state.inspectionEnabled;
    inspectionEnabledEl.disabled = state.timerState !== "idle";
    timerUpdateMsEl.disabled = state.timerState !== "idle";
    if (document.activeElement !== timerUpdateMsEl) {
        timerUpdateMsEl.value = String(state.timerUpdateMs);
    }

    if (isInspectionState()) {
        const remaining = Math.max(0, state.inspectionDeadline - performance.now());
        timerEl.className = `timer ${getInspectionColorClass(remaining)}`;
        timerEl.textContent = formatTime(remaining);
        statusEl.textContent = state.timerState === "inspection-ready"
            ? "Release to start"
            : state.timerState === "inspection-holding"
                ? "Keep holding"
                : "Inspect";
        return;
    }

    timerEl.className = `timer ${state.timerState}`;

    if (state.timerState === "running") {
        renderRunningTimerValue(state.elapsedMs);
        const phaseCount = getActivePhaseCount();
        statusEl.textContent = phaseCount
            ? `Solving ${getPhaseName(getActiveSession(), state.phaseTimesMs.length)} (${state.phaseTimesMs.length + 1} of ${phaseCount})`
            : "Press any key or tap to stop";
        return;
    }

    if (state.timerState === "holding") {
        statusEl.textContent = state.redoSolveId ? "Redo readying" : "Keep holding";
        timerEl.textContent = formatTime(state.lastDisplayMs);
        return;
    }

    if (state.timerState === "ready") {
        statusEl.textContent = "Release to start (press enter to cancel)";
        timerEl.textContent = formatTime(state.lastDisplayMs);
        return;
    }

    statusEl.textContent = state.redoSolveId ? "Redo mode: hold space to replace the selected time" : "Hold space to ready, release to start";
    timerEl.textContent = formatTime(state.lastDisplayMs);
}

function renderStats() {
    const stats = buildStats();
    statsBodyEl.replaceChildren();

    stats.forEach((stat) => {
        const row = document.createElement("tr");

        const label = document.createElement("th");
        label.scope = "row";
        label.textContent = stat.label;

        const current = document.createElement("td");
        renderStatValueCell(current, stat, "current");

        const best = document.createElement("td");
        renderStatValueCell(best, stat, "best");

        row.append(label, current, best);
        statsBodyEl.append(row);
    });
}

function renderStatValueCell(cell, stat, column) {
    const value = stat[column];
    const text = stat.inspectable ? formatAverageValue(value?.value) : formatStatValue(value?.value);
    const canInspect = stat.inspectable && value?.solves?.length;

    if (!canInspect) {
        cell.textContent = text;
        return;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "stat-average-button";
    button.dataset.statAverage = stat.id;
    button.dataset.statColumn = column;
    button.textContent = text;
    makeMouseOnlyControl(button);
    cell.append(button);
}

function openStatsEditor() {
    statsEditorStatusEl.textContent = "";
    syncNewStatSizeMinimum();
    renderStatsEditor();
    statsEditorDialogEl.showModal();
}

function renderStatsEditor() {
    statsEditorListEl.replaceChildren();
    state.statsConfig.forEach((config) => {
        const item = document.createElement("li");
        item.className = "stats-editor-item";
        item.dataset.statId = config.id;

        const handle = document.createElement("span");
        handle.className = "stats-drag-handle";
        handle.title = "Drag to reorder";
        handle.dataset.dragStat = config.id;
        handle.setAttribute("role", "button");
        handle.setAttribute("aria-label", `Drag ${getStatLabel(config)}`);
        handle.innerHTML = "<span class=\"material-symbols-outlined\" aria-hidden=\"true\">menu</span>";

        const label = document.createElement("span");
        label.className = "stats-editor-label";
        label.textContent = getStatLabel(config);

        const trimValue = document.createElement("input");
        trimValue.className = "stats-trim-input";
        trimValue.type = "number";
        trimValue.min = "0";
        trimValue.step = "1";
        trimValue.inputMode = "numeric";
        trimValue.value = String(config.type === "average" ? config.trimValue : 0);
        trimValue.disabled = config.type !== "average";
        trimValue.dataset.statTrimValue = config.id;
        trimValue.setAttribute("aria-label", `${getStatLabel(config)} trim amount`);
        makeMouseOnlyControl(trimValue);

        const trimUnit = document.createElement("select");
        trimUnit.className = "stats-trim-unit";
        trimUnit.disabled = config.type !== "average";
        trimUnit.dataset.statTrimUnit = config.id;
        trimUnit.setAttribute("aria-label", `${getStatLabel(config)} trim unit`);
        trimUnit.append(new Option("solves", "solves"), new Option("%", "percent"));
        trimUnit.value = config.type === "average" ? config.trimUnit : "solves";
        makeMouseOnlyControl(trimUnit);

        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "stats-remove-button";
        remove.title = "Remove stat";
        remove.setAttribute("aria-label", `Remove ${getStatLabel(config)}`);
        remove.dataset.removeStat = config.id;
        remove.innerHTML = "<span class=\"material-symbols-outlined\" aria-hidden=\"true\">close</span>";
        makeMouseOnlyControl(remove);

        item.append(handle, label, trimValue, trimUnit, remove);
        statsEditorListEl.append(item);
    });
}

function addConfiguredStat() {
    syncNewStatSizeMinimum();
    const type = newStatTypeEl.value === "average" ? "average" : "mean";
    const size = normalizeStatSize(newStatSizeEl.value, type);
    if (!size) {
        statsEditorStatusEl.textContent = type === "average"
            ? "Averages need at least 3 solves."
            : "Means need at least 2 solves.";
        return;
    }

    state.statsConfig.push({
        id: crypto.randomUUID(),
        type,
        size,
        ...(type === "average" ? {trimValue: 1, trimUnit: "solves"} : {}),
    });
    statsEditorStatusEl.textContent = "";
    commitStatsConfig();
}

function syncNewStatSizeMinimum() {
    const minimum = newStatTypeEl.value === "average" ? 3 : 2;
    newStatSizeEl.min = String(minimum);
    if (Number(newStatSizeEl.value) < minimum) {
        newStatSizeEl.value = String(minimum);
    }
}

function onStatsEditorConfigChange(event) {
    const trimValueControl = event.target.closest("[data-stat-trim-value]");
    const trimUnitControl = event.target.closest("[data-stat-trim-unit]");
    const id = trimValueControl?.dataset.statTrimValue || trimUnitControl?.dataset.statTrimUnit;
    if (!id) return;

    state.statsConfig = state.statsConfig.map((config) => {
        if (config.id !== id || config.type !== "average") return config;
        return normalizeStatConfig({
            ...config,
            ...(trimValueControl ? {trimValue: trimValueControl.value} : {}),
            ...(trimUnitControl ? {trimUnit: trimUnitControl.value} : {}),
        });
    });
    statsEditorStatusEl.textContent = "";
    commitStatsConfig();
}

function removeConfiguredStat(id) {
    state.statsConfig = state.statsConfig.filter((config) => config.id !== id);
    statsEditorStatusEl.textContent = "";
    commitStatsConfig();
}

function onStatsEditorPointerDown(event) {
    const handle = event.target.closest("[data-drag-stat]");
    if (!handle || event.button !== 0) return;
    const draggedId = handle.dataset.dragStat;
    const draggedItem = handle.closest(".stats-editor-item");
    if (!draggedId || !draggedItem) return;

    event.preventDefault();
    draggedItem.classList.add("dragging");
    updateStatsEditorDropIndicator(draggedId, null);
    document.body.classList.add("stats-dragging");

    function onPointerMove(moveEvent) {
        const target = getStatsEditorDragTarget(draggedId, moveEvent.clientY);
        if (!target) return;
        const {targetId, placeAfter} = target;
        updateStatsEditorDropIndicator(draggedId, target);
        reorderConfiguredStat(draggedId, targetId, placeAfter, false);
        const currentDraggedItem = statsEditorListEl.querySelector(`[data-stat-id="${CSS.escape(draggedId)}"]`);
        const targetItem = statsEditorListEl.querySelector(`[data-stat-id="${CSS.escape(targetId)}"]`);
        if (currentDraggedItem && targetItem) {
            statsEditorListEl.insertBefore(currentDraggedItem, placeAfter ? targetItem.nextSibling : targetItem);
            currentDraggedItem.classList.add("dragging");
        }
    }

    function onPointerEnd() {
        document.body.classList.remove("stats-dragging");
        clearStatsEditorDropIndicator();
        statsEditorListEl.querySelectorAll(".stats-editor-item.dragging").forEach((item) => {
            item.classList.remove("dragging");
        });
        commitStatsConfig();
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerEnd);
        window.removeEventListener("pointercancel", onPointerEnd);
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerEnd);
    window.addEventListener("pointercancel", onPointerEnd);
}

function updateStatsEditorDropIndicator(draggedId, target) {
    clearStatsEditorDropIndicator();
    if (!target) return;
    const targetItem = statsEditorListEl.querySelector(`[data-stat-id="${CSS.escape(target.targetId)}"]`);
    if (!targetItem || target.targetId === draggedId) return;
    targetItem.classList.add(target.placeAfter ? "drop-after" : "drop-before");
}

function clearStatsEditorDropIndicator() {
    statsEditorListEl.querySelectorAll(".drop-before, .drop-after").forEach((item) => {
        item.classList.remove("drop-before", "drop-after");
    });
}

function getStatsEditorDragTarget(draggedId, pointerY) {
    const items = [...statsEditorListEl.querySelectorAll(".stats-editor-item")]
        .filter((item) => item.dataset.statId !== draggedId);
    for (const item of items) {
        const rect = item.getBoundingClientRect();
        if (pointerY >= rect.top && pointerY <= rect.bottom) {
            return {
                targetId: item.dataset.statId,
                placeAfter: pointerY > rect.top + rect.height / 2,
            };
        }
    }
    const first = items[0];
    const last = items.at(-1);
    if (first && pointerY < first.getBoundingClientRect().top) {
        return {targetId: first.dataset.statId, placeAfter: false};
    }
    if (last && pointerY > last.getBoundingClientRect().bottom) {
        return {targetId: last.dataset.statId, placeAfter: true};
    }
    return null;
}

function reorderConfiguredStat(draggedId, targetId, placeAfter = false, commit = true) {
    const configs = [...state.statsConfig];
    const fromIndex = configs.findIndex((config) => config.id === draggedId);
    const toIndex = configs.findIndex((config) => config.id === targetId);
    if (fromIndex < 0 || toIndex < 0) return;
    const [moved] = configs.splice(fromIndex, 1);
    const adjustedTargetIndex = configs.findIndex((config) => config.id === targetId);
    configs.splice(adjustedTargetIndex + (placeAfter ? 1 : 0), 0, moved);
    state.statsConfig = configs;
    if (commit) {
        commitStatsConfig();
    }
}

function commitStatsConfig() {
    state.statsConfig = normalizeStatsConfig(state.statsConfig);
    saveState({sync: true});
    renderStats();
    renderStatsEditor();
    syncTimesPanelMinWidth();
}

function renderTimes() {
    clearTimesLoading();
    timesListEl.removeAttribute("aria-busy");
    timesListEl.replaceChildren();
    const activeSolves = getActiveSolves();
    const personalBestSolveIds = getRollingPersonalBestSolveIds(activeSolves);
    const phaseCount = getActivePhaseCount();
    updateTimesPanelMinWidth(phaseCount);

    if (activeSolves.length === 0) {
        const empty = document.createElement("li");
        empty.className = "empty";
        empty.textContent = `No solves in ${getActiveSession().name} yet`;
        timesListEl.append(empty);
        syncTimesPanelMinWidth();
        return;
    }

    if (phaseCount) {
        const header = document.createElement("li");
        header.className = "time-columns-header";
        header.style.setProperty("--phase-count", String(phaseCount));
        ["#", "Time"].forEach((label) => {
            const cell = document.createElement("span");
            cell.textContent = label;
            header.append(cell);
        });
        for (let phase = 0; phase < phaseCount; phase += 1) {
            const cell = document.createElement("span");
            cell.dataset.phaseIndex = String(phase);
            cell.title = "Double-click to rename";
            cell.textContent = getPhaseName(getActiveSession(), phase);
            header.append(cell);
        }
        timesListEl.append(header);
    }

    activeSolves.forEach((solve, index) => {
        const item = document.createElement("li");
        item.className = `time-entry${phaseCount ? " split-time-entry" : ""}`;
        if (phaseCount) item.style.setProperty("--phase-count", String(phaseCount));
        item.dataset.solveId = solve.id;
        if (solve.id === state.redoSolveId) {
            item.classList.add("redo-active");
        }
        if (solve.redoCount) {
            item.classList.add("redone");
        }
        if (personalBestSolveIds.has(solve.id)) {
            item.classList.add("personal-best");
        }

        const row = document.createElement("div");
        row.className = `time-row${phaseCount ? " split-time-row" : ""}`;
        if (phaseCount) row.style.setProperty("--phase-count", String(phaseCount));

        const solveNumber = document.createElement("span");
        solveNumber.className = "time-index";
        solveNumber.textContent = String(activeSolves.length - index);

        const value = document.createElement("span");
        value.className = "time-value";
        value.textContent = formatSolveTime(solve);

        row.append(solveNumber, value);

        if (phaseCount) {
            for (let phase = 0; phase < phaseCount; phase += 1) {
                const phaseValue = document.createElement("span");
                phaseValue.className = "phase-time-value";
                const phaseTime = Number(solve.phaseTimesMs?.[phase]);
                phaseValue.textContent = Number.isFinite(phaseTime) ? formatTime(phaseTime) : "--";
                row.append(phaseValue);
            }
        }

        const penaltyBadge = createPenaltyBadge(solve);
        if (penaltyBadge) {
            value.append(" ", penaltyBadge);
        }

        if (solve.redoCount) {
            const badge = document.createElement("span");
            badge.className = "redo-badge";
            badge.textContent = `${solve.redoCount}x`;
            value.append(" ", badge);
        }

        if (personalBestSolveIds.has(solve.id)) {
            const badge = document.createElement("span");
            badge.className = "pb-badge";
            badge.textContent = "PB";
            value.append(" ", badge);
        }

        const details = document.createElement("div");
        details.className = "time-details";

        const scramble = document.createElement("span");
        scramble.className = "time-scramble";
        scramble.textContent = solve.scramble;

        const actions = document.createElement("div");
        actions.className = "time-actions";

        const redoButton = document.createElement("button");
        redoButton.type = "button";
        redoButton.dataset.action = "redo";
        redoButton.dataset.solveId = solve.id;
        redoButton.textContent = solve.id === state.redoSolveId ? "Redoing" : "Redo";
        makeMouseOnlyControl(redoButton);

        const deleteButton = document.createElement("button");
        deleteButton.type = "button";
        deleteButton.dataset.action = "delete";
        deleteButton.dataset.solveId = solve.id;
        deleteButton.textContent = "Delete";
        makeMouseOnlyControl(deleteButton);

        const penaltyActions = document.createElement("div");
        penaltyActions.className = "penalty-actions";

        [["OK", "OK"], ["+2", "+2"], ["DNF", "DNF"], ["POP", "POP"],].forEach(([penalty, label]) => {
            const penaltyButton = document.createElement("button");
            penaltyButton.type = "button";
            penaltyButton.dataset.action = "penalty";
            penaltyButton.dataset.penalty = penalty;
            penaltyButton.dataset.solveId = solve.id;
            penaltyButton.textContent = label;
            penaltyButton.classList.toggle("selected", getSolvePenalty(solve) === penalty);
            makeMouseOnlyControl(penaltyButton);
            penaltyActions.append(penaltyButton);
        });

        actions.append(penaltyActions, redoButton, deleteButton);
        details.append(scramble, actions);
        item.append(row, details);

        timesListEl.append(item);
    });

    syncTimesPanelMinWidth();
}

function renderTimesLoading() {
    clearTimesLoading();
    updateTimesPanelMinWidth(getActivePhaseCount());
    timesListEl.setAttribute("aria-busy", "true");
    timesListEl.replaceChildren();

    const loading = document.createElement("li");
    loading.className = "empty";
    timesListEl.append(loading);

    let dotCount = 1;
    const updateLabel = () => {
        loading.textContent = `Loading solve history${".".repeat(dotCount)}`;
        dotCount = dotCount === 3 ? 1 : dotCount + 1;
    };
    updateLabel();
    state.timesLoadingInterval = window.setInterval(updateLabel, 450);
}

function clearTimesLoading() {
    window.clearInterval(state.timesLoadingInterval);
    state.timesLoadingInterval = null;
}

function showAverageDialog(statId, column) {
    const stat = buildStats().find((entry) => entry.id === statId);
    const average = stat?.inspectable ? stat[column] : null;
    if (!average?.solves?.length) return;

    const trimmedIds = getAverageTrimmedSolveIds(average.solves, stat.trimCount);
    const columnLabel = column === "best" ? "Best" : "Current";
    const averageText = formatAverageValue(average.value);
    averageDialogTitleEl.textContent = `${columnLabel} ${stat.label} ${averageText}`;
    averageDialogTimesEl.replaceChildren();

    average.solves.forEach((solve) => {
        const item = document.createElement("li");
        item.classList.toggle("average-best", trimmedIds.best.has(solve.id));
        item.classList.toggle("average-worst", trimmedIds.worst.has(solve.id));
        item.textContent = formatAverageSolveLine(solve, trimmedIds);
        averageDialogTimesEl.append(item);
    });

    averageDialogLog = [`${columnLabel} ${stat.label} of ${averageText} on ${getEventLabel(getActiveEvent())}:`, "", ...average.solves.map((solve) => formatAverageSolveLine(solve, trimmedIds)),].join("\n");

    averageDialogEl.showModal();
}

async function copyAverageLog() {
    if (!averageDialogLog) return;

    try {
        await navigator.clipboard.writeText(averageDialogLog);
    } catch {
        copyTextWithFallback(averageDialogLog);
    }

    statusEl.textContent = "Average log copied";
}

function formatAverageSolveLine(solve, trimmedIds) {
    const penalty = getPenaltyText(solve);
    const line = `${formatSolveTime(solve)}${penalty ? ` ${penalty}` : ""}`;
    return trimmedIds.best.has(solve.id) || trimmedIds.worst.has(solve.id) ? `(${line})` : line;
}

function getAverageTrimmedSolveIds(solves, trimCount) {
    const best = new Set();
    const worst = new Set();
    if (!trimCount) return {best, worst};
    const sorted = [...solves].sort((left, right) => getAdjustedTime(left) - getAdjustedTime(right));
    sorted.slice(0, trimCount).forEach((solve) => best.add(solve.id));
    sorted.slice(-trimCount).forEach((solve) => worst.add(solve.id));
    return {best, worst};
}

function getRollingPersonalBestSolveIds(solves) {
    const personalBestSolveIds = new Set();
    let bestTime = Infinity;

    [...solves]
        .sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0))
        .forEach((solve) => {
            const adjustedTime = getAdjustedTime(solve);
            if (!Number.isFinite(adjustedTime) || adjustedTime >= bestTime) return;

            bestTime = adjustedTime;
            personalBestSolveIds.add(solve.id);
        });

    return personalBestSolveIds;
}

function saveState({sync = false} = {}) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(createStoredState()),);
    if (!sync) return;
    state.syncRevision += 1;
    localStorage.setItem(SYNC_DIRTY_STORAGE_KEY, String(Date.now()));
    scheduleSync();
}

function loadSavedState() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;

    try {
        const saved = JSON.parse(raw);
        state.playgroundEvent = getValidEventId(saved.playgroundEvent || saved.activeEvent || "333");
        state.activeEvent = state.playgroundEvent;
        state.sessions = normalizeSessions(saved.sessions);
        state.activeSessionId = getVisibleSessions().some((session) => session.id === saved.activeSessionId) ? saved.activeSessionId : PLAYGROUND_SESSION_ID;
        state.sessionScrambleIndexes = normalizeSessionScrambleIndexes(saved);
        state.solves = Array.isArray(saved.solves) ? saved.solves.map((solve) => ({
            ...solve, event: solve.event || "333", sessionId: solve.sessionId || PLAYGROUND_SESSION_ID,
        })) : [];
        state.lastDisplayMs = Number(saved.lastDisplayMs) || 0;
        state.scrambleFontSize = clamp(Number(saved.scrambleFontSize) || 1.9, 0.9, 3.2);
        state.statsConfig = normalizeStatsConfig(saved.statsConfig);
        state.inspectionEnabled = Boolean(saved.inspectionEnabled);
        state.drawingEnabled = saved.drawingEnabled !== false;
        state.timerUpdateMs = normalizeTimerUpdateMs(saved.timerUpdateMs);
        state.theme = saved.theme || {};
        if (localStorage.getItem(SYNC_DIRTY_STORAGE_KEY)) {
            state.syncRevision = 1;
        }
    } catch {
        localStorage.removeItem(STORAGE_KEY);
    }
}

function getCurrentScramble() {
    if (state.redoSolveId) return state.redoScramble;
    return state.scrambles[getScrambleIndex()] || "";
}

function getScrambleIndex() {
    return Number(state.sessionScrambleIndexes[getScrambleIndexKey()]) || 0;
}

function setScrambleIndex(index) {
    state.sessionScrambleIndexes[getScrambleIndexKey()] = index;
}

function getActiveSolves() {
    return state.solves
        .filter((solve) => !solve.deletedAt && getSolveSessionId(solve) === state.activeSessionId)
        .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0));
}

function getChronologicalActiveSolves() {
    return getActiveSolves().sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0));
}

function getSolveEvent(solve) {
    return solve.event || "333";
}

function getSolveSessionId(solve) {
    return solve.sessionId || PLAYGROUND_SESSION_ID;
}

function readPhaseCount(value) {
    const count = Math.floor(Number(value) || 0);
    return count >= 1 ? Math.min(count, 20) : 0;
}

function getActivePhaseCount() {
    return readPhaseCount(getActiveSession()?.phaseCount);
}

function getPhaseName(session, phaseIndex) {
    const savedName = session?.phaseNames?.[phaseIndex];
    return typeof savedName === "string" && savedName.trim() ? savedName.trim() : `P${phaseIndex + 1}`;
}

function editPhaseName(cell) {
    if (cell.querySelector("input") || state.timerState === "running") return;
    const phaseIndex = Number(cell.dataset.phaseIndex);
    if (!Number.isInteger(phaseIndex)) return;
    const session = getActiveSession();
    if (session.id === PLAYGROUND_SESSION_ID) return;

    const originalName = getPhaseName(session, phaseIndex);
    const input = document.createElement("input");
    input.className = "phase-name-input";
    input.maxLength = 24;
    input.value = originalName;
    cell.replaceChildren(input);
    input.focus();
    input.select();

    let finished = false;
    const finish = (save) => {
        if (finished) return;
        finished = true;
        const nextName = input.value.trim();
        if (save) {
            const phaseNames = Array.isArray(session.phaseNames) ? [...session.phaseNames] : [];
            phaseNames[phaseIndex] = nextName && nextName !== `P${phaseIndex + 1}` ? nextName : null;
            while (phaseNames.length && !phaseNames[phaseNames.length - 1]) phaseNames.pop();
            if (phaseNames.length) session.phaseNames = phaseNames;
            else delete session.phaseNames;
            session.updatedAt = Date.now();
            saveState({sync: true});
        }
        cell.textContent = save ? getPhaseName(session, phaseIndex) : originalName;
        window.requestAnimationFrame(syncTimesPanelMinWidth);
    };
    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            finish(true);
        } else if (event.key === "Escape") {
            event.preventDefault();
            finish(false);
        }
    });
    input.addEventListener("blur", () => finish(true));
}

function getScrambleIndexKey() {
    return isPlaygroundSession() ? `${PLAYGROUND_SESSION_ID}:${state.activeEvent}` : state.activeSessionId;
}

function normalizeSessions(sessions) {
    const namedSessions = Array.isArray(sessions) ? sessions.filter((session) => session.id && session.id !== PLAYGROUND_SESSION_ID) : [];
    return [createPlaygroundSession(), ...namedSessions];
}

function getVisibleSessions() {
    return state.sessions.filter((session) => !session.deletedAt);
}

function normalizeSessionScrambleIndexes(saved) {
    if (saved.sessionScrambleIndexes && typeof saved.sessionScrambleIndexes === "object") {
        return saved.sessionScrambleIndexes;
    }

    const indexes = {};
    const legacyIndexes = saved.scrambleIndexes && typeof saved.scrambleIndexes === "object" ? saved.scrambleIndexes : {[state.playgroundEvent]: Number(saved.scrambleIndex) || 0};
    Object.entries(legacyIndexes).forEach(([event, index]) => {
        indexes[`${PLAYGROUND_SESSION_ID}:${event}`] = index;
    });
    return indexes;
}

function getValidEventId(eventId) {
    return EVENTS.some(([id]) => id === eventId) ? eventId : "333";
}

function getEventLabel(eventId) {
    return EVENTS.find(([id]) => id === eventId)?.[1] || eventId;
}

function clampScrambleIndex(index) {
    if (state.scrambles.length === 0) return 0;
    return ((index % state.scrambles.length) + state.scrambles.length) % state.scrambles.length;
}

function clearHoldTimeout() {
    window.clearTimeout(state.holdTimeout);
    state.holdTimeout = null;
}

function startRedo(solveId) {
    const solve = getActiveSolves().find((entry) => entry.id === solveId);
    if (!solve) return;

    state.redoSolveId = solve.id;
    state.redoScramble = solve.scramble;
    state.lastDisplayMs = solve.timeMs;
    render();
}

function cancelRedo() {
    state.redoSolveId = null;
    state.redoScramble = "";
}

function replaceRedoneSolve(newSolve) {
    const index = state.solves.findIndex((entry) => entry.id === state.redoSolveId);
    if (index === -1) {
        state.solves.unshift(newSolve);
        return;
    }

    const previousSolve = state.solves[index];
    state.solves[index] = {
        ...previousSolve,
        timeMs: newSolve.timeMs,
        penalty: newSolve.penalty,
        phaseTimesMs: newSolve.phaseTimesMs,
        scramble: previousSolve.scramble,
        redoneAt: Date.now(),
        updatedAt: Date.now(),
        redoCount: (previousSolve.redoCount || 0) + 1,
    };
}

function deleteSolve(solveId) {
    const solve = state.solves.find((entry) => entry.id === solveId);
    if (solve) {
        solve.deletedAt = Date.now();
        solve.updatedAt = solve.deletedAt;
    }
    if (state.redoSolveId === solveId) {
        cancelRedo();
    }
    saveState({sync: true});
    render();
}

function clearActiveSession() {
    const deletedAt = Date.now();
    state.solves.forEach((solve) => {
        if (!solve.deletedAt && getSolveSessionId(solve) === state.activeSessionId) {
            solve.deletedAt = deletedAt;
            solve.updatedAt = deletedAt;
        }
    });
    state.lastDisplayMs = 0;
    cancelRedo();
    saveState({sync: true});
    render();
}

function updateSolvePenalty(solveId, penalty) {
    const normalizedPenalty = ["OK", "+2", "DNF", "POP"].includes(penalty) ? penalty : "OK";
    const solve = state.solves.find((entry) => entry.id === solveId && getSolveSessionId(entry) === state.activeSessionId);
    if (!solve) return;

    solve.penalty = normalizedPenalty;
    solve.updatedAt = Date.now();
    saveState({sync: true});
    render();
}

function scheduleSync() {
    if (!state.syncReady || !hasDirtySyncState() || isAccountSwitchPending()) return;
    window.clearTimeout(state.syncTimeout);
    state.syncTimeout = window.setTimeout(syncDirtyState, SYNC_DEBOUNCE_MS);
}

function hasDirtySyncState() {
    return state.syncRevision > state.syncedRevision;
}

function syncDirtyState() {
    if (!hasDirtySyncState()) return;
    return pushRemoteState();
}

async function pullRemoteState() {
    if (isAccountSwitchPending()) return;
    try {
        const remote = await window.CubingAssistantSync.downloadSnapshot();
        mergeRemoteState(remote);
        markSyncCompleted();
        saveState();
    } catch (error) {
        if (error.status === 401) return;
        // Local solve recording remains available while Drive is disconnected or offline.
    }
}

async function pushRemoteState() {
    if (!state.syncReady || !hasDirtySyncState() || state.syncInFlight || isAccountSwitchPending()) return;
    const uploadRevision = state.syncRevision;
    state.syncInFlight = true;
    try {
        const remote = await window.CubingAssistantSync.uploadSnapshot(createSyncSnapshot());
        mergeRemoteState(remote);
        markSyncCompleted();
        state.syncedRevision = Math.max(state.syncedRevision, uploadRevision);
        if (!hasDirtySyncState()) {
            localStorage.removeItem(SYNC_DIRTY_STORAGE_KEY);
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(createStoredState()));
    } catch (error) {
        if (error.status === 401) return;
        // The next local mutation or page load retries synchronization.
    } finally {
        state.syncInFlight = false;
        if (state.syncRevision > uploadRevision) scheduleSync();
    }
}

function flushSyncWithBeacon() {
    if (!state.syncReady || !hasDirtySyncState() || isAccountSwitchPending() || !navigator.sendBeacon) return;
    const payload = JSON.stringify(createSyncSnapshot());
    if (new Blob([payload]).size <= 1_250_000) {
        navigator.sendBeacon("/api/sync", payload);
    }
}

function markSyncCompleted() {
    localStorage.setItem(LAST_SYNC_STORAGE_KEY, String(Date.now()));
}

function isAccountSwitchPending() {
    return Boolean(localStorage.getItem(ACCOUNT_SWITCH_STORAGE_KEY));
}

function createSyncSnapshot() {
    return {
        schemaVersion: 2,
        updatedAt: Date.now(),
        sessions: state.sessions,
        sessionScrambleIndexes: state.sessionScrambleIndexes,
        solves: state.solves,
        statsConfig: state.statsConfig,
        theme: state.theme,
    };
}

function createStoredState() {
    return {
        activeEvent: state.activeEvent,
        playgroundEvent: state.playgroundEvent,
        activeSessionId: state.activeSessionId,
        sessions: state.sessions,
        sessionScrambleIndexes: state.sessionScrambleIndexes,
        solves: state.solves,
        lastDisplayMs: state.lastDisplayMs,
        scrambleFontSize: state.scrambleFontSize,
        statsConfig: state.statsConfig,
        inspectionEnabled: state.inspectionEnabled,
        drawingEnabled: state.drawingEnabled,
        timerUpdateMs: state.timerUpdateMs,
        theme: state.theme,
    };
}

function mergeRemoteState(remote) {
    const solves = new Map();
    [...state.solves, ...(Array.isArray(remote.solves) ? remote.solves : [])].forEach((solve) => {
        if (!solve.id) return;
        const current = solves.get(solve.id);
        if (!current || getSolveUpdatedAt(solve) >= getSolveUpdatedAt(current)) {
            solves.set(solve.id, solve);
        }
    });

    state.solves = [...solves.values()];
    state.sessions = mergeSessions(state.sessions, remote.sessions || []);
    state.sessionScrambleIndexes = {
        ...state.sessionScrambleIndexes, ...(remote.sessionScrambleIndexes || migrateRemoteScrambleIndexes(remote.scrambleIndexes)),
    };
    if (remote.theme && Number(remote.theme.updatedAt || 0) >= Number(state.theme.updatedAt || 0)) {
        state.theme = remote.theme;
        window.CubingAssistantTheme?.applyTheme(state.theme);
    }
    if (Array.isArray(remote.statsConfig)) {
        state.statsConfig = normalizeStatsConfig(remote.statsConfig);
    }
    renderSessionOptions();
}

function getSolveUpdatedAt(solve) {
    return Number(solve.updatedAt || solve.deletedAt || solve.redoneAt || solve.createdAt || 0);
}

function exportActiveSession() {
    const solves = getActiveSolves();
    const exportedAt = new Date().toISOString();
    const eventId = state.activeEvent;
    const session = getActiveSession();
    const payload = {
        exportedAt, session: {
            id: session.id,
            name: session.name,
            event: eventId,
            label: getEventLabel(eventId),
            solveCount: solves.length,
            scrambleIndex: getScrambleIndex(),
        }, solves: solves.map((solve) => ({
            ...solve,
            event: getSolveEvent(solve),
            penalty: getSolvePenalty(solve),
            createdAtIso: new Date(solve.createdAt).toISOString(),
            redoneAtIso: solve.redoneAt ? new Date(solve.redoneAt).toISOString() : null,
        })),
    };

    const filename = `cubing-assistant-${slugify(session.name)}-${formatExportTimestamp(exportedAt)}.json`;
    downloadJson(filename, payload);
}

function mergeSessions(left, right) {
    const sessions = new Map();
    [...left, ...right].forEach((session) => {
        if (!session.id || session.id === PLAYGROUND_SESSION_ID) return;
        const current = sessions.get(session.id);
        if (!current || Number(session.updatedAt || 0) >= Number(current.updatedAt || 0)) {
            sessions.set(session.id, session);
        }
    });
    return [createPlaygroundSession(), ...sessions.values()];
}

function migrateRemoteScrambleIndexes(indexes) {
    const migrated = {};
    Object.entries(indexes || {}).forEach(([event, index]) => {
        migrated[`${PLAYGROUND_SESSION_ID}:${event}`] = index;
    });
    return migrated;
}

function slugify(value) {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "session";
}

function downloadJson(filename, payload) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], {type: "application/json"});
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.style.display = "none";
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

function formatExportTimestamp(isoTimestamp) {
    return isoTimestamp.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function getRandomScrambleIndex() {
    if (state.scrambles.length < 2) return 0;

    const currentIndex = getScrambleIndex();
    let nextIndex = currentIndex;
    while (nextIndex === currentIndex) {
        nextIndex = Math.floor(Math.random() * state.scrambles.length);
    }
    return nextIndex;
}

function getScrambleLabel(total) {
    if (!total) return "0 / 0";
    if (state.redoSolveId) return "redo";
    return `${getScrambleIndex() + 1} / ${total}`;
}

function isInteractiveTarget(target) {
    return Boolean(target.closest("button, input, select, textarea, a, .resize-handle, .scramble-drawing-panel"));
}

function isTextEntryTarget(target) {
    return Boolean(target.closest("input, textarea, [contenteditable='true']"));
}

async function copyScrambleText(scramble) {
    const text = (scramble || "").trim();
    if (!text) return;

    try {
        await navigator.clipboard.writeText(text);
        statusEl.textContent = "Scramble copied";
    } catch {
        copyTextWithFallback(text);
        statusEl.textContent = "Scramble copied";
    }
}

function copyTextWithFallback(text) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";
    document.body.append(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
}

function onResizeStart(event) {
    const handle = event.currentTarget;
    const resizeTarget = handle.dataset.resize;
    const startX = event.clientX;
    const startY = event.clientY;
    const startScrambleHeight = getCssPixelValue("--scramble-height");
    const startTimesWidth = timesPanelEl.getBoundingClientRect().width;

    event.preventDefault();
    handle.classList.add("dragging");
    handle.setPointerCapture(event.pointerId);

    function onResizeMove(moveEvent) {
        if (resizeTarget === "scramble") {
            const minHeight = getCssPixelValue("--scramble-min-height") || 96;
            const maxHeight = Math.max(minHeight, window.innerHeight * 0.55);
            const nextHeight = clamp(startScrambleHeight + moveEvent.clientY - startY, minHeight, maxHeight);
            appEl.style.setProperty("--scramble-height", `${nextHeight}px`);
        }

        if (resizeTarget === "times") {
            const minWidth = getCssPixelValue("--times-min-width") || DEFAULT_TIMES_MIN_WIDTH_PX;
            const maxWidth = getAvailableTimesPanelWidth();
            const nextWidth = clamp(startTimesWidth - (moveEvent.clientX - startX), minWidth, maxWidth);
            appEl.style.setProperty("--times-width", `${nextWidth}px`);
        }
    }

    function onResizeEnd() {
        handle.classList.remove("dragging");
        saveLayout();
        handle.removeEventListener("pointermove", onResizeMove);
        handle.removeEventListener("pointerup", onResizeEnd);
        handle.removeEventListener("pointercancel", onResizeEnd);
    }

    handle.addEventListener("pointermove", onResizeMove);
    handle.addEventListener("pointerup", onResizeEnd);
    handle.addEventListener("pointercancel", onResizeEnd);
}

function onScrambleDrawingDragStart(event) {
    if (event.button !== 0) return;
    const panelRect = scrambleDrawingPanelEl.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const startLeft = panelRect.left;
    const startTop = panelRect.top;

    event.preventDefault();
    scrambleDrawingHeadingEl.setPointerCapture(event.pointerId);
    scrambleDrawingPanelEl.classList.add("dragging");

    function onDragMove(moveEvent) {
        setScrambleDrawingPosition(startLeft + moveEvent.clientX - startX, startTop + moveEvent.clientY - startY);
    }

    function onDragEnd() {
        scrambleDrawingPanelEl.classList.remove("dragging");
        saveLayout();
        scrambleDrawingHeadingEl.removeEventListener("pointermove", onDragMove);
        scrambleDrawingHeadingEl.removeEventListener("pointerup", onDragEnd);
        scrambleDrawingHeadingEl.removeEventListener("pointercancel", onDragEnd);
    }

    scrambleDrawingHeadingEl.addEventListener("pointermove", onDragMove);
    scrambleDrawingHeadingEl.addEventListener("pointerup", onDragEnd);
    scrambleDrawingHeadingEl.addEventListener("pointercancel", onDragEnd);
}

function onScrambleDrawingResizeStart(event) {
    if (event.button !== 0) return;
    const handle = event.currentTarget;
    const corner = handle.dataset.resizeCorner;
    const startX = event.clientX;
    const startY = event.clientY;
    const startLeft = scrambleDrawingPanelEl.offsetLeft;
    const startTop = scrambleDrawingPanelEl.offsetTop;
    const startWidth = scrambleDrawingPanelEl.offsetWidth;
    const startHeight = scrambleDrawingPanelEl.offsetHeight;
    const resizeFromLeft = corner.includes("w");
    const resizeFromTop = corner.includes("n");

    event.preventDefault();
    handle.setPointerCapture(event.pointerId);

    function onResizeMove(moveEvent) {
        const widthDelta = (moveEvent.clientX - startX) * (resizeFromLeft ? -1 : 1);
        const heightDelta = (moveEvent.clientY - startY) * (resizeFromTop ? -1 : 1) * 1.5;
        const dominantDelta = Math.abs(widthDelta) > Math.abs(heightDelta) ? widthDelta : heightDelta;
        const desiredWidth = Math.max(MIN_SCRAMBLE_DRAWING_WIDTH_PX, startWidth + dominantDelta);
        const maxWidth = getScrambleDrawingMaxWidthForCorner(startLeft, startTop, startWidth, startHeight, corner);
        const width = Math.min(desiredWidth, maxWidth);
        const height = getScrambleDrawingHeightForWidth(width);
        setScrambleDrawingSize(width);
        setScrambleDrawingPosition(resizeFromLeft ? startLeft + startWidth - width : startLeft, resizeFromTop ? startTop + startHeight - height : startTop,);
    }

    function onResizeEnd() {
        saveLayout();
        handle.removeEventListener("pointermove", onResizeMove);
        handle.removeEventListener("pointerup", onResizeEnd);
        handle.removeEventListener("pointercancel", onResizeEnd);
    }

    handle.addEventListener("pointermove", onResizeMove);
    handle.addEventListener("pointerup", onResizeEnd);
    handle.addEventListener("pointercancel", onResizeEnd);
}

function setScrambleDrawingPosition(left, top) {
    const minLeft = getCssPixelValue("--side-tabs-width") || 0;
    const maxLeft = Math.max(minLeft, window.innerWidth - scrambleDrawingPanelEl.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - scrambleDrawingPanelEl.offsetHeight);
    scrambleDrawingPanelEl.style.left = `${clamp(left, minLeft, maxLeft)}px`;
    scrambleDrawingPanelEl.style.top = `${clamp(top, 0, maxTop)}px`;
    scrambleDrawingPanelEl.style.bottom = "auto";
}

function constrainScrambleDrawing() {
    const currentWidth = scrambleDrawingPanelEl.offsetWidth || DEFAULT_SCRAMBLE_DRAWING_WIDTH_PX;
    if (currentWidth > getScrambleDrawingMaxWidth()) {
        setScrambleDrawingSize(Math.max(MIN_SCRAMBLE_DRAWING_WIDTH_PX, getScrambleDrawingMaxWidth()));
    }
    setScrambleDrawingPosition(scrambleDrawingPanelEl.offsetLeft, scrambleDrawingPanelEl.offsetTop);
}

function onWindowResize() {
    updateTimesPanelMinWidth(getActivePhaseCount());
    window.requestAnimationFrame(syncTimesPanelMinWidth);
    constrainScrambleDrawing();
}

function updateTimesPanelMinWidth(phaseCount) {
    const splitBaseWidth = getCssPixelValue("--split-panel-base-width");
    const splitPhaseWidth = getCssPixelValue("--split-panel-phase-width");
    const splitContentWidth = splitBaseWidth + phaseCount * splitPhaseWidth;
    const desiredWidth = phaseCount ? Math.max(DEFAULT_TIMES_MIN_WIDTH_PX, splitContentWidth) : DEFAULT_TIMES_MIN_WIDTH_PX;
    appEl.style.setProperty("--split-content-width", `${desiredWidth}px`);
    applyTimesPanelBounds(desiredWidth);
}

function syncTimesPanelMinWidth() {
    const timesHeader = timesPanelEl.querySelector(".times-header");
    const statsTable = timesPanelEl.querySelector(".stats-table");
    const requiredWidth = Math.ceil(Math.max(
        DEFAULT_TIMES_MIN_WIDTH_PX,
        timesHeader?.scrollWidth || 0,
        statsTable?.scrollWidth || 0,
        timesListEl.scrollWidth,
    ));
    applyTimesPanelBounds(requiredWidth);
}

function applyTimesPanelBounds(requiredWidth) {
    const maxWidth = getAvailableTimesPanelWidth();
    const minWidth = Math.min(requiredWidth, maxWidth);
    const currentWidth = getCssPixelValue("--times-width") || DEFAULT_TIMES_MIN_WIDTH_PX;
    appEl.style.setProperty("--times-min-width", `${minWidth}px`);
    appEl.style.setProperty("--times-max-width", `${maxWidth}px`);
    appEl.style.setProperty("--times-width", `${clamp(currentWidth, minWidth, maxWidth)}px`);
}

function getAvailableTimesPanelWidth() {
    const appStyle = getComputedStyle(appEl);
    const appLeftPadding = Number.parseFloat(appStyle.paddingLeft) || 0;
    const mainMinWidth = getCssPixelValue("--main-min-width") || 384;
    return Math.max(
        DEFAULT_TIMES_MIN_WIDTH_PX,
        appEl.clientWidth - appLeftPadding - mainMinWidth - RESIZE_HANDLE_WIDTH_PX,
    );
}

function setScrambleDrawingSize(width) {
    scrambleDrawingPanelEl.style.width = `${width}px`;
    scrambleDrawingPanelEl.style.height = `${getScrambleDrawingHeightForWidth(width)}px`;
}

function getScrambleDrawingHeightForWidth(width) {
    return width / 1.5 + scrambleDrawingHeadingEl.offsetHeight + 2;
}

function getScrambleDrawingMaxWidth() {
    const minLeft = getCssPixelValue("--side-tabs-width") || 0;
    const maxByHeight = Math.max(0, (window.innerHeight - scrambleDrawingHeadingEl.offsetHeight - 2) * 1.5);
    return Math.max(0, Math.min(window.innerWidth - minLeft, maxByHeight));
}

function getScrambleDrawingMaxWidthForCorner(left, top, width, height, corner) {
    const minLeft = getCssPixelValue("--side-tabs-width") || 0;
    const availableWidth = corner.includes("w") ? left + width - minLeft : window.innerWidth - left;
    const availableHeight = corner.includes("n") ? top + height : window.innerHeight - top;
    return Math.max(0, Math.min(availableWidth, (availableHeight - scrambleDrawingHeadingEl.offsetHeight - 2) * 1.5));
}

function getCssPixelValue(name) {
    const value = getComputedStyle(appEl).getPropertyValue(name);
    return Number.parseFloat(value) || 0;
}

function resetLayout() {
    appEl.style.removeProperty("--scramble-height");
    appEl.style.removeProperty("--times-width");
    scrambleDrawingPanelEl.style.removeProperty("left");
    scrambleDrawingPanelEl.style.removeProperty("top");
    scrambleDrawingPanelEl.style.removeProperty("bottom");
    scrambleDrawingPanelEl.style.removeProperty("width");
    scrambleDrawingPanelEl.style.removeProperty("height");
    updateTimesPanelMinWidth(getActivePhaseCount());
    window.requestAnimationFrame(() => {
        syncTimesPanelMinWidth();
        constrainScrambleDrawing();
        saveLayout();
    });
    statusEl.textContent = "Layout reset";
}

function saveLayout() {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({
        scrambleHeight: getCssPixelValue("--scramble-height"),
        timesWidth: getCssPixelValue("--times-width"),
        scrambleDrawing: {
            left: scrambleDrawingPanelEl.offsetLeft,
            top: scrambleDrawingPanelEl.offsetTop,
            width: scrambleDrawingPanelEl.offsetWidth,
            height: scrambleDrawingPanelEl.offsetHeight,
        },
    }),);
}

function loadLayout() {
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return;

    try {
        const saved = JSON.parse(raw);
        if (Number.isFinite(saved.scrambleHeight)) {
            appEl.style.setProperty("--scramble-height", `${saved.scrambleHeight}px`);
        }
        if (Number.isFinite(saved.timesWidth)) {
            const maxWidth = getAvailableTimesPanelWidth();
            appEl.style.setProperty("--times-width", `${clamp(saved.timesWidth, DEFAULT_TIMES_MIN_WIDTH_PX, maxWidth)}px`);
        }
        if (saved.scrambleDrawing) {
            const {left, top, width} = saved.scrambleDrawing;
            if (Number.isFinite(width)) setScrambleDrawingSize(width);
            if (Number.isFinite(left) && Number.isFinite(top)) setScrambleDrawingPosition(left, top);
        }
    } catch {
        localStorage.removeItem(LAYOUT_STORAGE_KEY);
    }
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function normalizeTimerUpdateMs(value) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return 10;
    return Math.round(clamp(numericValue, 0, 60_000));
}

function buildStats() {
    return [SINGLE_STAT_CONFIG, ...state.statsConfig].map(buildStatRow);
}

function buildStatRow(config) {
    const label = getStatLabel(config);
    const size = config.size;
    const calculator = config.type === "average"
        ? (solves) => calculateAverage(solves, config)
        : calculateMean;
    const windows = getStatWindows(size, calculator);
    const best = windows.reduce((bestWindow, window) => {
        if (!bestWindow || window.value < bestWindow.value) return window;
        return bestWindow;
    }, null);

    return {
        id: config.id,
        label,
        inspectable: config.size > 1,
        trimsExtremes: config.type === "average",
        trimCount: config.type === "average" ? getAverageTrimCount(config.size, config) : 0,
        current: windows.length ? windows[windows.length - 1] : null,
        best,
    };
}

function getStatLabel(config) {
    if (config.type === "mean" && config.size === 1) return "Single";
    return `${config.type === "average" ? "ao" : "mo"}${config.size}`;
}

function createDefaultStatsConfig() {
    return DEFAULT_STATS_CONFIG.map((config) => ({...config}));
}

function normalizeStatsConfig(configs) {
    if (!Array.isArray(configs)) return createDefaultStatsConfig();
    const normalized = configs.map(normalizeStatConfig).filter(Boolean);
    return normalized;
}

function normalizeStatConfig(config) {
    const type = config?.type === "average" ? "average" : "mean";
    const size = normalizeStatSize(config?.size, type);
    if (!size) return null;
    const normalized = {
        id: typeof config.id === "string" && config.id ? config.id : crypto.randomUUID(),
        type,
        size,
    };
    if (type === "average") {
        normalized.trimUnit = config.trimUnit === "percent" ? "percent" : "solves";
        normalized.trimValue = config.trimValue === undefined ? 1 : normalizeTrimValue(config.trimValue);
    }
    return normalized;
}

function normalizeStatSize(value, type) {
    const size = Math.round(Number(value));
    if (!Number.isFinite(size)) return 0;
    const min = type === "average" ? 3 : 2;
    return size >= min ? size : 0;
}

function normalizeTrimValue(value) {
    const trimValue = Math.round(Number(value));
    return Number.isFinite(trimValue) && trimValue > 0 ? trimValue : 0;
}

function getStatWindows(size, calculator) {
    const activeSolves = getChronologicalActiveSolves();
    if (activeSolves.length < size) return [];

    const windows = [];
    for (let index = 0; index <= activeSolves.length - size; index += 1) {
        const solves = activeSolves.slice(index, index + size);
        windows.push({
            startNumber: index + 1, endNumber: index + size, solves, value: calculator(solves),
        });
    }
    return windows;
}

function calculateMean(solves) {
    const times = solves.map(getAdjustedTime);
    const validTimes = times.filter(Number.isFinite);
    if (!validTimes.length) return Infinity;
    const validMean = validTimes.reduce((sum, time) => sum + time, 0) / validTimes.length;
    const total = times.reduce((sum, time) => sum + (Number.isFinite(time) ? time : validMean), 0);
    return total / times.length;
}

function calculateAverage(solves, config) {
    const times = solves.map(getAdjustedTime).sort((a, b) => a - b);
    const trimCount = getAverageTrimCount(solves.length, config);
    const trimmed = times.slice(trimCount, times.length - trimCount);
    if (!trimmed.length) return Infinity;
    const total = trimmed.reduce((sum, time) => sum + time, 0);
    return total / trimmed.length;
}

function getAverageTrimCount(size, config) {
    const rawTrim = config.trimUnit === "percent"
        ? Math.floor(size * normalizeTrimValue(config.trimValue) / 100)
        : normalizeTrimValue(config.trimValue);
    return clamp(rawTrim, 0, Math.floor((size - 1) / 2));
}

function getAdjustedTime(solve) {
    const penalty = getSolvePenalty(solve);
    if (penalty === "DNF") return Infinity;
    return solve.timeMs + (penalty === "+2" ? 2000 : 0);
}

function formatStatValue(value) {
    if (value === null || value === undefined || !Number.isFinite(value)) return "--";
    return formatTime(value);
}

function formatAverageValue(value) {
    if (value === null || value === undefined) return "--";
    if (!Number.isFinite(value)) return "DNF";
    return formatTime(value);
}

function normalizeScramble(scramble) {
    return scramble.trim().replace(/\s+/g, " ");
}

function formatSolveTime(solve) {
    return formatTime(solve.timeMs);
}

function getSolvePenalty(solve) {
    return solve.penalty || "OK";
}

function getPenaltyText(solve) {
    const penalty = getSolvePenalty(solve);
    return penalty === "OK" ? "" : penalty;
}

function createPenaltyBadge(solve) {
    const penalty = getSolvePenalty(solve);
    if (penalty === "OK") return null;

    const badge = document.createElement("span");
    badge.classList.add("penalty-badge");

    if (penalty === "+2") {
        badge.classList.add("penalty-plus");
        badge.textContent = "+";
        return badge;
    }

    if (penalty === "DNF") {
        badge.classList.add("penalty-dnf");
        badge.textContent = "x";
        return badge;
    }

    if (penalty === "POP") {
        badge.classList.add("penalty-pop");
        badge.textContent = "!";
        return badge;
    }

    return null;
}

function formatTime(ms) {
    const totalCentiseconds = Math.floor(ms / 10);
    const centiseconds = totalCentiseconds % 100;
    const totalSeconds = Math.floor(totalCentiseconds / 100);
    const seconds = totalSeconds % 60;
    const minutes = Math.floor(totalSeconds / 60);

    if (minutes > 0) {
        return `${minutes}:${String(seconds).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
    }

    return `${seconds}.${String(centiseconds).padStart(2, "0")}`;
}
