async function ensureScript(url) {
    try {
        importScripts(url);
        return { ok: true, method: 'importScripts', url };
    } catch (err) {
        try {
            const res = await fetch(url, { cache: 'no-store' });
            if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, url };
            const code = await res.text();
            const blob = new Blob([code], { type: 'application/javascript' });
            const blobUrl = URL.createObjectURL(blob);
            try {
                importScripts(blobUrl);
                return { ok: true, method: 'fetch+blob', url };
            } finally {
                URL.revokeObjectURL(blobUrl);
            }
        } catch (fetchErr) {
            return { ok: false, error: String(fetchErr), url };
        }
    }
}

async function ensureScriptFromList(urls) {
    for (const url of urls) {
        if (!url) continue;
        const res = await ensureScript(url);
        if (res.ok) return res;
    }
    return { ok: false };
}

self.onmessage = async (ev) => {
    const msg = ev.data;
    if (!msg || msg.cmd !== 'ping') {
        postMessage({ ok: false, error: 'unknown command' });
        return;
    }
    postMessage({ ok: true, pong: true });
};
