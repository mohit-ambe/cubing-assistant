const PROFILE_STORAGE_KEY = "cubingAssistant.googleProfile";
const DATA_OWNER_STORAGE_KEY = "cubingAssistant.dataOwnerProfile";
const ACCOUNT_SWITCH_STORAGE_KEY = "cubingAssistant.pendingAccountSwitch";
const ACCOUNT_SWITCH_RESOLVED_STORAGE_KEY = "cubingAssistant.accountSwitchResolved";
const TIMER_STORAGE_KEY = "cubingAssistant.timerState";
const LAST_SYNC_STORAGE_KEY = "cubingAssistant.lastAutoSync";
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
const accountSwitchDialogEl = document.querySelector("#accountSwitchDialog");
const accountSwitchMessageEl = document.querySelector("#accountSwitchMessage");
const browserDataSummaryEl = document.querySelector("#browserDataSummary");
const newAccountLabelEl = document.querySelector("#newAccountLabel");
const accountDataSummaryEl = document.querySelector("#accountDataSummary");
const accountSwitchNoteEl = document.querySelector("#accountSwitchNote");
const downloadAccountSwitchBackupEl = document.querySelector("#downloadAccountSwitchBackup");
const useAccountDataEl = document.querySelector("#useAccountData");
const mergeAccountDataEl = document.querySelector("#mergeAccountData");
const cancelAccountSwitchEl = document.querySelector("#cancelAccountSwitch");

let config = null;
let profile = null;
let driveConnected = false;
let pendingAccountSwitch = readJsonStorage(ACCOUNT_SWITCH_STORAGE_KEY);
let pendingRemoteSnapshot = null;
let resolvingAccountSwitch = false;
let loadingAccountSwitch = false;

window.handleCredentialResponse = handleCredentialResponse;

signOutEl.addEventListener("click", signOut);
connectDriveEl.addEventListener("click", connectDrive);
disconnectDriveEl.addEventListener("click", disconnectDrive);
syncNowEl.addEventListener("click", syncNow);
uploadLocalEl.addEventListener("click", uploadLocalData);
downloadDriveEl.addEventListener("click", downloadFromDrive);
useAccountDataEl.addEventListener("click", useNewAccountData);
mergeAccountDataEl.addEventListener("click", mergeSwitchedAccountData);
cancelAccountSwitchEl.addEventListener("click", cancelAccountSwitch);
accountSwitchDialogEl.addEventListener("cancel", (event) => event.preventDefault());
window.addEventListener("storage", (event) => {
    if (event.key === LAST_SYNC_STORAGE_KEY) {
        renderLastSynced();
    }
});
window.addEventListener("focus", renderLastSynced);
init();

async function init() {
    migrateDataOwnerProfile();
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
    const dataOwner = readJsonStorage(DATA_OWNER_STORAGE_KEY);
    if (dataOwner?.sub) {
        pendingAccountSwitch = {previous: dataOwner, next: null, detectedAt: Date.now()};
        localStorage.setItem(ACCOUNT_SWITCH_STORAGE_KEY, JSON.stringify(pendingAccountSwitch));
    }
    try {
        const session = await fetchJson("/api/auth/google", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({credential: response.credential}),
        });
        setProfile(session);
        driveConnected = Boolean(session.driveConnected);
        if (!dataOwner?.sub) {
            setDataOwner(session);
            clearPendingAccountSwitch();
        } else if (dataOwner.sub !== session.sub) {
            setPendingAccountSwitch(dataOwner, session);
        } else {
            clearPendingAccountSwitch();
        }
        render();
        await presentPendingAccountSwitch();
    } catch (error) {
        if (!pendingAccountSwitch?.next) {
            clearPendingAccountSwitch();
        }
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
            clearPendingAccountSwitch();
            render();
            return;
        }

        const dataOwner = readJsonStorage(DATA_OWNER_STORAGE_KEY);
        setProfile(session);
        driveConnected = Boolean(session.driveConnected);
        if (!dataOwner?.sub) {
            setDataOwner(session);
            clearPendingAccountSwitch();
        } else if (dataOwner.sub !== session.sub) {
            if (pendingAccountSwitch?.next?.sub !== session.sub) {
                setPendingAccountSwitch(dataOwner, session);
            }
        } else if (pendingAccountSwitch) {
            clearPendingAccountSwitch();
        }
        render();
        await presentPendingAccountSwitch();
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
                await presentPendingAccountSwitch();
            } catch (error) {
                driveStatusEl.textContent = error.message;
            }
        },
    });
    client.requestCode({prompt: "consent"});
}

async function disconnectDrive() {
    if (pendingAccountSwitch) return;
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
    clearPendingAccountSwitch();
    if (window.google?.accounts?.id) {
        google.accounts.id.disableAutoSelect();
    }
    render();
}

function render() {
    signedOutViewEl.hidden = Boolean(profile);
    signedInViewEl.hidden = !profile;
    connectDriveEl.hidden = !profile || driveConnected;
    disconnectDriveEl.hidden = !profile || !driveConnected || Boolean(pendingAccountSwitch);
    const canSync = Boolean(profile && driveConnected && !pendingAccountSwitch);
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
    if (pendingAccountSwitch) {
        driveStatusEl.textContent = driveConnected
            ? "Choose how to handle this account switch before synchronization resumes."
            : "Enable Drive sync to compare and load data from the new account.";
        manualSyncStatusEl.textContent = "Synchronization paused for account switch.";
    }
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
    if (!profile || !driveConnected || pendingAccountSwitch) return;
    setManualSyncBusy(true);
    manualSyncStatusEl.textContent = workingMessage;

    try {
        const message = await action();
        markSyncCompleted();
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

async function presentPendingAccountSwitch() {
    if (!pendingAccountSwitch || !profile || pendingAccountSwitch.next?.sub !== profile.sub) return;
    if (!driveConnected) return;
    if (loadingAccountSwitch || resolvingAccountSwitch) return;

    const switchedAccountSub = profile.sub;
    loadingAccountSwitch = true;
    pendingRemoteSnapshot = null;
    setAccountSwitchBusy(true, true);
    accountSwitchMessageEl.textContent = `You signed in as ${profile.email || profile.name || "a different Google account"}. This browser was previously connected to ${pendingAccountSwitch.previous.email || pendingAccountSwitch.previous.name || "another Google account"}.`;
    newAccountLabelEl.textContent = profile.email || profile.name || "New Google account";
    browserDataSummaryEl.textContent = summarizeSnapshot(createLocalSnapshot());
    accountDataSummaryEl.textContent = "Loading...";
    accountSwitchNoteEl.textContent = "Automatic and manual synchronization are paused until you choose.";
    if (!accountSwitchDialogEl.open) {
        downloadAccountSwitchBackupEl.checked = false;
        accountSwitchDialogEl.showModal();
    }

    try {
        const remoteSnapshot = await fetchJson("/api/sync");
        if (!pendingAccountSwitch || profile?.sub !== switchedAccountSub) return;
        pendingRemoteSnapshot = remoteSnapshot;
        accountDataSummaryEl.textContent = summarizeSnapshot(pendingRemoteSnapshot);
        setAccountSwitchBusy(false);
        useAccountDataEl.focus();
    } catch (error) {
        if (!pendingAccountSwitch || profile?.sub !== switchedAccountSub) return;
        accountDataSummaryEl.textContent = "Unavailable";
        accountSwitchNoteEl.textContent = `${error.message} Cancel this switch or try again after reconnecting Drive.`;
    } finally {
        loadingAccountSwitch = false;
    }
}

async function useNewAccountData() {
    if (!pendingRemoteSnapshot || resolvingAccountSwitch) return;
    setAccountSwitchBusy(true);
    try {
        if (downloadAccountSwitchBackupEl.checked) {
            downloadAccountSwitchBackup();
        }
        applySnapshot(pendingRemoteSnapshot);
        completeAccountSwitch();
        manualSyncStatusEl.textContent = "New account data loaded.";
    } catch (error) {
        accountSwitchNoteEl.textContent = error.message;
        setAccountSwitchBusy(false);
    }
}

async function mergeSwitchedAccountData() {
    if (!pendingRemoteSnapshot || resolvingAccountSwitch) return;
    setAccountSwitchBusy(true);
    try {
        if (downloadAccountSwitchBackupEl.checked) {
            downloadAccountSwitchBackup();
        }
        const merged = mergeSnapshots(createLocalSnapshot(), pendingRemoteSnapshot, "newest");
        const uploaded = await postSnapshot(merged, "local");
        applySnapshot(mergeSnapshots(merged, uploaded, "newest"));
        completeAccountSwitch();
        manualSyncStatusEl.textContent = "Browser and account data merged.";
    } catch (error) {
        accountSwitchNoteEl.textContent = error.message;
        setAccountSwitchBusy(false);
    }
}

async function cancelAccountSwitch() {
    if (resolvingAccountSwitch) return;
    resolvingAccountSwitch = true;
    try {
        await fetchJson("/api/auth/logout", {method: "POST"});
    } catch {
        // Local data remains untouched even if the logout request fails.
    }

    profile = null;
    driveConnected = false;
    localStorage.removeItem(PROFILE_STORAGE_KEY);
    clearPendingAccountSwitch();
    closeAccountSwitchDialog();
    if (window.google?.accounts?.id) {
        google.accounts.id.disableAutoSelect();
    }
    resolvingAccountSwitch = false;
    render();
}

function setAccountSwitchBusy(isBusy, allowCancel = false) {
    resolvingAccountSwitch = isBusy && !allowCancel;
    useAccountDataEl.disabled = isBusy || !pendingRemoteSnapshot;
    mergeAccountDataEl.disabled = isBusy || !pendingRemoteSnapshot;
    cancelAccountSwitchEl.disabled = isBusy && !allowCancel;
    downloadAccountSwitchBackupEl.disabled = isBusy;
}

function completeAccountSwitch() {
    setDataOwner(profile);
    clearPendingAccountSwitch();
    localStorage.setItem(ACCOUNT_SWITCH_RESOLVED_STORAGE_KEY, String(Date.now()));
    markSyncCompleted();
    closeAccountSwitchDialog();
    resolvingAccountSwitch = false;
    render();
    renderLastSynced();
}

function closeAccountSwitchDialog() {
    if (accountSwitchDialogEl.open) {
        accountSwitchDialogEl.close();
    }
    pendingRemoteSnapshot = null;
}

function summarizeSnapshot(snapshot) {
    const solveCount = Array.isArray(snapshot?.solves)
        ? snapshot.solves.filter((solve) => !solve.deletedAt).length
        : 0;
    const sessionCount = Array.isArray(snapshot?.sessions)
        ? snapshot.sessions.filter((session) => session?.id && session.id !== PLAYGROUND_SESSION_ID && !session.deletedAt).length
        : 0;
    return `${solveCount} ${solveCount === 1 ? "solve" : "solves"} · ${sessionCount} ${sessionCount === 1 ? "session" : "sessions"}`;
}

function downloadAccountSwitchBackup() {
    const timestamp = new Date().toISOString();
    const owner = pendingAccountSwitch?.previous;
    const payload = {
        exportedAt: timestamp,
        reason: "google-account-switch",
        account: owner || null,
        data: createLocalSnapshot(),
    };
    const filename = `cubing-assistant-account-switch-backup-${timestamp.slice(0, 10)}.json`;
    downloadJson(filename, payload);
}

function downloadJson(filename, payload) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], {type: "application/json"}));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.style.display = "none";
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

function markSyncCompleted() {
    localStorage.setItem(LAST_SYNC_STORAGE_KEY, String(Date.now()));
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
    const timestamp = Number(localStorage.getItem(LAST_SYNC_STORAGE_KEY) || 0);
    lastSyncedEl.textContent = timestamp ? `Last Sync Time: ${new Intl.DateTimeFormat(undefined, {
        month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    }).format(new Date(timestamp))}` : "Last Sync Time: Never";
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

function migrateDataOwnerProfile() {
    if (readJsonStorage(DATA_OWNER_STORAGE_KEY)?.sub) return;
    const existingProfile = readJsonStorage(PROFILE_STORAGE_KEY);
    if (existingProfile?.sub) {
        setDataOwner(existingProfile);
    }
}

function setDataOwner(nextProfile) {
    const owner = {
        sub: nextProfile.sub,
        name: nextProfile.name || "",
        email: nextProfile.email || "",
        picture: nextProfile.picture || "",
    };
    localStorage.setItem(DATA_OWNER_STORAGE_KEY, JSON.stringify(owner));
}

function setPendingAccountSwitch(previous, next) {
    pendingAccountSwitch = {
        previous: {
            sub: previous.sub,
            name: previous.name || "",
            email: previous.email || "",
        },
        next: {
            sub: next.sub,
            name: next.name || "",
            email: next.email || "",
        },
        detectedAt: Date.now(),
    };
    localStorage.setItem(ACCOUNT_SWITCH_STORAGE_KEY, JSON.stringify(pendingAccountSwitch));
}

function clearPendingAccountSwitch() {
    pendingAccountSwitch = null;
    pendingRemoteSnapshot = null;
    localStorage.removeItem(ACCOUNT_SWITCH_STORAGE_KEY);
}

function readJsonStorage(key) {
    try {
        return JSON.parse(localStorage.getItem(key) || "null");
    } catch {
        return null;
    }
}

async function fetchJson(url, options = {}) {
    const response = await fetch(url, options);
    const payload = await response.json();
    if (!response.ok) {
        throw new Error(payload.error || `Request failed (${response.status})`);
    }
    return payload;
}
