(() => {
    async function inlineLogo() {
        const targets = document.querySelectorAll("[data-inline-logo]");
        if (!targets.length) return;

        try {
            const response = await fetch("/logo/logo.svg");
            if (!response.ok) throw new Error("Logo unavailable");
            const text = await response.text();
            const svg = new DOMParser().parseFromString(text, "image/svg+xml").querySelector("svg");
            if (!svg) throw new Error("Logo SVG missing");

            svg.setAttribute("aria-hidden", "true");
            svg.setAttribute("focusable", "false");
            svg.classList.add("side-brand-svg");
            targets.forEach((target) => {
                target.replaceChildren(svg.cloneNode(true));
            });
        } catch {
            targets.forEach((target) => {
                target.textContent = "CT";
            });
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", inlineLogo, {once: true});
    } else {
        inlineLogo();
    }
})();