// parser.js – Unity AssetBundle parser (Phase 2)
// Supports: UnityFS / UnityWeb / UnityRaw headers, directory listing, basic SerializedFile probing

class BinReader {
    constructor(buffer, offset = 0) {
        this.view = new DataView(buffer);
        this.u8 = new Uint8Array(buffer);
        this.offset = offset;
        this.little = true;
    }
    seek(pos) { this.offset = pos; }
    skip(n) { this.offset += n; }
    tell() { return this.offset; }

    u8v(len) {
        const out = this.u8.subarray(this.offset, this.offset + len);
        this.offset += len;
        return out;
    }
    u8arr(len) {
        const out = new Uint8Array(len);
        out.set(this.u8.subarray(this.offset, this.offset + len));
        this.offset += len;
        return out;
    }
    u32() { const v = this.view.getUint32(this.offset, this.little); this.offset += 4; return v; }
    i32() { const v = this.view.getInt32(this.offset, this.little); this.offset += 4; return v; }
    u16() { const v = this.view.getUint16(this.offset, this.little); this.offset += 2; return v; }
    f32() { const v = this.view.getFloat32(this.offset, this.little); this.offset += 4; return v; }
    u64() {
        // JS has no 64-bit ints; return as Number (may lose precision) and BigInt separately
        const low = this.view.getUint32(this.offset, true);
        const high = this.view.getUint32(this.offset + 4, true);
        this.offset += 8;
        const big = (BigInt(high) << 32n) | BigInt(low);
        return { low, high, big, num: high * 4294967296 + low };
    }

    zstr() {
        // null-terminated ASCII
        let s = '';
        while (this.offset < this.view.byteLength) {
            const c = this.u8[this.offset++];
            if (c === 0) break;
            s += String.fromCharCode(c);
        }
        return s;
    }
    astr(len) {
        const s = new TextDecoder().decode(this.u8v(len));
        return s;
    }
}

function readStringTable(reader) {
    // AssetBundle names are typically zero-terminated; for directory entries use length-prefixed.
    // Helper for length-prefixed UTF8 string.
    const len = reader.u32();
    const bytes = reader.u8v(len);
    return new TextDecoder().decode(bytes);
}

function detectBundleHeader(u8) {
    const head = new TextDecoder().decode(u8.subarray(0, Math.min(64, u8.length)));
    if (head.startsWith('UnityFS')) return { kind: 'UnityFS' };
    if (head.startsWith('UnityWeb')) return { kind: 'UnityWeb' };
    if (head.startsWith('UnityRaw')) return { kind: 'UnityRaw' };
    return null;
}

function parseUnityFSHeader(reader) {
    // UnityFS
    // string: signature "UnityFS"
    // string: formatVersion (ascii)
    // string: unityVersion (ascii)
    // string: unityRevision (ascii)
    // u32: size of bundle header
    // u32: compressedSize
    // u32: uncompressedSize
    // u32: flags (bitfield; compression & layout)
    const signature = reader.zstr();            // "UnityFS"
    const formatVersion = reader.zstr();        // e.g., "6.x"
    const unityVersion = reader.zstr();         // e.g., "5.6.3p1"
    const unityRevision = reader.zstr();        // revision
    const size = reader.u32();
    const compressedSize = reader.u32();
    const uncompressedSize = reader.u32();
    const flags = reader.u32();

    return {
        signature, formatVersion, unityVersion, unityRevision,
        size, compressedSize, uncompressedSize, flags
    };
}

function parseUnityWebRawHeader(reader) {
    // UnityWeb / UnityRaw share similar initial fields
    const signature = reader.zstr();            // "UnityWeb" or "UnityRaw"
    const formatVersion = reader.zstr();        // e.g., "3.x.x"
    const unityVersion = reader.zstr();         // e.g., "3.5.7f6"
    const unityRevision = reader.zstr();        // revision
    const size = reader.u32();                  // total file size
    const compressedSize = reader.u32();
    const uncompressedSize = reader.u32();
    const flags = reader.u32();
    return {
        signature, formatVersion, unityVersion, unityRevision,
        size, compressedSize, uncompressedSize, flags
    };
}

function parseUnityFSDirectory(reader) {
    // After header, UnityFS has a block & directory info region.
    // Layout (simplified):
    // - Block info (compressed) -> skip for now, we aim to read directory table metadata
    // - Directory info (compressed) -> entries of files (name, offset, size, flags)
    // Because those tables are often compressed (LZ4/LZMA), we can’t reliably decode without a full pipeline.
    // Heuristic: scan for CAB- file names or length-prefixed UTF8 entries commonly used.
    const start = reader.tell();
    const end = reader.view.byteLength;

    // Scan for ASCII names like "CAB-" or ".assets"
    const u8 = reader.u8.subarray(start, end);
    const text = new TextDecoder().decode(u8);
    const names = [];
    const regex = /(CAB-[A-Za-z0-9_-]+|sharedassets\d+\.assets|level\d+\.assets)/g;
    let m;
    while ((m = regex.exec(text)) !== null) {
        names.push({ name: m[0], approxOffset: start + m.index });
    }
    return { entries: names, note: 'Directory likely compressed; names extracted heuristically.' };
}

function probeSerializedFile(reader) {
    // SerializedFile header (Unity 5.x+):
    // u32 metadataSize, u32 fileSize, u32 version, u32 dataOffset, u8 endian (0x00=big, 0x01=little), then type tree if present
    const start = reader.tell();
    if (reader.view.byteLength - start < 20) return null;

    const metadataSize = reader.u32();
    const fileSize = reader.u32();
    const version = reader.u32();
    const dataOffset = reader.u32();
    const endian = reader.u8();

    // Sanity checks
    const plausible =
        metadataSize > 0 && metadataSize < fileSize &&
        fileSize <= reader.view.byteLength &&
        dataOffset < fileSize &&
        (endian === 0 || endian === 1);

    if (!plausible) return null;

    reader.little = (endian === 1);
    return { metadataSize, fileSize, version, dataOffset, endianLittle: reader.little };
}

export class UnityParser {
    constructor(buffer) {
        this.buffer = buffer;
        this.u8 = new Uint8Array(buffer);
        this.header = null;
        this.bundleKind = null;
        this.directory = null;
        this.serializedProbe = null;
    }

    parseHeader() {
        const hdr = detectBundleHeader(this.u8);
        if (!hdr) {
            console.log('UnityParser: no bundle header detected; attempting SerializedFile probe.');
            const reader = new BinReader(this.buffer, 0);
            const sf = probeSerializedFile(reader);
            if (sf) {
                this.serializedProbe = sf;
                this.bundleKind = 'SerializedFile';
                return `SerializedFile v${sf.version} (offset=${sf.dataOffset}, little=${sf.endianLittle})`;
            }
            return 'Unknown format';
        }

        this.bundleKind = hdr.kind;
        const reader = new BinReader(this.buffer, 0);
        if (hdr.kind === 'UnityFS') {
            const h = parseUnityFSHeader(reader);
            this.header = h;
            return `${h.signature} ${h.formatVersion} • ${h.unityVersion} (${h.unityRevision}) flags=${h.flags}`;
        } else {
            const h = parseUnityWebRawHeader(reader);
            this.header = h;
            return `${h.signature} ${h.formatVersion} • ${h.unityVersion} (${h.unityRevision}) flags=${h.flags}`;
        }
    }

    parseAssets() {
        if (this.bundleKind === 'UnityFS') {
            const reader = new BinReader(this.buffer, 0);
            // Move past header strings & numbers
            parseUnityFSHeader(reader);
            const dir = parseUnityFSDirectory(reader);
            this.directory = dir;
            return (dir.entries.length > 0)
                ? dir.entries.map(e => ({ type: 'BundleEntry', name: e.name }))
                : [{ type: 'BundleEntry', name: '(directory compressed; names heuristic only)' }];
        }

        if (this.bundleKind === 'UnityWeb' || this.bundleKind === 'UnityRaw') {
            // Old WebPlayer bundles often contain a single file stream; without decompressing blocks,
            // we can only report header and hint at possible contents.
            return [{ type: 'Bundle', name: 'UnityWeb/UnityRaw (contents likely compressed; parsing next phase)' }];
        }

        if (this.bundleKind === 'SerializedFile') {
            const sf = this.serializedProbe;
            return [
                { type: 'SerializedFile', name: `version=${sf.version} dataOffset=${sf.dataOffset} endianLittle=${sf.endianLittle}` }
            ];
        }

        return [{ type: 'Unknown', name: 'Unsupported or unrecognized bundle' }];
    }
}
