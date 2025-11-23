// script.js - fixes: avoid detaching original ArrayBuffer by sending a copy to worker,
// defensive handling in extractAsciiStrings, and logging for worker libs/status

// DOM wiring
const themeToggle = document.getElementById('theme-toggle');
const docEl = document.documentElement;
let darkMode = localStorage.getItem('theme') === 'dark';
const unityFileInput = document.getElementById('unity-file');
const statusDiv = document.getElementById('status');
const assetList = document.getElementById('asset-list');

function applyTheme() {
    if (darkMode) {
        docEl.setAttribute('data-theme', 'dark');
        themeToggle.textContent = '☀️';
    } else {
        docEl.setAttribute('data-theme', 'light');
        themeToggle.textContent = '🌙';
    }
}

themeToggle.addEventListener('click', () => {
    darkMode = !darkMode;
    localStorage.setItem('theme', darkMode ? 'dark' : 'light');
    applyTheme();
});

applyTheme();

// Worker setup
let decompressor = null;
function ensureWorker() {
    if (decompressor) return decompressor;
    try {
        decompressor = new Worker('decompress-worker.js');
    } catch (err) {
        console.error('Failed to create decompression worker:', err);
        decompressor = null;
    }
    return decompressor;
}

// Utilities
function bytesToAsciiString(u8, start = 0, len = u8.length - start) {
    let s = '';
    for (let i = start; i < start + len && i < u8.length; i++) {
        const c = u8[i];
        if (c === 0) break;
        s += String.fromCharCode(c);
    }
    return s;
}

function findSequence(u8, seq, from = 0) {
    for (let i = from; i <= u8.length - seq.length; i++) {
        let ok = true;
        for (let j = 0; j < seq.length; j++) {
            if (u8[i + j] !== seq[j]) {
                ok = false;
                break;
            }
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

function sliceToBlob(u8, start, end, mime) {
    const slice = u8.slice(start, end);
    return new Blob([slice], { type: mime || 'application/octet-stream' });
}

// Scanners
function scanForImages(buffer) {
    const u8 = new Uint8Array(buffer);
    const results = [];

    const pngSig = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    let pos = 0;
    while (true) {
        const idx = findSequence(u8, pngSig, pos);
        if (idx === -1) break;
        const iendIdx = findSequence(u8, new Uint8Array([0x49, 0x45, 0x4E, 0x44]), idx);
        if (iendIdx !== -1) {
            const end = iendIdx + 8 + 4;
            results.push({ type: 'png', start: idx, end: Math.min(end, u8.length) });
            pos = end;
        } else {
            results.push({ type: 'png', start: idx, end: u8.length });
            break;
        }
    }

    const jpegStart = new Uint8Array([0xFF, 0xD8]);
    const jpegEnd = new Uint8Array([0xFF, 0xD9]);
    pos = 0;
    while (true) {
        const idx = findSequence(u8, jpegStart, pos);
        if (idx === -1) break;
        const jend = findSequence(u8, jpegEnd, idx + 2);
        if (jend !== -1) {
            results.push({ type: 'jpg', start: idx, end: jend + 2 });
            pos = jend + 2;
        } else {
            results.push({ type: 'jpg', start: idx, end: u8.length });
            break;
        }
    }

    return results;
}

// Extract readable ASCII strings (defensive: catch detached buffer errors)
function extractAsciiStrings(buffer, minLen = 4, maxCount = 100) {
    try {
        const u8 = new Uint8Array(buffer);
        let cur = '';
        const found = [];
        for (let i = 0; i < u8.length; i++) {
            const c = u8[i];
            if (c >= 32 && c <= 126) {
                cur += String.fromCharCode(c);
            } else {
                if (cur.length >= minLen) {
                    found.push(cur);
                    if (found.length >= maxCount) return found;
                }
                cur = '';
            }
        }
        if (cur.length >= minLen) found.push(cur);
        return found;
    } catch (err) {
        console.warn('extractAsciiStrings: failed to read buffer (detached?)', err);
        return [];
    }
}

function scanForAssemblies(buffer) {
    const u8 = new Uint8Array(buffer);
    const mzSig = new Uint8Array([0x4D, 0x5A]); // 'MZ'
    const starts = findAllSequences(u8, mzSig, 0);
    const results = [];
    if (starts.length === 0) return results;

    const pngSig = new Uint8Array([0x89, 0x50, 0x4E, 0x47]);
    const jpgSig = new Uint8Array([0xFF, 0xD8]);
    const gzipSig = new Uint8Array([0x1F, 0x8B]);
    const lz4Sig = new Uint8Array([0x04, 0x22, 0x4D, 0x18]);

    const otherSigs = [pngSig, jpgSig, gzipSig, lz4Sig];

    for (let i = 0; i < starts.length; i++) {
        const s = starts[i];
        let nextBound = u8.length;
        for (const sig of otherSigs) {
            const idx = findSequence(u8, sig, s + 2);
            if (idx !== -1 && idx < nextBound) nextBound = idx;
        }
        if (i + 1 < starts.length && starts[i + 1] < nextBound) nextBound = starts[i + 1];
        if (nextBound - s > 128) {
            results.push({ start: s, end: nextBound });
        }
    }
    return results;
}

function clearAssets() {
    assetList.innerHTML = '';
}

function addAssetCard(imgBlob, metaText, downloadName = null) {
    const card = document.createElement('div');
    card.className = 'asset-card';
    if (imgBlob) {
        const url = URL.createObjectURL(imgBlob);
        const img = document.createElement('img');
        img.src = url;
        img.onload = () => URL.revokeObjectURL(url);
        card.appendChild(img);
    }
    const meta = document.createElement('div');
    meta.className = 'asset-meta';
    meta.textContent = metaText;
    card.appendChild(meta);

    if (downloadName && imgBlob) {
        const actions = document.createElement('div');
        actions.className = 'asset-actions';
        const a = document.createElement('a');
        a.href = URL.createObjectURL(imgBlob);
        a.download = downloadName;
        a.textContent = `Save ${downloadName}`;
        a.onclick = () => setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        actions.appendChild(a);
        card.appendChild(actions);
    }

    assetList.appendChild(card);
}

// Main file handler - now sends a COPY of the file buffer to the worker so the original stays valid
unityFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    clearAssets();
    statusDiv.textContent = '';

    if (!file) {
        statusDiv.textContent = 'No file selected.';
        return;
    }
    if (!file.name.endsWith('.unity3d')) {
        statusDiv.textContent = 'Please select a .unity3d file.';
        return;
    }

    statusDiv.textContent = `Reading ${file.name} (${file.size} bytes) ...`;
    const buffer = await file.arrayBuffer();

    // Quick header detection
    const u8head = new Uint8Array(buffer, 0, Math.min(64, buffer.byteLength));
    const signature = bytesToAsciiString(u8head, 0, 16);

    statusDiv.textContent += `\nHeader signature: ${signature}`;

    // Ensure worker is available
    const w = ensureWorker();
    if (!w) {
        statusDiv.textContent += '\nNo worker available; fallback will be attempted in main thread (slower).';
    } else {
        statusDiv.textContent += '\nStarting decompression attempts in worker...';
    }

    // We will send a COPY of the original buffer to the worker (so main thread buffer remains usable)
    let decompressedBuffer = null;
    let workerAttempts = [];
    let detectedCompression = null;
    let workerLibs = [];

    if (w) {
        // create a copy and transfer the copy to the worker. This keeps `buffer` usable in the main thread.
        let workerBuffer = null;
        try {
            workerBuffer = buffer.slice(0);
        } catch (err) {
            // If slice fails for some reason, try sending the original without transfer (will clone internally)
            workerBuffer = buffer;
        }

        const workerResult = await new Promise((resolve) => {
            const onmsg = (ev) => {
                const data = ev.data;
                w.removeEventListener('message', onmsg);
                resolve(data);
            };
            w.addEventListener('message', onmsg);
            try {
                // transfer the copied buffer if possible to avoid double-cloning large memory
                if (workerBuffer !== buffer) {
                    w.postMessage({ cmd: 'decompress', buffer: workerBuffer }, [workerBuffer]);
                } else {
                    w.postMessage({ cmd: 'decompress', buffer: workerBuffer });
                }
            } catch (err) {
                // fallback to sending without transfer
                try {
                    w.postMessage({ cmd: 'decompress', buffer: workerBuffer });
                } catch (err2) {
                    console.error('Failed to postMessage to worker:', err2);
                    resolve({ ok: false, error: 'postMessage to worker failed' });
                }
            }
        });

        if (!workerResult) {
            statusDiv.textContent += '\nWorker returned no result.';
        } else if (!workerResult.ok) {
            statusDiv.textContent += `\nWorker error: ${workerResult.error || 'unknown'}`;
            workerAttempts = workerResult.attempts || [];
        } else {
            workerAttempts = workerResult.attempts || [];
            detectedCompression = workerResult.compression || null;
            workerLibs = workerResult.libs || [];
            if (workerResult.decompressed) {
                decompressedBuffer = workerResult.decompressed;
            }
        }
    }

    // Present preliminary status
    let statusText =
        `Loaded "${file.name}"\n` +
        `Header signature: ${signature}\n` +
        `File size: ${file.size} bytes\n` +
        `Decompression attempts:\n  - ${workerAttempts.join('\n  - ')}\n` +
        `Detected compression: ${detectedCompression || 'none / unknown'}\n` +
        `Worker libs: ${workerLibs.map(l => (l && l.method ? `${l.method} ${l.url}` : (l && l.url) || '')).join('; ')}\n`;
    statusDiv.textContent = statusText;

    // Choose buffer to scan: decompressedBuffer if available or the original `buffer` (which is still valid)
    const scanBuffer = decompressedBuffer || buffer;

// Extract strings
const strings = extractAsciiStrings(scanBuffer, 6, 60);
if (strings.length > 0) {
    addAssetCard(null, `Extracted strings (sample): ${strings.slice(0, 8).join(', ')}`);
}

    // Parse Unity bundle/serialized file
    try {
      const { UnityParser } = await import('./parser.js');
      const parser = new UnityParser(scanBuffer);
      const hdrText = parser.parseHeader();
      const assetsMeta = parser.parseAssets();

      addAssetCard(null, `Parsed header: ${hdrText}`);
      if (assetsMeta && assetsMeta.length > 0) {
           for (const a of assetsMeta.slice(0, 12)) {
               addAssetCard(null, `Parsed asset: [${a.type}] ${a.name}`);
         }
      }
    } catch (err) {
      console.warn('Parser failed:', err);
       addAssetCard(null, `Parser error: ${err && err.message ? err.message : String(err)}`);
    }

    // Scan for images
    const images = scanForImages(scanBuffer);
    statusDiv.textContent += `Found ${images.length} embedded image(s) heuristically.\n`;
    if (images.length === 0) {
        const p = document.createElement('p');
        p.className = 'placeholder';
        p.textContent = '(No raw PNG/JPEG found heuristically. Many Unity assets are serialized or compressed with formats this prototype does not yet decode like LZMA/LZFSE or Unity SerializedFile objects.)';
        assetList.appendChild(p);
    } else {
        const u8 = new Uint8Array(scanBuffer);
        let count = 0;
        for (const im of images) {
            count++;
            const mime = im.type === 'png' ? 'image/png' : 'image/jpeg';
            const blob = sliceToBlob(u8, im.start, im.end, mime);
            addAssetCard(blob, `${im.type.toUpperCase()} (bytes ${im.start}-${im.end})`);
        }
        statusDiv.textContent += `Displayed ${count} image(s).\n`;
    }

    // Scan for assemblies
    const assemblies = scanForAssemblies(scanBuffer);
    statusDiv.textContent += `Found ${assemblies.length} possible PE assembly(s) heuristically.\n`;
    if (assemblies.length > 0) {
        const u8 = new Uint8Array(scanBuffer);
        let idx = 0;
        for (const asm of assemblies) {
            idx++;
            const blob = sliceToBlob(u8, asm.start, asm.end, 'application/octet-stream');
            const suggestedName = `extracted_${idx}.dll`;
            addAssetCard(blob, `Possible PE (bytes ${asm.start}-${asm.end})`, suggestedName);
        }
    }

    // --- Emulator integration ---
    import("./emulator.js").then(({ UniWebJASM }) => {
        const emulator = new UniWebJASM(scanBuffer);
        emulator.start();
    });

    statusDiv.textContent += '\nDone. (Worker-driven decompression completed.)';
});
