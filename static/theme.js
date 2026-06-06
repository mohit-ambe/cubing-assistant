(() => {
    const STORAGE_KEY = "cubingAssistant.timerState";
    const THEME_VARS = ["--bg", "--surface-lowest", "--surface-low", "--surface", "--surface-high", "--surface-highest", "--text", "--muted", "--outline", "--primary", "--primary-container", "--danger", "--ready", "--hold", "--lavender",];

    function applyTheme(theme) {
        if (!theme || typeof theme !== "object") return;
        THEME_VARS.forEach((name) => {
            if (isHexColor(theme[name])) {
                document.documentElement.style.setProperty(name, theme[name]);
            }
        });
    }

    function isHexColor(value) {
        return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
    }

    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
        applyTheme(saved.theme);
    } catch {
        // Leave solve history untouched if only theme parsing fails.
    }

    window.CubingAssistantTheme = {applyTheme, themeVars: THEME_VARS};
})();