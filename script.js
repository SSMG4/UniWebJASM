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

function setStatus(text) {
    statusDiv.textContent = text;
}

function appendStatus(text) {
    statusDiv.textContent += '\n' + text;
}

function clearAssets() {
    assetList.innerHTML = '';
}

function addAssetCard(imgBlob, metaText, downloadName) {
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

function addFileCard(name, buffer) {
    const card = document.createElement('div');
    card.className = 'asset-card';

    const meta = document.createElement('div');
    meta.className = 'asset-meta';
    meta.textContent = `📄 ${name}  (${buffer.byteLength.toLocaleString()} bytes)`;
    card.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'asset-actions';
    const blob = new Blob([buffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.textContent = `Save ${name}`;
    a.onclick = () => setTimeout(() => URL.revokeObjectURL(url), 2000);
    actions.appendChild(a);
    card.appendChild(actions);

    assetList.appendChild(card);
}

function bytesToHex(u8, len) {
    let s = '';
    for (let i = 0; i < Math.min(len, u8.length); i++) {
        s += u8[i].toString(16).padStart(2, '0') + ' ';
    }
    return s.trim();
}

function findSequence(u8, seq, from) {
    from = from || 0;
    for (let i = from; i <= u8.length - seq.length; i++) {
        let ok = true;
        for (let j = 0; j < seq.length; j++) {
            if (u8[i + j] !== seq[j]) { ok = false; break; }
        }
        if (ok) return i;
    }
    return -1;
}

function scanForImages(buffer) {
    const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const results = [];

    const pngSig = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    let pos = 0;
    while (true) {
        const idx = findSequence(u8, pngSig, pos);
        if (idx === -1) break;
        const iendIdx = findSequence(u8, new Uint8Array([0x49, 0x45, 0x4E, 0x44]), idx);
        const end = iendIdx !== -1 ? Math.min(iendIdx + 12, u8.length) : u8.length;
        results.push({ type: 'png', start: idx, end });
        pos = end;
    }

    const jpegStart = new Uint8Array([0xFF, 0xD8]);
    const jpegEnd   = new Uint8Array([0xFF, 0xD9]);
    pos = 0;
    while (true) {
        const idx = findSequence(u8, jpegStart, pos);
        if (idx === -1) break;
        const jend = findSequence(u8, jpegEnd, idx + 2);
        const end = jend !== -1 ? jend + 2 : u8.length;
        results.push({ type: 'jpg', start: idx, end });
        pos = end;
    }

    return results;
}

unityFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    clearAssets();

    if (!file) { setStatus('No file selected.'); return; }
    if (!file.name.endsWith('.unity3d')) { setStatus('Please select a .unity3d file.'); return; }

    setStatus(`Reading ${file.name} (${file.size.toLocaleString()} bytes) …`);

    const buffer = await file.arrayBuffer();
    const u8head = new Uint8Array(buffer, 0, Math.min(16, buffer.byteLength));
    appendStatus(`Header bytes: ${bytesToHex(u8head, 16)}`);

    const { UWPjsParser } = await import('./parser.js');
    const parser = new UWPjsParser(buffer);

    let parseResult;
    try {
        parseResult = parser.parse();
    } catch (err) {
        appendStatus(`Parse exception: ${err.message || err}`);
        parseResult = { ok: false, files: [], headerStr: 'Exception', error: err.message };
    }

    appendStatus(`Bundle kind : ${parseResult.bundleKind || 'unknown'}`);
    appendStatus(`Header      : ${parseResult.headerStr || '—'}`);

    if (parseResult.error) {
        appendStatus(`Note        : ${parseResult.error}`);
    }

    if (parseResult.blocks) {
        appendStatus(`Data blocks : ${parseResult.blocks.length}`);
    }

    if (parseResult.dirs) {
        appendStatus(`Dir entries : ${parseResult.dirs.length}`);
    }

    const files = parseResult.files || [];
    appendStatus(`Extracted files: ${files.length}`);

    if (files.length === 0) {
        const p = document.createElement('p');
        p.className = 'placeholder';
        p.textContent = parseResult.error
            ? `Could not extract files: ${parseResult.error}`
            : 'No files extracted from bundle.';
        assetList.appendChild(p);
    } else {
        for (const f of files) {
            addFileCard(f.name, f.buffer);
            const fu8 = new Uint8Array(f.buffer);
            const images = scanForImages(fu8);
            for (const im of images) {
                const mime = im.type === 'png' ? 'image/png' : 'image/jpeg';
                const blob = new Blob([fu8.subarray(im.start, im.end)], { type: mime });
                addAssetCard(blob, `${im.type.toUpperCase()} in ${f.name} (${im.end - im.start} bytes)`, `${f.name}_${im.start}.${im.type}`);
            }
        }
        appendStatus(`Done.`);
    }

    import('./emulator.js').then(({ UWPjs }) => {
        const emulator = new UWPjs(buffer);
        emulator.start();
    }).catch(() => {});
});
