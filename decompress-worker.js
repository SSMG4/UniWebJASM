// decompress-worker.js - local-first loader + decompression worker for GitHub Pages
// Place this file at project root (same dir as index.html). Ensure pako.min.js and lz4.min.js exist in repo root.

/*
Behavior:
- Try local './pako.min.js' and './lz4.min.js' first via importScripts.
- If local file missing or importScripts blocked, try a small list of CDN fallbacks using fetch+blob.
- Return a libs array describing exactly which file and method (importScripts or fetch+blob) succeeded or failed.
*/

async function ensureScript(url) {
    try {
        importScripts(url);
        return { ok: true, method: 'importScripts', url };
    } catch (err) {
        // importScripts failed (CORS / MIME / nosniff). Try fetch+blob fallback.
        try {
            const res = await fetch(url, { cache: 'no-store' });
            if (!res.ok) {
                return { ok: false, error: `fetch failed ${res.status} ${res.statusText}`, url };
            }
            const code = await res.text();
            const blob = new Blob([code], { type: 'application/javascript' });
            const blobUrl = URL.createObjectURL(blob);
            try {
                importScripts(blobUrl);
                return { ok: true, method: 'fetch+blob', url, blobUrl };
            } finally {
                URL.revokeObjectURL(blobUrl);
            }
        } catch (fetchErr) {
            return { ok: false, error: String(fetchErr), url };
        }
    }
}

async function ensureScriptFromList(urls) {
    const attempts = [];
    for (const url of urls) {
        if (!url) continue;
        const res = await ensureScript(url);
        attempts.push(res);
        if (res.ok) return { ok: true, chosen: res, attempts };
    }
    return { ok: false, attempts };
}

function findSequence(u8, seq, from = 0) {
    for (let i = from; i <= u8.length - seq.length; i++) {
        let ok = true;
        for (let j = 0; j < seq.length; j++) {
            if (u8[i + j] !== seq[j]) { ok = false; break; }
        }
        if (ok) return i;
    }
    return -1;
}
function findAllSequences(u8, seq, from = 0) {
    const out = [];
    let pos = from;
    while (true) {
        const idx = findSequence(u8, seq, pos);
        if (idx === -1) break;
        out.push(idx);
        pos = idx + 1;
    }
    return out;
}

self.onmessage = async (ev) => {
    const msg = ev.data;
    if (!msg || msg.cmd !== 'decompress' || !msg.buffer) {
        postMessage({ ok: false, error: 'invalid message: expected { cmd: "decompress", buffer: ArrayBuffer }' });
        return;
    }

    const buffer = msg.buffer;
    const u8 = new Uint8Array(buffer);
    const result = { attempts: [], compression: null, decompressed: null, libs: [] };

    // Local-first candidates (local copy in repo root => robust for Pages)
    const pakoCandidates = [
        './pako.min.js', // local (recommended)
        // trusted CDN fallbacks (used only if local not present)
        'https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako.min.js',
        'https://unpkg.com/pako@2.1.0/dist/pako.min.js'
    ];

    // A known-working LZ4 build candidate list. Prefer local copy.
    const lz4Candidates = [
       './lz4.js', // local copy (recommended)
      'https://cdn.jsdelivr.net/npm/lz4js@0.2.0/lz4.js',
      'https://unpkg.com/lz4js@0.2.0/lz4.js'
    ];


    // Load pako
    const pakoLoad = await ensureScriptFromList(pakoCandidates);
    result.libs.push({ name: 'pako', tried: pakoCandidates, outcome: pakoLoad });
    if (!pakoLoad.ok) {
        result.attempts.push(`pako load failed (all candidates)`);
    } else {
        result.attempts.push(`pako loaded via ${pakoLoad.chosen.method} (${pakoLoad.chosen.url})`);
    }

    // Load lz4 (optional)
    const lz4Load = await ensureScriptFromList(lz4Candidates);
    result.libs.push({ name: 'lz4', tried: lz4Candidates, outcome: lz4Load });
    if (!lz4Load.ok) {
        result.attempts.push(`lz4 load failed (all candidates) — LZ4 attempts will be skipped`);
    } else {
        result.attempts.push(`lz4 loaded via ${lz4Load.chosen.method} (${lz4Load.chosen.url})`);
    }

    try {
        // gzip/zlib detection
        const gzipIdx = findSequence(u8, new Uint8Array([0x1F, 0x8B]));
        const zlib1Idx = findSequence(u8, new Uint8Array([0x78, 0x9C]));
        const zlib2Idx = findSequence(u8, new Uint8Array([0x78, 0xDA]));
        const candidates = [];
        if (gzipIdx !== -1) candidates.push({ type: 'gzip', idx: gzipIdx });
        if (zlib1Idx !== -1) candidates.push({ type: 'zlib', idx: zlib1Idx });
        if (zlib2Idx !== -1) candidates.push({ type: 'zlib', idx: zlib2Idx });

        let done = false;
        if (typeof pako !== 'undefined' && candidates.length > 0) {
            for (const c of candidates.sort((a, b) => a.idx - b.idx)) {
                try {
                    if (c.type === 'gzip') {
                        const sub = u8.subarray(c.idx);
                        const out = pako.ungzip(sub);
                        result.decompressed = out.buffer;
                        result.compression = 'gzip';
                        result.attempts.push(`gunzipped at offset ${c.idx} OK`);
                        done = true; break;
                    } else if (c.type === 'zlib') {
                        const sub = u8.subarray(c.idx);
                        const out = pako.inflate(sub);
                        result.decompressed = out.buffer;
                        result.compression = 'zlib(deflate)';
                        result.attempts.push(`inflated zlib at offset ${c.idx} OK`);
                        done = true; break;
                    }
                } catch (err) {
                    result.attempts.push(`${c.type} at ${c.idx} failed: ${err && err.message ? err.message : err}`);
                }
            }
        } else {
            result.attempts.push('pako not available or no gzip/zlib signatures found.');
        }

// LZ4 frame attempts if not done
if (!done) {
    const lz4FrameSig = new Uint8Array([0x04, 0x22, 0x4D, 0x18]);
    const lz4Idxs = findAllSequences(u8, lz4FrameSig);

    const api = (typeof LZ4 !== 'undefined') ? LZ4 :
                (typeof self !== 'undefined' && typeof self.LZ4 !== 'undefined') ? self.LZ4 :
                (typeof lz4 !== 'undefined') ? lz4 : null;

    const hasLZ4 = !!api;

    const tryDecode = (bytes) => {
        // Try common function names used across builds
        if (!api) throw new Error('LZ4 runtime not present.');
        if (typeof api.decode === 'function') return api.decode(bytes);
        if (typeof api.decompress === 'function') return api.decompress(bytes);
        if (typeof api.uncompress === 'function') return api.uncompress(bytes);
        if (typeof api.decompressFrame === 'function') return api.decompressFrame(bytes);
        throw new Error('No compatible LZ4 decode function found.');
    };

    if (lz4Idxs.length > 0 && hasLZ4) {
        for (const idx of lz4Idxs) {
            try {
                const sub = u8.subarray(idx);
                const out = tryDecode(sub);
                const ab = (out instanceof ArrayBuffer) ? out : (out && out.buffer) ? out.buffer : null;
                if (ab) {
                    result.decompressed = ab;
                    result.compression = 'lz4(frame)';
                    result.attempts.push(`LZ4 frame at ${idx} decompressed OK`);
                    done = true;
                    break;
                } else {
                    result.attempts.push(`LZ4 at ${idx} produced no buffer`);
                }
            } catch (err) {
                result.attempts.push(`LZ4 at ${idx} failed: ${err && err.message ? err.message : String(err)}`);
            }
        }
    } else if (!hasLZ4) {
        result.attempts.push('LZ4 library not available; skipping LZ4 attempts.');
    } else {
        result.attempts.push('No LZ4 frame signatures found.');
    }
}

        // Final best-effort: try pako.inflate entire buffer
        if (!done && typeof pako !== 'undefined') {
            try {
                const out = pako.inflate(u8);
                result.decompressed = out.buffer;
                result.compression = 'zlib(deflate entire file)';
                result.attempts.push('inflated entire file buffer successfully (best-effort)');
                done = true;
            } catch (err) {
                result.attempts.push(`full inflate failed: ${err && err.message ? err.message : err}`);
            }
        }

        // reply with decompressed buffer (transfer if present)
        if (result.decompressed) {
            const ab = (result.decompressed instanceof ArrayBuffer) ? result.decompressed : (result.decompressed.buffer || result.decompressed);
            postMessage({ ok: true, compression: result.compression, attempts: result.attempts, libs: result.libs, decompressed: ab }, [ab]);
        } else {
            postMessage({ ok: true, compression: null, attempts: result.attempts, libs: result.libs, decompressed: null });
        }
    } catch (err) {
        postMessage({ ok: false, error: err && err.message ? err.message : String(err) });
    }
};
