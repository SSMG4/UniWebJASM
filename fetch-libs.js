// fetch-libs.js
// Run this from your project root (node >= 18 recommended).
// It will attempt candidate CDN URLs and save local copies of pako.min.js and lz4.min.js
// Usage: node fetch-libs.js

const fs = require('fs');
const path = require('path');

const pakoCandidates = [
  'https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako.min.js',
  'https://unpkg.com/pako@2.1.0/dist/pako.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pako/2.1.0/pako.min.js'
];

const lz4Candidates = [
  './local-lz4-try-not-used.js',
  'https://cdn.jsdelivr.net/npm/lz4js@0.2.0/lz4.js',
  'https://unpkg.com/lz4js@0.2.0/lz4.js'
];

async function tryFetch(url) {
  try {
    // Node 18+ global fetch
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) {
      return { ok: false, status: res.status + ' ' + res.statusText };
    }
    const text = await res.text();
    // quick sanity check
    if (!text || text.length < 10) return { ok: false, status: 'empty body' };
    return { ok: true, text };
  } catch (err) {
    return { ok: false, status: String(err) };
  }
}

async function saveCandidates(candidates, outFilename) {
  console.log(`Trying to fetch candidates for ${outFilename}...`);
  for (const url of candidates) {
    if (!url) continue;
    // Skip local placeholder `./local-lz4-try-not-used.js` (the worker will attempt local files directly)
    if (url.startsWith('./')) {
      const localPath = path.resolve(url);
      if (fs.existsSync(localPath)) {
        console.log(`Found local file for ${outFilename} at ${url}. Copying to ./${outFilename}`);
        fs.copyFileSync(localPath, path.resolve(outFilename));
        return { ok: true, chosen: url };
      } else {
        console.log(`Local candidate ${url} not found.`);
        continue;
      }
    }
    console.log(`  trying ${url} ...`);
    const res = await tryFetch(url);
    if (res.ok) {
      try {
        fs.writeFileSync(path.resolve(outFilename), res.text, 'utf8');
        console.log(`Saved ${outFilename} from ${url}`);
        return { ok: true, chosen: url };
      } catch (err) {
        console.warn(`Failed to write ${outFilename}: ${err}`);
        return { ok: false, status: String(err) };
      }
    } else {
      console.log(`    failed: ${res.status}`);
    }
  }
  return { ok: false };
}

(async () => {
  // sanity: require node fetch
  if (typeof fetch !== 'function') {
    console.error('This script requires a Node runtime with global fetch (Node 18+).');
    process.exitCode = 1;
    return;
  }

  const pakoResult = await saveCandidates(pakoCandidates, 'pako.min.js');
  if (!pakoResult.ok) {
    console.warn('Could not fetch pako automatically. Please download pako.min.js and place it in the project root.');
  } else {
    console.log('pako saved from:', pakoResult.chosen);
  }

  const lz4Result = await saveCandidates(lz4Candidates, 'lz4.js');
  if (!lz4Result.ok) {
    console.warn('Could not fetch lz4 automatically. Please download a working lz4 build (lz4.min.js) and place it in the project root.');
  } else {
    console.log('lz4 saved from:', lz4Result.chosen);
  }

  console.log('\nDone. Start your local server and open http://localhost:8000/');
})();