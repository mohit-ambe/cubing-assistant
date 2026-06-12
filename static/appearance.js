const STORAGE_KEY = "cubingAssistant.timerState";
const ACCOUNT_SWITCH_RESOLVED_STORAGE_KEY = "cubingAssistant.accountSwitchResolved";
const MODE_STORAGE_KEY = "cubingAssistant.appearanceMode";
const STITCH_DEFAULT_THEME = {
    "--bg": "#121314",
    "--surface-lowest": "#0d0e0f",
    "--surface-low": "#1b1c1d",
    "--surface": "#1f2021",
    "--surface-high": "#292a2b",
    "--surface-highest": "#343536",
    "--text": "#e3e2e3",
    "--muted": "#c3c6d5",
    "--outline": "#434653",
    "--primary": "#5781ff",
    "--primary-container": "#3366cc",
    "--danger": "#ff6352",
    "--ready": "#56d77d",
    "--hold": "#d9b34f",
    "--lavender": "#c7a7ff",
};
const DEFAULT_THEME = STITCH_DEFAULT_THEME;

window.addEventListener("storage", (event) => {
    if (event.key === ACCOUNT_SWITCH_RESOLVED_STORAGE_KEY) {
        window.location.reload();
    }
});
const THEME_FIELDS = [["--text", "Font"], ["--bg", "Background"], ["--surface-low", "Board"], ["--surface-high", "Button"], ["--primary", "Accent"], ["--muted", "Subtext"], ["--surface", "Subtext background"], ["--ready", "PBs"], ["--outline", "Borders"], ["--danger", "Danger"],];
const THEME_PRESETS = [["Default", {
    dark: STITCH_DEFAULT_THEME, light: {
        "--bg": "#f7f8fb",
        "--surface-lowest": "#ffffff",
        "--surface-low": "#f0f2f7",
        "--surface": "#e6e9f1",
        "--surface-high": "#dce1eb",
        "--surface-highest": "#cfd6e4",
        "--text": "#17191f",
        "--muted": "#566075",
        "--outline": "#b9c1d0",
        "--primary": STITCH_DEFAULT_THEME["--primary"],
        "--primary-container": STITCH_DEFAULT_THEME["--primary-container"],
        "--danger": STITCH_DEFAULT_THEME["--danger"],
        "--ready": STITCH_DEFAULT_THEME["--ready"],
        "--hold": STITCH_DEFAULT_THEME["--hold"],
        "--lavender": STITCH_DEFAULT_THEME["--lavender"],
    },
}], ["Monochrome", {
    dark: {
        "--bg": "#101010",
        "--surface-lowest": "#090909",
        "--surface-low": "#181818",
        "--surface": "#202020",
        "--surface-high": "#2b2b2b",
        "--surface-highest": "#383838",
        "--text": "#f0f0f0",
        "--muted": "#b8b8b8",
        "--outline": "#484848",
        "--primary": "#f0f0f0",
        "--primary-container": "#5a5a5a",
        "--danger": "#ff8a65",
        "--ready": "#8be9fd",
        "--hold": "#cfcfcf",
        "--lavender": "#d8d8d8",
    }, light: {
        "--bg": "#f6f6f6",
        "--surface-lowest": "#ffffff",
        "--surface-low": "#eeeeee",
        "--surface": "#e2e2e2",
        "--surface-high": "#d7d7d7",
        "--surface-highest": "#c8c8c8",
        "--text": "#161616",
        "--muted": "#5f5f5f",
        "--outline": "#bcbcbc",
        "--primary": "#151515",
        "--primary-container": "#555555",
        "--danger": "#a34219",
        "--ready": "#0b6f85",
        "--hold": "#777777",
        "--lavender": "#6b6b6b",
    },
}], ["Pinks", {
    dark: {
        "--bg": "#171015",
        "--surface-lowest": "#100a0e",
        "--surface-low": "#251821",
        "--surface": "#30202b",
        "--surface-high": "#3e2a37",
        "--surface-highest": "#503648",
        "--text": "#ffeaf5",
        "--muted": "#e6b9cf",
        "--outline": "#76556a",
        "--primary": "#ff70b8",
        "--primary-container": "#bd2f7b",
        "--danger": "#ff8a3d",
        "--ready": "#78f0c1",
        "--hold": "#ffd166",
        "--lavender": "#d9b3ff",
    }, light: {
        "--bg": "#fff7fb",
        "--surface-lowest": "#ffffff",
        "--surface-low": "#f8e8f2",
        "--surface": "#efd8e7",
        "--surface-high": "#e8c6dc",
        "--surface-highest": "#dcb0ce",
        "--text": "#24131f",
        "--muted": "#775168",
        "--outline": "#c997b6",
        "--primary": "#c82d83",
        "--primary-container": "#f6b7d8",
        "--danger": "#9f4b00",
        "--ready": "#007a60",
        "--hold": "#906300",
        "--lavender": "#7b56c5",
    },
}], ["Blues", {
    dark: {
        "--bg": "#0d121c",
        "--surface-lowest": "#080c13",
        "--surface-low": "#172033",
        "--surface": "#1e2a42",
        "--surface-high": "#293956",
        "--surface-highest": "#35486c",
        "--text": "#e9f1ff",
        "--muted": "#abc2e8",
        "--outline": "#4f6389",
        "--primary": "#64a8ff",
        "--primary-container": "#2369c8",
        "--danger": "#ff9a5f",
        "--ready": "#7cf0c4",
        "--hold": "#f7c95c",
        "--lavender": "#bba7ff",
    }, light: {
        "--bg": "#f7fbff",
        "--surface-lowest": "#ffffff",
        "--surface-low": "#e8f1fb",
        "--surface": "#d7e6f6",
        "--surface-high": "#c6d9ef",
        "--surface-highest": "#acc8e6",
        "--text": "#101923",
        "--muted": "#526b86",
        "--outline": "#91abc8",
        "--primary": "#246fd6",
        "--primary-container": "#bad6ff",
        "--danger": "#a64f00",
        "--ready": "#08775d",
        "--hold": "#806a00",
        "--lavender": "#6752bd",
    },
}], ["Sunset", {
    dark: {
        "--bg": "#17110f",
        "--surface-lowest": "#0f0a08",
        "--surface-low": "#261a16",
        "--surface": "#33231d",
        "--surface-high": "#452e25",
        "--surface-highest": "#5a3b2e",
        "--text": "#fff0e7",
        "--muted": "#e2b7a2",
        "--outline": "#7a584a",
        "--primary": "#ff9b54",
        "--primary-container": "#c2571e",
        "--danger": "#ff5d83",
        "--ready": "#8ee36f",
        "--hold": "#ffbf69",
        "--lavender": "#ffb3c6",
    }, light: {
        "--bg": "#fff8f2",
        "--surface-lowest": "#ffffff",
        "--surface-low": "#f5e5d9",
        "--surface": "#ecd5c5",
        "--surface-high": "#e4c4af",
        "--surface-highest": "#d7ad91",
        "--text": "#24160f",
        "--muted": "#765846",
        "--outline": "#bd9277",
        "--primary": "#c95f1e",
        "--primary-container": "#ffd2ad",
        "--danger": "#a91d58",
        "--ready": "#237a31",
        "--hold": "#946300",
        "--lavender": "#8b56aa",
    },
}], ["Forest", {
    dark: {
        "--bg": "#0e1511",
        "--surface-lowest": "#08100b",
        "--surface-low": "#17251c",
        "--surface": "#203127",
        "--surface-high": "#2a3f32",
        "--surface-highest": "#365341",
        "--text": "#e8f5ec",
        "--muted": "#a9c7b2",
        "--outline": "#4f725c",
        "--primary": "#74d99f",
        "--primary-container": "#2f8a58",
        "--danger": "#ff7d50",
        "--ready": "#b8f28b",
        "--hold": "#d8c45f",
        "--lavender": "#b8afea",
    }, light: {
        "--bg": "#f3fbf5",
        "--surface-lowest": "#ffffff",
        "--surface-low": "#e1f0e5",
        "--surface": "#d0e5d7",
        "--surface-high": "#bfd9c8",
        "--surface-highest": "#a9c9b4",
        "--text": "#102016",
        "--muted": "#506c59",
        "--outline": "#86aa93",
        "--primary": "#21834f",
        "--primary-container": "#b8e6ca",
        "--danger": "#a33d13",
        "--ready": "#475f00",
        "--hold": "#8c7000",
        "--lavender": "#6557a5",
    },
}],];

const controlsEl = document.querySelector("#themeControls");
const presetsEl = document.querySelector("#themePresets");
const modeToggleEl = document.querySelector("#themeModeToggle");
const statusEl = document.querySelector("#themeStatus");
const fileEl = document.querySelector("#cstimerThemeFile");
const lineEl = document.querySelector("#cstimerColorLine");
const messageEl = document.querySelector("#importMessage");
const applyLineEl = document.querySelector("#applyColorLine");

let theme = loadTheme();
let appearanceMode = loadAppearanceMode();

init();

function init() {
    applyTheme(theme);
    modeToggleEl.checked = appearanceMode === "light";
    renderPresets();
    renderControls();
    fileEl.addEventListener("change", importCstimerFile);
    applyLineEl.addEventListener("click", importColorLine);
    modeToggleEl.addEventListener("change", () => {
        appearanceMode = modeToggleEl.checked ? "light" : "dark";
        localStorage.setItem(MODE_STORAGE_KEY, appearanceMode);
        renderPresets();
        setMessage(`${appearanceMode === "light" ? "Light" : "Dark"} mode selected.`);
    });
}

function renderPresets() {
    presetsEl.replaceChildren();
    THEME_PRESETS.forEach(([label, preset]) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "preset-button";
        const previewTheme = normalizeTheme(preset[appearanceMode]);
        button.innerHTML = "<span class=\"preset-label\"></span><span class=\"preset-swatches\" aria-hidden=\"true\"></span>";
        button.querySelector(".preset-label").textContent = label;
        const swatches = button.querySelector(".preset-swatches");
        ["--bg", "--surface", "--primary", "--ready", "--danger"].forEach((name) => {
            const swatch = document.createElement("span");
            swatch.className = "preset-swatch";
            swatch.style.background = previewTheme[name];
            swatches.append(swatch);
        });
        button.addEventListener("click", () => setTheme(preset[appearanceMode]));
        presetsEl.append(button);
    });
}

function renderControls() {
    controlsEl.replaceChildren();
    THEME_FIELDS.forEach(([name, label]) => {
        const field = document.createElement("label");
        field.className = "theme-field";
        field.innerHTML = "<span></span><input type=\"color\">";
        field.querySelector("span").textContent = label;
        const input = field.querySelector("input");
        input.value = theme[name] || DEFAULT_THEME[name];
        input.addEventListener("input", () => {
            theme = normalizeTheme({...theme, [name]: input.value, updatedAt: Date.now()});
            applyTheme(theme);
            saveTheme();
            setMessage("Theme updated.");
        });
        controlsEl.append(field);
    });
}

async function importCstimerFile() {
    const file = fileEl.files[0];
    if (!file) return;
    try {
        const data = JSON.parse(await file.text());
        const imported = extractCstimerTheme(data);
        if (!imported) throw new Error("No csTimer color data found.");
        setTheme(imported, "csTimer file colors imported.");
    } catch (error) {
        setMessage(`Could not import file: ${error.message}`, true);
    } finally {
        fileEl.value = "";
    }
}

function importColorLine() {
    try {
        const imported = themeFromCstimerColorLine(lineEl.value);
        setTheme(imported, "csTimer color line imported.");
    } catch (error) {
        setMessage(error.message, true);
    }
}

function setTheme(nextTheme) {
    theme = normalizeTheme({...nextTheme, updatedAt: Date.now()});
    applyTheme(theme);
    saveTheme();
    renderControls();
}

function loadTheme() {
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
        return normalizeTheme(saved.theme);
    } catch {
        return normalizeTheme({});
    }
}

function loadAppearanceMode() {
    return localStorage.getItem(MODE_STORAGE_KEY) === "light" ? "light" : "dark";
}

function saveTheme() {
    const raw = localStorage.getItem(STORAGE_KEY);
    let saved = {};
    try {
        saved = raw ? JSON.parse(raw) : {};
    } catch {
        saved = {};
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify({...saved, theme}));
}

function applyTheme(nextTheme) {
    window.CubingAssistantTheme?.applyTheme(nextTheme);
    statusEl.textContent = "Saved locally";
}

function extractCstimerTheme(data) {
    const properties = data?.properties;
    if (!properties || typeof properties !== "object") return null;
    const colors = [properties["col-font"], properties["col-back"], properties["col-board"], properties["col-button"], properties["col-link"], properties["col-logo"], properties["col-logoback"], properties["col-pbs"] || properties["col-pb"],].map(normalizeHexColor);
    if (colors.every((color) => !color)) return null;
    return themeFromCstimerColors(colors);
}

function themeFromCstimerColorLine(line) {
    const colors = String(line || "").match(/#[0-9a-f]{6}|#[0-9a-f]{3}/gi);
    if (!colors || colors.length !== 8) {
        throw new Error("Paste exactly eight csTimer colors, for example #eee#035#034#111#28d#678#034#f40.");
    }
    return themeFromCstimerColors(colors.map(normalizeHexColor));
}

function themeFromCstimerColors(colors) {
    const [font, background, board, button, link, logo, logoBackground, pbs] = colors;
    return normalizeTheme({
        "--text": font,
        "--bg": background,
        "--surface-lowest": shadeColor(background, -12),
        "--surface-low": board,
        "--surface": logoBackground || shadeColor(board, 5),
        "--surface-high": button,
        "--surface-highest": shadeColor(button, 16),
        "--muted": logo || mixColors(font, board, 0.7),
        "--outline": mixColors(font, board, 0.28),
        "--primary": link,
        "--primary-container": shadeColor(link, -45),
        "--ready": pbs || DEFAULT_THEME["--ready"],
        "--danger": "#ff6352",
        "--hold": "#d9b34f",
        "--lavender": "#c7a7ff",
    });
}

function normalizeTheme(rawTheme) {
    const normalized = {...DEFAULT_THEME};
    Object.entries(rawTheme || {}).forEach(([name, value]) => {
        if (name in DEFAULT_THEME && isHexColor(value)) normalized[name] = normalizeHexColor(value);
    });
    normalized.updatedAt = Number(rawTheme?.updatedAt || 0);
    return normalized;
}

function normalizeHexColor(value) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
        return `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`.toLowerCase();
    }
    return null;
}

function isHexColor(value) {
    return Boolean(normalizeHexColor(value));
}

function shadeColor(color, percent) {
    const [r, g, b] = hexToRgb(color);
    const amount = percent / 100;
    return rgbToHex([r, g, b].map((channel) => {
        const target = amount < 0 ? 0 : 255;
        return Math.round(channel + (target - channel) * Math.abs(amount));
    }));
}

function mixColors(left, right, leftWeight) {
    const leftRgb = hexToRgb(left);
    const rightRgb = hexToRgb(right);
    return rgbToHex(leftRgb.map((channel, index) => Math.round(channel * leftWeight + rightRgb[index] * (1 - leftWeight))));
}

function hexToRgb(color) {
    const value = normalizeHexColor(color) || "#000000";
    return [1, 3, 5].map((index) => Number.parseInt(value.slice(index, index + 2), 16));
}

function rgbToHex(channels) {
    return `#${channels.map((channel) => Math.min(255, Math.max(0, channel)).toString(16).padStart(2, "0")).join("")}`;
}

function setMessage(message, isError = false) {
    messageEl.textContent = message;
    messageEl.classList.toggle("error", isError);
}
