const PROFILE_STORAGE_KEY = "cubingAssistant.googleProfile";
const TIMER_STORAGE_KEY = "cubingAssistant.timerState";
const AUTO_SYNC_STORAGE_KEY = "cubingAssistant.lastAutoSync";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const PLAYGROUND_SESSION_ID = "playground";

const googleSigninButtonEl = document.querySelector("#googleSigninButton");
const signedOutViewEl = document.querySelector("#signedOutView");
const signedInViewEl = document.querySelector("#signedInView");
const profilePictureEl = document.querySelector("#profilePicture");
const profileNameEl = document.querySelector("#profileName");
const profileEmailEl = document.querySelector("#profileEmail");
const signOutEl = document.querySelector("#signOut");
const driveStatusEl = document.querySelector("#driveStatus");
const connectDriveEl = document.querySelector("#connectDrive");
const disconnectDriveEl = document.querySelector("#disconnectDrive");
const lastSyncedEl = document.querySelector("#lastSynced");
const manualSyncStatusEl = document.querySelector("#manualSyncStatus");
const conflictModeEl = document.querySelector("#conflictMode");
const syncNowEl = document.querySelector("#syncNow");
const uploadLocalEl = document.querySelector("#uploadLocal");
const downloadDriveEl = document.querySelector("#downloadDrive");

let config = null;
let profile = null;
let driveConnected = false;

window.handleCredentialResponse = handleCredentialResponse;

signOutEl.addEventListener("click", signOut);
connectDriveEl.addEventListener("click", connectDrive);
disconnectDriveEl.addEventListener("click", disconnectDrive);
syncNowEl.addEventListener("click", syncNow);
uploadLocalEl.addEventListener("click", uploadLocalData);
downloadDriveEl.addEventListener("click", downloadFromDrive);
init();

async function init() {
    config = await fetchJson("/api/config");
    await initializeGoogleSignin();
    await refreshAuthStatus();
}

async function initializeGoogleSignin() {
    await waitForGoogleIdentity();
    google.accounts.id.initialize({
        client_id: config.googleClientId, callback: handleCredentialResponse, auto_select: true,
    });
    google.accounts.id.renderButton(googleSigninButtonEl, {
        theme: "filled_black", size: "large",
    });
}

function waitForGoogleIdentity() {
    return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const interval = window.setInterval(() => {
            if (window.google?.accounts?.id) {
                window.clearInterval(interval);
                resolve();
            } else if (Date.now() - startedAt > 10000) {
                window.clearInterval(interval);
                reject(new Error("Google Identity Services did not load."));
            }
        }, 50);
    });
}

async function handleCredentialResponse(response) {
    try {
        const session = await fetchJson("/api/auth/google", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({credential: response.credential}),
        });
        setProfile(session);
        driveConnected = Boolean(session.driveConnected);
        render();
    } catch (error) {
        driveStatusEl.textContent = error.message;
    }
}

async function refreshAuthStatus() {
    try {
        const session = await fetchJson("/api/auth/status");
        if (!session.signedIn) {
            profile = null;
            driveConnected = false;
            localStorage.removeItem(PROFILE_STORAGE_KEY);
            render();
            return;
        }

        setProfile(session);
        driveConnected = Boolean(session.driveConnected);
        render();
    } catch (error) {
        profile = null;
        driveStatusEl.textContent = error.message;
        render();
    }
}

async function connectDrive() {
    if (!profile) return;
    if (!window.google?.accounts?.oauth2 || !config?.googleClientId) {
        driveStatusEl.textContent = "Google authorization is still loading. Try again in a moment.";
        return;
    }

    driveStatusEl.textContent = "Waiting for Drive permission...";
    const client = google.accounts.oauth2.initCodeClient({
        client_id: config.googleClientId, scope: DRIVE_SCOPE, ux_mode: "popup", callback: async (response) => {
            if (response.error) {
                driveStatusEl.textContent = response.error;
                return;
            }

            try {
                await fetchJson("/api/google/code", {
                    method: "POST",
                    headers: {"Content-Type": "application/json"},
                    body: JSON.stringify({code: response.code}),
                });
                driveConnected = true;
                driveStatusEl.textContent = "Drive sync is connected.";
                manualSyncStatusEl.textContent = "Drive connected. Manual sync is available.";
                render();
            } catch (error) {
                driveStatusEl.textContent = error.message;
            }
        },
    });
    client.requestCode({prompt: "consent"});
}

async function disconnectDrive() {
    try {
        await fetchJson("/api/google/disconnect", {method: "POST"});
        driveConnected = false;
        manualSyncStatusEl.textContent = "Drive disconnected.";
        render();
    } catch (error) {
        driveStatusEl.textContent = error.message;
    }
}

async function signOut() {
    try {
        await fetchJson("/api/auth/logout", {method: "POST"});
    } catch {
        // The local browser should still sign out if the backend is unavailable.
    }

    profile = null;
    driveConnected = false;
    localStorage.removeItem(PROFILE_STORAGE_KEY);
    if (window.google?.accounts?.id) {
        google.accounts.id.disableAutoSelect();
    }
    render();
}

function render() {
    signedOutViewEl.hidden = Boolean(profile);
    signedInViewEl.hidden = !profile;
    connectDriveEl.hidden = !profile || driveConnected;
    disconnectDriveEl.hidden = !profile || !driveConnected;
    const canSync = Boolean(profile && driveConnected);
    syncNowEl.disabled = !canSync;
    uploadLocalEl.disabled = !canSync;
    downloadDriveEl.disabled = !canSync;
    conflictModeEl.disabled = !canSync;
    renderLastSynced();

    if (!profile) {
        driveStatusEl.textContent = "Sign in first, then connect Drive to synchronize solve history across devices.";
        manualSyncStatusEl.textContent = "Connect Drive to enable manual sync.";
        return;
    }

    profilePictureEl.src = profile.picture;
    profilePictureEl.hidden = !profile.picture;
    profileNameEl.textContent = profile.name || "Google Account";
    profileEmailEl.textContent = profile.email;
    driveStatusEl.textContent = driveConnected ? "Drive sync is connected." : "Signed in. Enable Drive sync to upload and download solve history.";
    if (!driveConnected) {
        manualSyncStatusEl.textContent = "Connect Drive to enable manual sync.";
    }
}

async function syncNow() {
    await runManualSync("Syncing...", async () => {
        const local = createLocalSnapshot();
        const remote = await fetchJson("/api/sync");
        const merged = mergeSnapshots(local, remote, conflictModeEl.value);
        applySnapshot(merged);
        const uploaded = await postSnapshot(merged, "local");
        applySnapshot(mergeSnapshots(merged, uploaded, "newest"));
        return "Sync complete.";
    });
}

async function uploadLocalData() {
    await runManualSync("Uploading local data...", async () => {
        const uploaded = await postSnapshot(createLocalSnapshot(), "local");
        applySnapshot(mergeSnapshots(createLocalSnapshot(), uploaded, "newest"));
        return "Local data uploaded and merged with Drive.";
    });
}

async function downloadFromDrive() {
    await runManualSync("Downloading from Drive...", async () => {
        const remote = await fetchJson("/api/sync");
        const merged = mergeSnapshots(createLocalSnapshot(), remote, conflictModeEl.value);
        applySnapshot(merged);
        return "Drive data downloaded.";
    });
}

async function runManualSync(workingMessage, action) {
    if (!profile || !driveConnected) return;
    setManualSyncBusy(true);
    manualSyncStatusEl.textContent = workingMessage;

    try {
        const message = await action();
        manualSyncStatusEl.textContent = message;
    } catch (error) {
        manualSyncStatusEl.textContent = error.message;
    } finally {
        setManualSyncBusy(false);
        renderLastSynced();
    }
}

function setManualSyncBusy(isBusy) {
    [syncNowEl, uploadLocalEl, downloadDriveEl, conflictModeEl].forEach((control) => {
        control.disabled = isBusy || !profile || !driveConnected;
    });
}

async function postSnapshot(snapshot, mode = "newest") {
    return fetchJson(`/api/sync?mode=${encodeURIComponent(mode)}`, {
        method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(snapshot),
    });
}

function createLocalSnapshot() {
    const saved = readStoredTimerState();
    return {
        schemaVersion: 2,
        updatedAt: Date.now(),
        sessions: normalizeSessions(saved.sessions),
        sessionScrambleIndexes: saved.sessionScrambleIndexes || {},
        solves: Array.isArray(saved.solves) ? saved.solves : [],
        theme: saved.theme || {},
    };
}

function applySnapshot(snapshot) {
    const saved = readStoredTimerState();
    const next = {
        ...saved,
        sessions: normalizeSessions(snapshot.sessions),
        sessionScrambleIndexes: snapshot.sessionScrambleIndexes || {},
        solves: Array.isArray(snapshot.solves) ? snapshot.solves : [],
        theme: snapshot.theme || saved.theme || {},
    };
    localStorage.setItem(TIMER_STORAGE_KEY, JSON.stringify(next));
    window.CubingAssistantTheme?.applyTheme(next.theme);
}

function mergeSnapshots(local, drive, mode) {
    return {
        schemaVersion: 2,
        updatedAt: Date.now(),
        sessions: mergeRecordsById(local.sessions || [], drive.sessions || [], mode, "session"),
        sessionScrambleIndexes: mode === "drive" ? {...(local.sessionScrambleIndexes || {}), ...(drive.sessionScrambleIndexes || {})} : {...(drive.sessionScrambleIndexes || {}), ...(local.sessionScrambleIndexes || {})},
        solves: mergeRecordsById(local.solves || [], drive.solves || [], mode, "solve"),
        theme: chooseRecord(local.theme || {}, drive.theme || {}, mode),
    };
}

function mergeRecordsById(localRecords, driveRecords, mode, type) {
    const records = new Map();
    [...driveRecords, ...localRecords].forEach((record) => {
        if (!record?.id) return;
        const current = records.get(record.id);
        if (!current) {
            records.set(record.id, record);
            return;
        }

        const localRecord = localRecords.find((entry) => entry.id === record.id);
        const driveRecord = driveRecords.find((entry) => entry.id === record.id);
        records.set(record.id, chooseRecord(localRecord || current, driveRecord || current, mode));
    });

    if (type === "session") {
        return normalizeSessions([...records.values()]);
    }
    return [...records.values()];
}

function chooseRecord(localRecord, driveRecord, mode) {
    if (mode === "local") return localRecord || driveRecord || {};
    if (mode === "drive") return driveRecord || localRecord || {};
    return getRecordUpdatedAt(localRecord) >= getRecordUpdatedAt(driveRecord) ? (localRecord || {}) : (driveRecord || {});
}

function getRecordUpdatedAt(record) {
    return Number(record?.updatedAt || record?.deletedAt || record?.redoneAt || record?.createdAt || 0);
}

function normalizeSessions(sessions) {
    const playground = {id: PLAYGROUND_SESSION_ID, name: "Playground", event: null, createdAt: 0, updatedAt: 0};
    const named = Array.isArray(sessions) ? sessions.filter((session) => session?.id && session.id !== PLAYGROUND_SESSION_ID) : [];
    return [playground, ...named];
}

function readStoredTimerState() {
    try {
        return JSON.parse(localStorage.getItem(TIMER_STORAGE_KEY) || "{}");
    } catch {
        return {};
    }
}

function renderLastSynced() {
    const timestamp = Number(localStorage.getItem(AUTO_SYNC_STORAGE_KEY) || 0);
    lastSyncedEl.textContent = timestamp ? `Auto Sync Time: ${new Intl.DateTimeFormat(undefined, {
        month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    }).format(new Date(timestamp))}` : "Auto Sync Time: Never";
}

function setProfile(nextProfile) {
    profile = {
        sub: nextProfile.sub,
        name: nextProfile.name || "",
        email: nextProfile.email || "",
        picture: nextProfile.picture || "",
    };
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
}

async function fetchJson(url, options = {}) {
    const response = await fetch(url, options);
    const payload = await response.json();
    if (!response.ok) {
        throw new Error(payload.error || `Request failed (${response.status})`);
    }
    return payload;
}