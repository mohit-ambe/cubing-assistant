const STORAGE_KEY = "cubingAssistant.timerState";
const ACCOUNT_SWITCH_STORAGE_KEY = "cubingAssistant.pendingAccountSwitch";
const ACCOUNT_SWITCH_RESOLVED_STORAGE_KEY = "cubingAssistant.accountSwitchResolved";

const EVENTS = [["222", "2x2"], ["333", "3x3"], ["444", "4x4"], ["555", "5x5"], ["666", "6x6"], ["777", "7x7"], ["333oh", "3x3 OH"], ["333bf", "3x3 Blindfolded"], ["333fm", "3x3 Fewest Moves"], ["333mbf", "3x3 Multi-Blind"], ["clock", "Clock"], ["minx", "Megaminx"], ["pyram", "Pyraminx"], ["skewb", "Skewb"], ["sq1", "Square-1"],];

const eventFilterEl = document.querySelector("#eventFilter");
const rangeFilterEl = document.querySelector("#rangeFilter");
const rollingFilterEl = document.querySelector("#rollingFilter");
const summaryLineEl = document.querySelector("#summaryLine");
const statCardsEl = document.querySelector("#statCards");
const trendMetaEl = document.querySelector("#trendMeta");
const distributionMetaEl = document.querySelector("#distributionMeta");
const trendChartEl = document.querySelector("#trendChart");
const distributionChartEl = document.querySelector("#distributionChart");
const dailyChartEl = document.querySelector("#dailyChart");
const eventChartEl = document.querySelector("#eventChart");

const state = {
    solves: [],
};

window.addEventListener("storage", (event) => {
    if (event.key === ACCOUNT_SWITCH_RESOLVED_STORAGE_KEY) {
        window.location.reload();
    }
});

init();

async function init() {
    state.solves = loadSolves();
    renderEventOptions();
    bindEvents();
    render();
    await pullRemoteState();
}

function bindEvents() {
    [eventFilterEl, rangeFilterEl, rollingFilterEl].forEach((control) => {
        control.addEventListener("change", render);
    });
}

function loadSolves() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];

    try {
        const saved = JSON.parse(raw);
        if (!Array.isArray(saved.solves)) return [];
        return saved.solves
            .filter((solve) => !solve.deletedAt && Number.isFinite(Number(solve.timeMs)) && Number.isFinite(Number(solve.createdAt)))
            .map((solve) => ({
                ...solve,
                event: solve.event || "333",
                penalty: solve.penalty || "OK",
                timeMs: Number(solve.timeMs),
                createdAt: Number(solve.createdAt),
            }))
            .sort((a, b) => a.createdAt - b.createdAt);
    } catch {
        return [];
    }
}

function renderEventOptions() {
    const selectedEvent = eventFilterEl.value || "all";
    const seenEvents = new Set(state.solves.map((solve) => solve.event));
    const options = [["all", "All events"], ...EVENTS.filter(([eventId]) => seenEvents.has(eventId))];
    if (options.length === 1) {
        options.push(["333", "3x3"]);
    }

    eventFilterEl.replaceChildren();
    options.forEach(([eventId, label]) => {
        const option = document.createElement("option");
        option.value = eventId;
        option.textContent = label;
        eventFilterEl.append(option);
    });
    eventFilterEl.value = options.some(([eventId]) => eventId === selectedEvent) ? selectedEvent : "all";
}

async function pullRemoteState() {
    if (localStorage.getItem(ACCOUNT_SWITCH_STORAGE_KEY)) return;
    try {
        const remote = await window.CubingAssistantSync.downloadSnapshot();

        const raw = localStorage.getItem(STORAGE_KEY);
        const saved = raw ? JSON.parse(raw) : {};
        saved.solves = mergeSolves(saved.solves || [], remote.solves || []);
        saved.sessions = mergeSessions(saved.sessions || [], remote.sessions || []);
        if (remote.theme && Number(remote.theme.updatedAt || 0) >= Number(saved.theme?.updatedAt || 0)) {
            saved.theme = remote.theme;
            window.CubingAssistantTheme?.applyTheme(remote.theme);
        }
        saved.sessionScrambleIndexes = {
            ...(saved.sessionScrambleIndexes || {}), ...(remote.sessionScrambleIndexes || {}),
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));

        state.solves = loadSolves();
        renderEventOptions();
        render();
    } catch {
        // Analytics remains available with local data while offline or disconnected.
    }
}

function mergeSolves(left, right) {
    const solves = new Map();
    [...left, ...right].forEach((solve) => {
        if (!solve.id) return;
        const current = solves.get(solve.id);
        if (!current || solveUpdatedAt(solve) >= solveUpdatedAt(current)) {
            solves.set(solve.id, solve);
        }
    });
    return [...solves.values()];
}

function solveUpdatedAt(solve) {
    return Number(solve.updatedAt || solve.deletedAt || solve.redoneAt || solve.createdAt || 0);
}

function mergeSessions(left, right) {
    const sessions = new Map();
    [...left, ...right].forEach((session) => {
        if (!session.id) return;
        const current = sessions.get(session.id);
        if (!current || Number(session.updatedAt || 0) >= Number(current.updatedAt || 0)) {
            sessions.set(session.id, session);
        }
    });
    return [...sessions.values()];
}

function render() {
    const filteredSolves = getFilteredSolves();
    const allRangeSolves = getRangeFilteredSolves(state.solves);
    const rollingSize = Number(rollingFilterEl.value);

    renderSummary(filteredSolves);
    renderStatCards(filteredSolves);
    renderTrendChart(filteredSolves, rollingSize);
    renderDistributionChart(filteredSolves);
    renderDailyChart(filteredSolves);
    renderEventChart(allRangeSolves);
}

function getFilteredSolves() {
    const eventId = eventFilterEl.value;
    return getRangeFilteredSolves(state.solves).filter((solve) => eventId === "all" || solve.event === eventId);
}

function getRangeFilteredSolves(solves) {
    const range = rangeFilterEl.value;
    if (range === "all") return [...solves];

    const cutoff = Date.now() - Number(range) * 24 * 60 * 60 * 1000;
    return solves.filter((solve) => solve.createdAt >= cutoff);
}

function renderSummary(solves) {
    const eventLabel = eventFilterEl.value === "all" ? "all events" : getEventLabel(eventFilterEl.value);
    summaryLineEl.textContent = `${solves.length} solves shown for ${eventLabel}`;
}

function renderStatCards(solves) {
    const validTimes = solves.map(getAdjustedTime).filter(Number.isFinite);
    const bestAo5Day = bestAverageDay(solves, 5);
    const activeDayCount = groupByDay(solves).length;
    const bestSingle = bestSingleContext(solves);
    const rollingSize = Number(rollingFilterEl.value);
    const bestRolling = bestAverageContext(solves, rollingSize);
    const cards = [["Solves", String(solves.length), activeDayCount ? `${formatDecimal(solves.length / activeDayCount)} / day` : "-- / day"], ["Best Single", formatMaybeTime(Math.min(...validTimes)), bestSingle ? formatStatDate(bestSingle.timestamp) : "--"], ["Average", formatMaybeTime(calculateAverage(solves))], [`Best ao${rollingSize}`, formatMaybeTime(bestRolling?.value), bestRolling ? formatStatDate(bestRolling.timestamp) : "--"], ["Active days", String(activeDayCount), `${formatDuration(totalSolveTime(solves))}, ${formatDuration(totalSolveTime(solves) / activeDayCount)} / day`], ["Best day", bestAo5Day ? formatBestDayDate(bestAo5Day.timestamp) : "--", bestAo5Day ? `ao5 ${formatTime(bestAo5Day.value)}` : "ao5 --"],];

    statCardsEl.replaceChildren();
    cards.forEach(([label, value, detail]) => {
        const card = document.createElement("article");
        card.className = "stat-card";
        if (detail) card.classList.add("has-detail");
        card.innerHTML = `<div class="stat-label"></div><div class="stat-value"></div><div class="stat-detail"></div>`;
        card.querySelector(".stat-label").textContent = label;
        card.querySelector(".stat-value").textContent = value;
        card.querySelector(".stat-detail").textContent = detail || "";
        statCardsEl.append(card);
    });
}

function renderTrendChart(solves, rollingSize) {
    const validSolves = solves.filter((solve) => Number.isFinite(getAdjustedTime(solve)));
    const rolling = rollingSeries(solves, rollingSize);
    trendMetaEl.textContent = `raw solves and ao${rollingSize}`;

    if (validSolves.length === 0) {
        renderEmpty(trendChartEl, "No valid solves in this range");
        return;
    }

    const minX = Math.min(...validSolves.map((solve) => solve.createdAt));
    const maxX = Math.max(...validSolves.map((solve) => solve.createdAt));
    const yValues = [...validSolves.map(getAdjustedTime), ...rolling.map((point) => point.value)];
    const minY = Math.min(...yValues);
    const maxY = Math.max(...yValues);
    const chart = createSvgChart(minX, maxX, minY, maxY, {showTimeAxis: true});
    const tooltip = createTrendTooltip();
    const personalBestSolveIds = getRollingPersonalBestSolveIds(solves);

    validSolves.forEach((solve) => {
        const circle = svgEl("circle", {
            cx: chart.x(solve.createdAt),
            cy: chart.y(getAdjustedTime(solve)),
            r: 3.3,
            class: `point ${personalBestSolveIds.has(solve.id) ? "point-pb" : ""}`,
        });
        bindTrendTooltip(circle, solve, tooltip, trendChartEl);
        chart.svg.append(circle);
    });

    if (rolling.length > 0) {
        chart.svg.append(svgEl("path", {d: linePath(rolling, chart.x, chart.y), class: "series-line"}));
    }

    renderSvg(trendChartEl, chart.svg);
    trendChartEl.append(tooltip);
}

function renderDistributionChart(solves) {
    const times = solves.map(getAdjustedTime).filter(Number.isFinite);
    distributionMetaEl.textContent = `${times.length} valid solves`;

    if (times.length < 2) {
        renderEmpty(distributionChartEl, "Need at least two valid solves");
        return;
    }

    const minTime = Math.min(...times);
    const maxTime = Math.max(...times);
    if (minTime === maxTime) {
        renderEmpty(distributionChartEl, "All valid solves have the same time");
        return;
    }

    const binCount = clamp(Math.ceil(Math.sqrt(times.length) * 1.5), 8, 24);
    const binWidth = (maxTime - minTime) / binCount;
    const bins = Array.from({length: binCount}, (_, index) => ({
        x: minTime + binWidth * (index + 0.5), count: 0,
    }));

    times.forEach((time) => {
        const index = Math.min(binCount - 1, Math.floor((time - minTime) / binWidth));
        bins[index].count += 1;
    });

    const smoothed = bins.map((bin, index) => ({
        x: bin.x,
        count: ((bins[index - 2]?.count || 0) * 0.06 + (bins[index - 1]?.count || 0) * 0.24 + bin.count * 0.4 + (bins[index + 1]?.count || 0) * 0.24 + (bins[index + 2]?.count || 0) * 0.06),
    }));

    const width = 720;
    const height = 340;
    const margin = {top: 20, right: 24, bottom: 42, left: 46};
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;
    const maxCount = Math.max(...bins.map((bin) => bin.count), ...smoothed.map((bin) => bin.count));
    const xRange = maxTime - minTime;
    const yRange = maxCount || 1;
    const x = (value) => margin.left + ((value - minTime) / xRange) * innerWidth;
    const y = (value) => margin.top + ((yRange - value) / yRange) * innerHeight;
    const svg = svgEl("svg", {viewBox: `0 0 ${width} ${height}`, role: "img"});
    const tooltip = createDistributionTooltip();

    for (let index = 0; index <= 4; index += 1) {
        const tickValue = (yRange / 4) * index;
        const yPosition = y(tickValue);
        svg.append(svgEl("line", {
            x1: margin.left, x2: width - margin.right, y1: yPosition, y2: yPosition, class: "grid-line"
        }));
        svg.append(svgEl("text", {
            x: margin.left - 9, y: yPosition + 4, "text-anchor": "end", class: "chart-text"
        }, String(Math.round(tickValue))));
    }

    svg.append(svgEl("line", {
        x1: margin.left, x2: margin.left, y1: margin.top, y2: height - margin.bottom, class: "axis"
    }));
    svg.append(svgEl("line", {
        x1: margin.left, x2: width - margin.right, y1: height - margin.bottom, y2: height - margin.bottom, class: "axis"
    }));

    const areaPath = [`M ${x(smoothed[0].x)} ${height - margin.bottom}`, ...smoothed.map((point, index) => `${index === 0 ? "L" : "L"} ${x(point.x)} ${y(point.count)}`), `L ${x(smoothed[smoothed.length - 1].x)} ${height - margin.bottom}`, "Z",].join(" ");
    svg.append(svgEl("path", {d: areaPath, class: "distribution-area"}));
    svg.append(svgEl("path", {
        d: linePath(smoothed.map((point) => ({x: point.x, value: point.count})), x, y), class: "distribution-line"
    }));

    bins.forEach((bin) => {
        const barWidth = Math.max(4, (innerWidth / binCount) * 0.72);
        const rect = svgEl("rect", {
            x: x(bin.x) - barWidth / 2,
            y: y(bin.count),
            width: barWidth,
            height: height - margin.bottom - y(bin.count),
            fill: "var(--primary)",
            "fill-opacity": scaledBarOpacity(bin.count, yRange, 0.18, 0.62),
            class: "distribution-bar",
        });
        bindDistributionTooltip(rect, bin, binWidth, tooltip, distributionChartEl);
        svg.append(rect);
    });

    [minTime, (minTime + maxTime) / 2, maxTime].forEach((time, index) => {
        svg.append(svgEl("text", {
            x: x(time),
            y: height - 12,
            "text-anchor": index === 0 ? "start" : index === 2 ? "end" : "middle",
            class: "chart-text",
        }, formatTime(time)));
    });

    renderSvg(distributionChartEl, svg);
    distributionChartEl.append(tooltip);
}

function renderDailyChart(solves) {
    const days = groupByDay(solves).map((day) => {
        const validTimes = day.solves.map(getAdjustedTime).filter(Number.isFinite);
        return {
            ...day, average: mean(validTimes), count: day.solves.length,
        };
    });

    if (days.length === 0) {
        renderEmpty(dailyChartEl, "No solve count data in this range");
        return;
    }

    const minX = Math.min(...days.map((day) => day.timestamp));
    const maxX = Math.max(...days.map((day) => day.timestamp));
    const width = 960;
    const height = 340;
    const margin = {top: 18, right: 24, bottom: 36, left: 66};
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;
    const xRange = maxX === minX ? 1 : maxX - minX;
    const maxY = Math.max(...days.map((day) => day.count), 1);
    const yStep = getNiceCountStep(maxY / 4);
    const yMax = Math.ceil(maxY / yStep) * yStep;
    const yTickCount = Math.max(1, Math.round(yMax / yStep));
    const bottom = height - margin.bottom;
    const x = (value) => margin.left + ((value - minX) / xRange) * innerWidth;
    const y = (value) => margin.top + ((yMax - value) / yMax) * innerHeight;
    const svg = svgEl("svg", {viewBox: `0 0 ${width} ${height}`, role: "img"});
    const tooltip = createDailyTooltip();
    const barWidth = Math.max(4, Math.min(24, (innerWidth / Math.max(days.length, 1)) * 0.52));

    for (let index = 0; index <= yTickCount; index += 1) {
        const value = yMax - yStep * index;
        const yPosition = y(value);
        svg.append(svgEl("line", {
            x1: margin.left, x2: width - margin.right, y1: yPosition, y2: yPosition, class: "grid-line"
        }));
        svg.append(svgEl("text", {
            x: margin.left - 10, y: yPosition + 4, "text-anchor": "end", class: "chart-text"
        }, String(Math.round(value))));
    }

    svg.append(svgEl("line", {x1: margin.left, x2: margin.left, y1: margin.top, y2: bottom, class: "axis"}));
    svg.append(svgEl("line", {x1: margin.left, x2: width - margin.right, y1: bottom, y2: bottom, class: "axis"}));
    appendTimeAxis(svg, minX, maxX, margin, innerWidth, height);

    days.forEach((day) => {
        const barHeight = bottom - y(day.count);
        const rect = svgEl("rect", {
            x: x(day.timestamp) - barWidth / 2,
            y: y(day.count),
            width: barWidth,
            height: barHeight,
            class: "bar-secondary",
        });
        bindDailyTooltip(rect, day, tooltip, dailyChartEl);
        svg.append(rect);
    });
    renderSvg(dailyChartEl, svg);
    dailyChartEl.append(tooltip);
}

function renderEventChart(solves) {
    const grouped = groupByEvent(solves)
        .map((group) => ({
            ...group, median: median(group.solves.map(getAdjustedTime).filter(Number.isFinite)),
        }))
        .filter((group) => Number.isFinite(group.median))
        .sort((a, b) => a.median - b.median);

    if (grouped.length === 0) {
        renderEmpty(eventChartEl, "No event data in this range");
        return;
    }

    const width = 720;
    const height = 320;
    const margin = {top: 20, right: 22, bottom: 48, left: 66};
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;
    const maxValue = Math.max(...grouped.map((group) => group.median));
    const barWidth = innerWidth / grouped.length * 0.64;
    const svg = svgEl("svg", {viewBox: `0 0 ${width} ${height}`, role: "img"});

    grouped.forEach((group, index) => {
        const x = margin.left + (index + 0.18) * (innerWidth / grouped.length);
        const barHeight = (group.median / maxValue) * innerHeight;
        svg.append(svgEl("rect", {
            x,
            y: margin.top + innerHeight - barHeight,
            width: barWidth,
            height: barHeight,
            fill: "var(--primary)",
            "fill-opacity": scaledBarOpacity(group.median, maxValue, 0.28, 0.76),
            class: "bar",
        }));
        svg.append(svgEl("text", {
            x: x + barWidth / 2, y: height - 24, "text-anchor": "middle", class: "chart-text",
        }, getEventLabel(group.event)));
        svg.append(svgEl("text", {
            x: x + barWidth / 2,
            y: margin.top + innerHeight - barHeight - 6,
            "text-anchor": "middle",
            class: "chart-text",
        }, formatTime(group.median)));
    });

    renderSvg(eventChartEl, svg);
}

function createSvgChart(minX, maxX, minY, maxY, {showTimeAxis = false, yFormatter = formatTime} = {}) {
    const width = 960;
    const height = 340;
    const margin = {top: 18, right: 24, bottom: 36, left: 66};
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;
    const yPad = Math.max(1000, (maxY - minY) * 0.08);
    const xRange = maxX === minX ? 1 : maxX - minX;
    const yStep = getNiceTimeStep((maxY - minY + yPad * 2) / 4);
    const yMin = Math.max(0, Math.floor((minY - yPad) / yStep) * yStep);
    const yMax = Math.ceil((maxY + yPad) / yStep) * yStep;
    const yRange = yMax === yMin ? 1 : yMax - yMin;
    const yTickCount = Math.max(1, Math.round(yRange / yStep));
    const svg = svgEl("svg", {viewBox: `0 0 ${width} ${height}`, role: "img"});

    for (let index = 0; index <= yTickCount; index += 1) {
        const y = margin.top + (innerHeight / yTickCount) * index;
        const value = yMax - yStep * index;
        svg.append(svgEl("line", {x1: margin.left, x2: width - margin.right, y1: y, y2: y, class: "grid-line"}));
        svg.append(svgEl("text", {
            x: margin.left - 10, y: y + 4, "text-anchor": "end", class: "chart-text"
        }, yFormatter(value)));
    }

    svg.append(svgEl("line", {
        x1: margin.left, x2: margin.left, y1: margin.top, y2: height - margin.bottom, class: "axis"
    }));
    svg.append(svgEl("line", {
        x1: margin.left, x2: width - margin.right, y1: height - margin.bottom, y2: height - margin.bottom, class: "axis"
    }));
    if (showTimeAxis) {
        appendTimeAxis(svg, minX, maxX, margin, innerWidth, height);
    }

    return {
        svg,
        innerHeight,
        bottom: height - margin.bottom,
        x: (value) => margin.left + ((value - minX) / xRange) * innerWidth,
        y: (value) => margin.top + ((yMax - value) / yRange) * innerHeight,
    };
}

function getNiceTimeStep(rawStep) {
    const steps = [100, 200, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 900000, 1800000, 3600000,];
    return steps.find((step) => step >= rawStep) || Math.ceil(rawStep / 3600000) * 3600000;
}

function getNiceCountStep(rawStep) {
    const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
    return steps.find((step) => step >= rawStep) || Math.ceil(rawStep / 1000) * 1000;
}

function appendTimeAxis(svg, minX, maxX, margin, innerWidth, height) {
    const tickCount = 5;
    const span = Math.max(0, maxX - minX);

    for (let index = 0; index < tickCount; index += 1) {
        const ratio = tickCount === 1 ? 0 : index / (tickCount - 1);
        const timestamp = minX + span * ratio;
        const x = margin.left + innerWidth * ratio;

        svg.append(svgEl("line", {
            x1: x, x2: x, y1: height - margin.bottom, y2: height - margin.bottom + 5, class: "axis",
        }));
        svg.append(svgEl("text", {
            x,
            y: height - 12,
            "text-anchor": index === 0 ? "start" : index === tickCount - 1 ? "end" : "middle",
            class: "chart-text",
        }, formatTimeAxisLabel(timestamp, span)));
    }
}

function formatTimeAxisLabel(timestamp, span) {
    const date = new Date(timestamp);
    const hour = 60 * 60 * 1000;
    const day = 24 * hour;

    if (span <= 2 * day) {
        return new Intl.DateTimeFormat(undefined, {
            hour: "numeric", minute: "2-digit",
        }).format(date);
    }

    if (span <= 120 * day) {
        return new Intl.DateTimeFormat(undefined, {
            month: "short", day: "numeric",
        }).format(date);
    }

    return new Intl.DateTimeFormat(undefined, {
        month: "short", year: "2-digit",
    }).format(date);
}

function rollingSeries(solves, size) {
    if (solves.length < size) return [];

    const points = [];
    for (let index = 0; index <= solves.length - size; index += 1) {
        const window = solves.slice(index, index + size);
        const value = calculateAverage(window);
        if (Number.isFinite(value)) {
            points.push({x: window[window.length - 1].createdAt, value});
        }
    }
    return points;
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

function calculateAverage(solves) {
    const times = solves.map(getAdjustedTime).sort((a, b) => a - b);
    if (times.length < 3) return mean(times);
    const trimmed = times.slice(1, -1);
    if (trimmed.some((time) => !Number.isFinite(time))) return Infinity;
    return mean(trimmed);
}

function currentAverage(solves, size) {
    if (solves.length < size) return Infinity;
    return calculateAverage(solves.slice(-size));
}

function bestAverage(solves, size) {
    if (solves.length < size) return Infinity;

    let best = Infinity;
    for (let index = 0; index <= solves.length - size; index += 1) {
        best = Math.min(best, calculateAverage(solves.slice(index, index + size)));
    }
    return best;
}

function bestSingleContext(solves) {
    let best = null;
    solves.forEach((solve) => {
        const value = getAdjustedTime(solve);
        if (!Number.isFinite(value)) return;
        if (!best || value < best.value) {
            best = {value, timestamp: solve.createdAt};
        }
    });
    return best;
}

function bestAverageContext(solves, size) {
    if (solves.length < size) return null;

    let best = null;
    for (let index = 0; index <= solves.length - size; index += 1) {
        const window = solves.slice(index, index + size);
        const value = calculateAverage(window);
        if (!Number.isFinite(value)) continue;
        if (!best || value < best.value) {
            best = {
                value, timestamp: window[window.length - 1].createdAt,
            };
        }
    }
    return best;
}

function bestAverageDay(solves, size) {
    const orderedSolves = [...solves].sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
    if (orderedSolves.length < size) return null;

    let best = null;
    for (let index = 0; index <= orderedSolves.length - size; index += 1) {
        const window = orderedSolves.slice(index, index + size);
        const value = calculateAverage(window);
        if (!Number.isFinite(value)) continue;

        if (!best || value < best.value) {
            best = {
                value, timestamp: window[window.length - 1].createdAt,
            };
        }
    }
    return best;
}

function totalSolveTime(solves) {
    return solves
        .map(getAdjustedTime)
        .filter(Number.isFinite)
        .reduce((sum, time) => sum + time, 0);
}

function getAdjustedTime(solve) {
    if (solve.penalty === "DNF") return Infinity;
    return solve.timeMs + (solve.penalty === "+2" ? 2000 : 0);
}

function groupByDay(solves) {
    const groups = new Map();
    solves.forEach((solve) => {
        const key = dateKey(solve.createdAt);
        if (!groups.has(key)) {
            groups.set(key, {key, timestamp: startOfDay(solve.createdAt), solves: []});
        }
        groups.get(key).solves.push(solve);
    });
    return [...groups.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function groupByEvent(solves) {
    const groups = new Map();
    solves.forEach((solve) => {
        if (!groups.has(solve.event)) {
            groups.set(solve.event, {event: solve.event, solves: []});
        }
        groups.get(solve.event).solves.push(solve);
    });
    return [...groups.values()];
}

function mean(values) {
    const finite = values.filter(Number.isFinite);
    if (finite.length === 0) return Infinity;
    return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function median(values) {
    const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (finite.length === 0) return Infinity;
    const middle = Math.floor(finite.length / 2);
    return finite.length % 2 ? finite[middle] : (finite[middle - 1] + finite[middle]) / 2;
}

function stddev(values) {
    const finite = values.filter(Number.isFinite);
    if (finite.length < 2) return Infinity;
    const avg = mean(finite);
    const variance = mean(finite.map((value) => (value - avg) ** 2));
    return Math.sqrt(variance);
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function linePath(points, xScale, yScale) {
    return points.map((point, index) => `${index === 0 ? "M" : "L"} ${xScale(point.x)} ${yScale(point.value)}`).join(" ");
}

function renderSvg(container, svg) {
    container.replaceChildren(svg);
}

function renderEmpty(container, message) {
    const empty = document.createElement("div");
    empty.className = "empty-chart";
    empty.textContent = message;
    container.replaceChildren(empty);
}

function tableCell(text, className = "") {
    const cell = document.createElement("td");
    cell.textContent = text;
    if (className) cell.className = className;
    return cell;
}

function svgEl(tag, attrs = {}, text = "") {
    const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.entries(attrs).forEach(([key, value]) => element.setAttribute(key, value));
    if (text) element.textContent = text;
    return element;
}

function scaledBarOpacity(value, maxValue, minOpacity, maxOpacity) {
    if (!Number.isFinite(value) || !Number.isFinite(maxValue) || maxValue <= 0) return minOpacity;
    const ratio = clamp(value / maxValue, 0, 1);
    return (minOpacity + (maxOpacity - minOpacity) * ratio).toFixed(3);
}

function dateKey(timestamp) {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function startOfDay(timestamp) {
    const date = new Date(timestamp);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
}

function formatDateTime(timestamp) {
    return new Intl.DateTimeFormat(undefined, {
        month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    }).format(new Date(timestamp));
}

function formatBestDayDate(timestamp) {
    return formatStatDate(timestamp);
}

function formatStatDate(timestamp) {
    return new Intl.DateTimeFormat(undefined, {
        month: "short", day: "numeric",
    }).format(new Date(timestamp));
}

function createTrendTooltip() {
    const tooltip = document.createElement("div");
    tooltip.className = "trend-tooltip";
    tooltip.hidden = true;
    tooltip.innerHTML = '<strong></strong><span></span>';
    return tooltip;
}

function bindTrendTooltip(point, solve, tooltip, container) {
    point.addEventListener("mouseenter", (event) => {
        const penalty = solve.penalty && solve.penalty !== "OK" ? ` ${solve.penalty}` : "";
        tooltip.querySelector("strong").textContent = `${formatTime(solve.timeMs)}${penalty}`;
        tooltip.querySelector("span").textContent = `${formatDateTime(solve.createdAt)}`;
        tooltip.hidden = false;
        positionTrendTooltip(event, tooltip, container);
    });
    point.addEventListener("mousemove", (event) => positionTrendTooltip(event, tooltip, container));
    point.addEventListener("mouseleave", () => {
        tooltip.hidden = true;
    });
}

function positionTrendTooltip(event, tooltip, container) {
    const containerRect = container.getBoundingClientRect();
    const left = event.clientX - containerRect.left + 12;
    const top = event.clientY - containerRect.top - tooltip.offsetHeight - 12;
    tooltip.style.left = `${Math.max(8, Math.min(left, container.clientWidth - tooltip.offsetWidth - 8))}px`;
    tooltip.style.top = `${Math.max(8, top)}px`;
}

function createDistributionTooltip() {
    const tooltip = document.createElement("div");
    tooltip.className = "trend-tooltip distribution-tooltip";
    tooltip.hidden = true;
    tooltip.innerHTML = '<strong></strong><span></span>';
    return tooltip;
}

function createDailyTooltip() {
    const tooltip = document.createElement("div");
    tooltip.className = "trend-tooltip daily-tooltip";
    tooltip.hidden = true;
    tooltip.innerHTML = '<strong></strong><span></span>';
    return tooltip;
}

function bindDailyTooltip(bar, day, tooltip, container) {
    bar.addEventListener("mouseenter", (event) => {
        tooltip.querySelector("strong").textContent = `${day.count} ${day.count === 1 ? "solve" : "solves"}`;
        tooltip.querySelector("span").textContent = `${formatStatDate(day.timestamp)} · avg ${formatMaybeTime(day.average)}`;
        tooltip.querySelector("strong").textContent = `${day.count} ${day.count === 1 ? "solve" : "solves"} (${formatMaybeTime(day.average)} avg)`;
        tooltip.querySelector("span").textContent = formatStatDate(day.timestamp);
        tooltip.hidden = false;
        positionTrendTooltip(event, tooltip, container);
    });
    bar.addEventListener("mousemove", (event) => positionTrendTooltip(event, tooltip, container));
    bar.addEventListener("mouseleave", () => {
        tooltip.hidden = true;
    });
}

function bindDistributionTooltip(bar, bin, binWidth, tooltip, container) {
    bar.addEventListener("mouseenter", (event) => {
        tooltip.querySelector("strong").textContent = `${bin.count} ${bin.count === 1 ? "solve" : "solves"}`;
        tooltip.querySelector("span").textContent = `Bin ${formatTime(bin.x - binWidth / 2)} - ${formatTime(bin.x + binWidth / 2)}`;
        tooltip.hidden = false;
        positionTrendTooltip(event, tooltip, container);
    });
    bar.addEventListener("mousemove", (event) => positionTrendTooltip(event, tooltip, container));
    bar.addEventListener("mouseleave", () => {
        tooltip.hidden = true;
    });
}

function formatMaybeTime(value) {
    return Number.isFinite(value) ? formatTime(value) : "--";
}

function formatDecimal(value) {
    return Number.isFinite(value) ? value.toFixed(1) : "--";
}

function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return "0m";
    const roundedMinutes = Math.round(ms / 60000);
    if (ms < 3600000) return `${roundedMinutes}m`;
    const roundedHours = Math.round(ms / 3600000);
    return `~${roundedHours}h (${roundedMinutes}m)`;
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

function formatWholeSecondTime(ms) {
    if (!Number.isFinite(ms)) return "--";
    const totalSeconds = Math.round(ms / 1000);
    const seconds = totalSeconds % 60;
    const minutes = Math.floor(totalSeconds / 60);

    if (minutes > 0) {
        return `${minutes}:${String(seconds).padStart(2, "0")}`;
    }

    return String(seconds);
}

function getEventLabel(eventId) {
    return EVENTS.find(([id]) => id === eventId)?.[1] || eventId;
}
