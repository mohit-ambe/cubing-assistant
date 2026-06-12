(function () {
    const CHUNK_TARGET_BYTES = 1_250_000;
    const CHUNK_MAX_SOLVES = 1_000;
    const encoder = new TextEncoder();

    async function requestJson(url, options = {}) {
        const response = await fetch(url, options);
        let payload = {};
        try {
            payload = await response.json();
        } catch {
        }
        if (!response.ok) {
            const error = new Error(payload.error || `Request failed (${response.status})`);
            error.status = response.status;
            throw error;
        }
        return payload;
    }

    async function downloadSnapshot(transferId = null) {
        let descriptor;
        try {
            descriptor = transferId
                ? {transferId}
                : await requestJson("/api/sync/downloads", {method: "POST"});
        } catch (error) {
            if (!transferId && error.status === 503) {
                return requestJson("/api/sync");
            }
            throw error;
        }
        let offset = 0;
        let snapshot = null;
        while (true) {
            const chunk = await requestJson(
                `/api/sync/downloads/${encodeURIComponent(descriptor.transferId)}?offset=${offset}`
            );
            if (!snapshot) {
                snapshot = {...(chunk.metadata || {}), solves: []};
            }
            snapshot.solves.push(...(chunk.solves || []));
            if (chunk.done) return snapshot;
            if (!Number.isInteger(chunk.nextOffset) || chunk.nextOffset <= offset) {
                throw new Error("Sync download did not advance.");
            }
            offset = chunk.nextOffset;
        }
    }

    function splitSolves(solves) {
        const chunks = [];
        let current = [];
        let currentBytes = 24;
        for (const solve of solves) {
            const solveBytes = encoder.encode(JSON.stringify(solve)).length + 1;
            if (current.length && (
                current.length >= CHUNK_MAX_SOLVES
                || currentBytes + solveBytes > CHUNK_TARGET_BYTES
            )) {
                chunks.push(current);
                current = [];
                currentBytes = 24;
            }
            current.push(solve);
            currentBytes += solveBytes;
        }
        if (current.length) chunks.push(current);
        return chunks;
    }

    async function uploadSnapshot(snapshot, mode = "newest") {
        const solves = Array.isArray(snapshot.solves) ? snapshot.solves : [];
        const metadata = {...snapshot};
        delete metadata.solves;
        let descriptor;
        try {
            descriptor = await requestJson("/api/sync/uploads", {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({metadata, totalSolves: solves.length, mode}),
            });
        } catch (error) {
            if (error.status === 503) {
                return uploadSnapshotStateless(metadata, solves, mode);
            }
            throw error;
        }
        let offset = 0;
        for (const chunk of splitSolves(solves)) {
            await requestJson(`/api/sync/uploads/${encodeURIComponent(descriptor.transferId)}/chunks`, {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({offset, solves: chunk}),
            });
            offset += chunk.length;
        }
        const result = await requestJson(
            `/api/sync/uploads/${encodeURIComponent(descriptor.transferId)}/complete`,
            {method: "POST"},
        );
        return downloadSnapshot(result.transferId);
    }

    async function uploadSnapshotStateless(metadata, solves, mode) {
        const chunks = splitSolves(solves);
        const batches = chunks.length ? chunks : [[]];
        for (const chunk of batches) {
            await requestJson("/api/import-batches", {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({...metadata, solves: chunk, mode}),
            });
        }
        return downloadSnapshot();
    }

    window.CubingAssistantSync = {
        downloadSnapshot,
        uploadSnapshot,
    };
})();
