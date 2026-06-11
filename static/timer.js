const READY_DELAY_MS = 500;
const STORAGE_KEY = "cubingAssistant.timerState";
const LAYOUT_STORAGE_KEY = "cubingAssistant.layout";
const LAST_SYNC_STORAGE_KEY = "cubingAssistant.lastAutoSync";
const ACCOUNT_SWITCH_STORAGE_KEY = "cubingAssistant.pendingAccountSwitch";
const ACCOUNT_SWITCH_RESOLVED_STORAGE_KEY = "cubingAssistant.accountSwitchResolved";
const SYNC_DEBOUNCE_MS = 1500;
const PLAYGROUND_SESSION_ID = "playground";
const MOUSE_ONLY_NAVIGATION_SELECTOR = [
    "button",
    "select",
    "a",
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
const scrambleEl = document.querySelector("#scramble");
const scrambleDrawingEl = document.querySelector("#scrambleDrawing");
const scrambleDrawingPanelEl = document.querySelector(".scramble-drawing-panel");
const scrambleDrawingHeadingEl = document.querySelector(".scramble-drawing-heading");
const scrambleDrawingResizeEls = document.querySelectorAll(".scramble-drawing-resize");
const scrambleCountEl = document.querySelector("#scrambleCount");
const sessionSelectEl = document.querySelector("#sessionSelect");
const createSessionEl = document.querySelector("#createSession");
const eventSelectEl = document.querySelector("#eventSelect");
const fixedEventLabelEl = document.querySelector("#fixedEventLabel");
const randomScrambleEl = document.querySelector("#randomScramble");
const decreaseScrambleFontEl = document.querySelector("#decreaseScrambleFont");
const increaseScrambleFontEl = document.querySelector("#increaseScrambleFont");
const statsBodyEl = document.querySelector("#statsBody");
const timesListEl = document.querySelector("#timesList");
const exportTimesEl = document.querySelector("#exportTimes");
const clearTimesEl = document.querySelector("#clearTimes");
const clearConfirmDialogEl = document.querySelector("#clearConfirmDialog");
const confirmClearTimesEl = document.querySelector("#confirmClearTimes");
const createSessionDialogEl = document.querySelector("#createSessionDialog");
const newSessionNameEl = document.querySelector("#newSessionName");
const newSessionEventEl = document.querySelector("#newSessionEvent");
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
    touchIdentifier: null,
    redoSolveId: null,
    redoScramble: "",
    scrambleFontSize: 1.9,
    syncReady: false,
    syncTimeout: null,
    theme: {},
};

init();

async function init() {
    loadLayout();
    loadSavedState();
    renderEventOptions();
    renderSessionOptions();
    bindEvents();

    await pullRemoteState();
    state.syncReady = true;
    renderSessionOptions();
    await switchSession(state.activeSessionId);
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
    window.addEventListener("resize", constrainScrambleDrawing);

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
        if (state.timerState === "running") {
            sessionSelectEl.value = state.activeSessionId;
            return;
        }

        await switchSession(sessionSelectEl.value);
    });

    createSessionEl.addEventListener("click", () => {
        if (state.timerState === "running") return;
        newSessionNameEl.value = "";
        newSessionEventEl.value = state.activeEvent;
        createSessionDialogEl.showModal();
    });

    confirmCreateSessionEl.addEventListener("click", async (event) => {
        event.preventDefault();
        await createSession();
    });

    eventSelectEl.addEventListener("change", async () => {
        if (state.timerState === "running") {
            eventSelectEl.value = state.activeEvent;
            return;
        }

        await switchEvent(eventSelectEl.value);
    });

    randomScrambleEl.addEventListener("click", () => {
        if (state.timerState === "running" || state.scrambles.length === 0) return;
        cancelRedo();
        setScrambleIndex(getRandomScrambleIndex());
        state.lastDisplayMs = 0;
        saveState();
        render();
    });

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

    exportTimesEl.addEventListener("click", exportActiveSession);

    clearTimesEl.addEventListener("click", () => {
        if (state.timerState === "running") return;
        clearConfirmDialogEl.showModal();
    });

    confirmClearTimesEl.addEventListener("click", () => {
        clearActiveSession();
    });

    statsBodyEl.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-stat-average]");
        if (!button || state.timerState === "running") return;
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
        if (!button || state.timerState === "running") {
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

    if (event.target.closest(".times-list") && KEYBOARD_SCROLL_KEYS.has(event.code)) {
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
        stopTimer();
        return;
    }

    if (isInteractiveTarget(event.target)) return;

    if (event.key === "Enter" && (state.timerState === "holding" || state.timerState === "ready")) {
        event.preventDefault();
        cancelTimerReadying();
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
        stopTimer();
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
    if (state.timerState === "holding") {
        cancelTimerReadying();
        return;
    }

    if (state.timerState === "ready") {
        clearHoldTimeout();
        startTimer();
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
    state.timerState = "running";
    state.startTime = performance.now();
    state.elapsedMs = 0;
    state.lastDisplayMs = 0;
    renderTimerState();
    tick();
}

function stopTimer() {
    state.elapsedMs = performance.now() - state.startTime;
    state.lastDisplayMs = state.elapsedMs;
    state.timerState = "idle";
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
    };

    if (state.redoSolveId) {
        replaceRedoneSolve(solve);
        cancelRedo();
    } else {
        state.solves.unshift(solve);
        setScrambleIndex(clampScrambleIndex(getScrambleIndex() + 1));
    }

    saveState();
    render();
}

function tick() {
    if (state.timerState !== "running") return;

    state.elapsedMs = performance.now() - state.startTime;
    timerEl.textContent = formatTime(state.elapsedMs);
    state.animationFrame = requestAnimationFrame(tick);
}

function render() {
    renderScrambleFontSize();
    renderScramble();
    syncScrambleMinHeight();
    renderTimerState();
    renderStats();
    renderTimes();
    enforceMouseOnlyNavigation();
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
    const now = Date.now();
    const session = {
        id: crypto.randomUUID(), name, event, createdAt: now, updatedAt: now,
    };

    state.sessions.push(session);
    createSessionDialogEl.close();
    renderSessionOptions();
    await switchSession(session.id);
}

async function switchSession(sessionId) {
    const session = getVisibleSessions().find((entry) => entry.id === sessionId) || createPlaygroundSession();
    state.activeSessionId = session.id;
    sessionSelectEl.value = session.id;
    renderSessionEventControl();
    await switchEvent(session.event || state.playgroundEvent, {updatePlayground: false});
}

async function switchEvent(eventId, {updatePlayground = isPlaygroundSession()} = {}) {
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
    scrambleCountEl.textContent = "0 / 0";
    renderStats();
    renderTimes();

    try {
        state.scrambles = await loadScrambles(nextEvent);
        setScrambleIndex(clampScrambleIndex(getScrambleIndex()));
        saveState();
        render();
    } catch (error) {
        state.activeEvent = nextEvent;
        state.scrambles = [];
        saveState();
        render();
        scrambleEl.textContent = error.message;
        statusEl.textContent = previousEvent === nextEvent ? "Add the scramble file, then reload or choose this event again" : "Add the scramble file, then choose this event again";
    }
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
    scrambleCountEl.textContent = getScrambleLabel(total);
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
    timerEl.className = `timer ${state.timerState}`;

    if (state.timerState === "running") {
        statusEl.textContent = "Press any key or tap to stop";
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
    button.dataset.statAverage = stat.label;
    button.dataset.statColumn = column;
    button.textContent = text;
    makeMouseOnlyControl(button);
    cell.append(button);
}

function renderTimes() {
    timesListEl.replaceChildren();
    const activeSolves = getActiveSolves();
    const personalBestSolveIds = getRollingPersonalBestSolveIds(activeSolves);

    if (activeSolves.length === 0) {
        const empty = document.createElement("li");
        empty.className = "empty";
        empty.textContent = `No solves in ${getActiveSession().name} yet`;
        timesListEl.append(empty);
        return;
    }

    activeSolves.forEach((solve, index) => {
        const item = document.createElement("li");
        item.className = "time-entry";
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
        row.className = "time-row";

        const solveNumber = document.createElement("span");
        solveNumber.className = "time-index";
        solveNumber.textContent = String(activeSolves.length - index);

        const value = document.createElement("span");
        value.className = "time-value";
        value.textContent = formatSolveTime(solve);

        row.append(solveNumber, value);

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
}

function showAverageDialog(label, column) {
    const stat = buildStats().find((entry) => entry.label === label);
    const average = stat?.inspectable ? stat[column] : null;
    if (!average?.solves?.length) return;

    const {bestId, worstId} = getAverageExtremes(average.solves);
    const columnLabel = column === "best" ? "Best" : "Current";
    const averageText = formatAverageValue(average.value);
    averageDialogTitleEl.textContent = `${columnLabel} ${label} ${averageText}`;
    averageDialogTimesEl.replaceChildren();

    average.solves.forEach((solve) => {
        const item = document.createElement("li");
        item.classList.toggle("average-best", stat.trimsExtremes && solve.id === bestId);
        item.classList.toggle("average-worst", stat.trimsExtremes && solve.id === worstId);
        item.textContent = formatAverageSolveLine(solve, stat.trimsExtremes ? bestId : "", stat.trimsExtremes ? worstId : "");
        averageDialogTimesEl.append(item);
    });

    averageDialogLog = [`${columnLabel} ${label} of ${averageText} on ${getEventLabel(getActiveEvent())}:`, "", ...average.solves.map((solve) => formatAverageSolveLine(solve, stat.trimsExtremes ? bestId : "", stat.trimsExtremes ? worstId : "")),].join("\n");

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

function formatAverageSolveLine(solve, bestId, worstId) {
    const penalty = getPenaltyText(solve);
    const line = `${formatSolveTime(solve)}${penalty ? ` ${penalty}` : ""}`;
    return solve.id === bestId || solve.id === worstId ? `(${line})` : line;
}

function getAverageExtremes(solves) {
    let best = null;
    let worst = null;

    solves.forEach((solve) => {
        const value = getAdjustedTime(solve);
        if (!best || value < best.value) best = {id: solve.id, value};
        if (!worst || value > worst.value) worst = {id: solve.id, value};
    });

    return {bestId: best?.id || "", worstId: worst?.id || ""};
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

function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(createStoredState()),);
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
        state.theme = saved.theme || {};
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
    saveState();
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
    saveState();
    render();
}

function updateSolvePenalty(solveId, penalty) {
    const normalizedPenalty = ["OK", "+2", "DNF", "POP"].includes(penalty) ? penalty : "OK";
    const solve = state.solves.find((entry) => entry.id === solveId && getSolveSessionId(entry) === state.activeSessionId);
    if (!solve) return;

    solve.penalty = normalizedPenalty;
    solve.updatedAt = Date.now();
    saveState();
    render();
}

function scheduleSync() {
    if (!state.syncReady || isAccountSwitchPending()) return;
    window.clearTimeout(state.syncTimeout);
    state.syncTimeout = window.setTimeout(pushRemoteState, SYNC_DEBOUNCE_MS);
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
    if (isAccountSwitchPending()) return;
    try {
        const remote = await window.CubingAssistantSync.uploadSnapshot(createSyncSnapshot());
        mergeRemoteState(remote);
        markSyncCompleted();
        localStorage.setItem(STORAGE_KEY, JSON.stringify(createStoredState()));
    } catch (error) {
        if (error.status === 401) return;
        // The next local mutation or page load retries synchronization.
    }
}

function flushSyncWithBeacon() {
    if (!state.syncReady || isAccountSwitchPending() || !navigator.sendBeacon) return;
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
    const startTimesWidth = getCssPixelValue("--times-width");

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
            const minWidth = getCssPixelValue("--times-min-width") || 352;
            const mainMinWidth = getCssPixelValue("--main-min-width") || 384;
            const maxWidth = Math.max(minWidth, window.innerWidth - mainMinWidth - 56);
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
    const timerRect = timerPanelEl.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const startLeft = panelRect.left - timerRect.left;
    const startTop = panelRect.top - timerRect.top;

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
        const desiredWidth = Math.max(192, startWidth + dominantDelta);
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
    const maxLeft = Math.max(0, timerPanelEl.clientWidth - scrambleDrawingPanelEl.offsetWidth);
    const maxTop = Math.max(0, timerPanelEl.clientHeight - scrambleDrawingPanelEl.offsetHeight);
    scrambleDrawingPanelEl.style.left = `${clamp(left, 0, maxLeft)}px`;
    scrambleDrawingPanelEl.style.top = `${clamp(top, 0, maxTop)}px`;
    scrambleDrawingPanelEl.style.bottom = "auto";
}

function constrainScrambleDrawing() {
    setScrambleDrawingSize(Math.min(scrambleDrawingPanelEl.offsetWidth, getScrambleDrawingMaxWidth()));
    setScrambleDrawingPosition(scrambleDrawingPanelEl.offsetLeft, scrambleDrawingPanelEl.offsetTop);
}

function setScrambleDrawingSize(width) {
    scrambleDrawingPanelEl.style.width = `${width}px`;
    scrambleDrawingPanelEl.style.height = `${getScrambleDrawingHeightForWidth(width)}px`;
}

function getScrambleDrawingHeightForWidth(width) {
    return width / 1.5 + scrambleDrawingHeadingEl.offsetHeight + 2;
}

function getScrambleDrawingMaxWidth() {
    const maxByHeight = Math.max(0, (timerPanelEl.clientHeight - scrambleDrawingHeadingEl.offsetHeight - 2) * 1.5);
    return Math.max(0, Math.min(timerPanelEl.clientWidth, maxByHeight));
}

function getScrambleDrawingMaxWidthForCorner(left, top, width, height, corner) {
    const availableWidth = corner.includes("w") ? left + width : timerPanelEl.clientWidth - left;
    const availableHeight = corner.includes("n") ? top + height : timerPanelEl.clientHeight - top;
    return Math.max(0, Math.min(availableWidth, (availableHeight - scrambleDrawingHeadingEl.offsetHeight - 2) * 1.5));
}

function getCssPixelValue(name) {
    const value = getComputedStyle(appEl).getPropertyValue(name);
    return Number.parseFloat(value) || 0;
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
            appEl.style.setProperty("--times-width", `${saved.timesWidth}px`);
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

function buildStats() {
    return [buildStatRow("single", 1, calculateMean, false, false), buildStatRow("mo3", 3, calculateMean, true, false), buildStatRow("ao5", 5, calculateAverage, true, true), buildStatRow("ao12", 12, calculateAverage, true, true), buildStatRow("ao100", 100, calculateAverage, true, true),];
}

function buildStatRow(label, size, calculator, inspectable, trimsExtremes) {
    const windows = getStatWindows(size, calculator);
    const best = windows.reduce((bestWindow, window) => {
        if (!bestWindow || window.value < bestWindow.value) return window;
        return bestWindow;
    }, null);

    return {
        label, inspectable, trimsExtremes, current: windows.length ? windows[windows.length - 1] : null, best,
    };
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
    const total = solves.reduce((sum, solve) => sum + getAdjustedTime(solve), 0);
    return total / solves.length;
}

function calculateAverage(solves) {
    const times = solves.map(getAdjustedTime).sort((a, b) => a - b);
    const trimmed = times.slice(1, -1);
    const total = trimmed.reduce((sum, time) => sum + time, 0);
    return total / trimmed.length;
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
