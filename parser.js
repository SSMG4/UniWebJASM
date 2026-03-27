class BinReader {
    constructor(buffer, offset = 0) {
        this.view = new DataView(buffer instanceof ArrayBuffer ? buffer : buffer.buffer, buffer instanceof ArrayBuffer ? 0 : buffer.byteOffset, buffer instanceof ArrayBuffer ? buffer.byteLength : buffer.byteLength);
        this.u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
        this.offset = offset;
    }

    seek(pos) { this.offset = pos; }
    skip(n) { this.offset += n; }
    tell() { return this.offset; }
    remaining() { return this.u8.length - this.offset; }

    u8s() { return this.u8[this.offset++]; }

    u16be() { const v = this.view.getUint16(this.offset, false); this.offset += 2; return v; }
    u16le() { const v = this.view.getUint16(this.offset, true); this.offset += 2; return v; }

    u32be() { const v = this.view.getUint32(this.offset, false); this.offset += 4; return v; }
    u32le() { const v = this.view.getUint32(this.offset, true); this.offset += 4; return v; }

    i32be() { const v = this.view.getInt32(this.offset, false); this.offset += 4; return v; }

    i64be() {
        const hi = this.view.getUint32(this.offset, false);
        const lo = this.view.getUint32(this.offset + 4, false);
        this.offset += 8;
        return hi * 4294967296 + lo;
    }

    u8arr(len) {
        const out = new Uint8Array(len);
        out.set(this.u8.subarray(this.offset, this.offset + len));
        this.offset += len;
        return out;
    }

    u8view(len) {
        const out = this.u8.subarray(this.offset, this.offset + len);
        this.offset += len;
        return out;
    }

    zstr() {
        let s = '';
        while (this.offset < this.u8.length) {
            const c = this.u8[this.offset++];
            if (c === 0) break;
            s += String.fromCharCode(c);
        }
        return s;
    }

    align(n) {
        const rem = this.offset % n;
        if (rem !== 0) this.offset += n - rem;
    }
}

const COMP_NONE   = 0;
const COMP_LZMA   = 1;
const COMP_LZ4    = 2;
const COMP_LZ4HC  = 3;
const COMP_LZHAM  = 4;

function lz4BlockDecompress(src, uncompressedSize) {
    const dst = new Uint8Array(uncompressedSize);
    let sPos = 0;
    let dPos = 0;
    const sLen = src.length;

    while (sPos < sLen) {
        const token = src[sPos++];

        let litLen = (token >>> 4) & 0xF;
        if (litLen === 15) {
            let extra;
            do { extra = src[sPos++]; litLen += extra; } while (extra === 255 && sPos < sLen);
        }

        const litEnd = sPos + litLen;
        while (sPos < litEnd) dst[dPos++] = src[sPos++];

        if (sPos >= sLen) break;

        const offset = src[sPos] | (src[sPos + 1] << 8);
        sPos += 2;

        if (offset === 0) throw new Error('LZ4: invalid offset 0');

        let matchLen = (token & 0xF) + 4;
        if ((token & 0xF) === 15) {
            let extra;
            do { extra = src[sPos++]; matchLen += extra; } while (extra === 255 && sPos < sLen);
        }

        let mPos = dPos - offset;
        if (mPos < 0) throw new Error(`LZ4: match position out of bounds (offset=${offset}, dPos=${dPos})`);
        for (let i = 0; i < matchLen; i++) dst[dPos++] = dst[mPos++];
    }

    return dst;
}

function decompressBlock(data, compType, uncompressedSize) {
    if (compType === COMP_NONE) {
        if (data.length === uncompressedSize) return data;
        const out = new Uint8Array(uncompressedSize);
        out.set(data.subarray(0, Math.min(data.length, uncompressedSize)));
        return out;
    }
    if (compType === COMP_LZ4 || compType === COMP_LZ4HC) {
        return lz4BlockDecompress(data, uncompressedSize);
    }
    if (compType === COMP_LZMA) {
        throw new Error('LZMA decompression not yet implemented (Batch 3)');
    }
    throw new Error(`Unknown compression type: ${compType}`);
}

function parseBlockInfoSection(data) {
    const r = new BinReader(data);
    r.skip(16);

    const blockCount = r.u32be();
    const blocks = [];
    for (let i = 0; i < blockCount; i++) {
        const uncompressedSize = r.u32be();
        const compressedSize   = r.u32be();
        const flags            = r.u16be();
        blocks.push({ uncompressedSize, compressedSize, flags });
    }

    const dirCount = r.u32be();
    const dirs = [];
    for (let i = 0; i < dirCount; i++) {
        const offset    = r.i64be();
        const size      = r.i64be();
        const entryFlags = r.u32be();
        const name      = r.zstr();
        dirs.push({ offset, size, flags: entryFlags, name });
    }

    return { blocks, dirs };
}

function parseUnityFSHeader(r) {
    const signature   = r.zstr();
    const version     = r.u32be();
    const unityVersion  = r.zstr();
    const unityRevision = r.zstr();
    const size        = r.i64be();
    const compressedBlocksInfoSize   = r.u32be();
    const uncompressedBlocksInfoSize = r.u32be();
    const flags       = r.u32be();
    return { signature, version, unityVersion, unityRevision, size, compressedBlocksInfoSize, uncompressedBlocksInfoSize, flags };
}

function parseUnityWebRawHeader(r) {
    const signature    = r.zstr();
    const fileVersion  = r.u32be();
    const unityVersion = r.zstr();
    const buildTarget  = r.zstr();
    const dataOffset   = r.u32be();
    const totalSize    = r.u32be();
    return { signature, fileVersion, unityVersion, buildTarget, dataOffset, totalSize };
}

function readUnityFSBundle(buffer) {
    const r = new BinReader(buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer);
    const hdr = parseUnityFSHeader(r);
    const headerEnd = r.tell();

    const compType = hdr.flags & 0x3F;
    const blockInfoAtEnd = !!(hdr.flags & 0x40);

    let blockInfoStart;
    let dataStart;

    if (blockInfoAtEnd) {
        blockInfoStart = hdr.size - hdr.compressedBlocksInfoSize;
        dataStart = headerEnd;
    } else {
        blockInfoStart = headerEnd;
        dataStart = headerEnd + hdr.compressedBlocksInfoSize;
    }

    const u8all = r.u8;

    const rawBlockInfo = u8all.subarray(blockInfoStart, blockInfoStart + hdr.compressedBlocksInfoSize);

    let blockInfoData;
    if (compType === COMP_NONE) {
        blockInfoData = rawBlockInfo;
    } else if (compType === COMP_LZ4 || compType === COMP_LZ4HC) {
        blockInfoData = lz4BlockDecompress(rawBlockInfo, hdr.uncompressedBlocksInfoSize);
    } else if (compType === COMP_LZMA) {
        throw new Error('LZMA-compressed block info not yet supported');
    } else {
        throw new Error(`Unknown block info compression type: ${compType}`);
    }

    const { blocks, dirs } = parseBlockInfoSection(blockInfoData);

    const totalUncompressed = blocks.reduce((s, b) => s + b.uncompressedSize, 0);
    const dataOut = new Uint8Array(totalUncompressed);
    let writePos = 0;
    let readPos = dataStart;

    for (const block of blocks) {
        const bCompType = block.flags & 0x3F;
        const compData = u8all.subarray(readPos, readPos + block.compressedSize);
        readPos += block.compressedSize;
        const decompData = decompressBlock(compData, bCompType, block.uncompressedSize);
        dataOut.set(decompData, writePos);
        writePos += decompData.length;
    }

    const files = dirs.map(d => ({
        name: d.name,
        flags: d.flags,
        buffer: dataOut.slice(d.offset, d.offset + d.size).buffer
    }));

    return {
        ok: true,
        bundleKind: 'UnityFS',
        header: hdr,
        headerStr: `UnityFS v${hdr.version} • ${hdr.unityVersion} (${hdr.unityRevision}) blocks=${blocks.length} files=${files.length}`,
        blocks,
        dirs,
        files
    };
}

function readUnityWebBundle(buffer) {
    const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const r = new BinReader(u8);
    const hdr = parseUnityWebRawHeader(r);
    return {
        ok: false,
        bundleKind: hdr.signature,
        header: hdr,
        headerStr: `${hdr.signature} v${hdr.fileVersion} • ${hdr.unityVersion} — LZMA decompression required (Batch 3)`,
        files: [],
        error: 'UnityWeb/UnityRaw LZMA support coming in Batch 3'
    };
}

function probeSerializedFile(u8) {
    if (u8.length < 20) return null;
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const metadataSize = view.getUint32(0, false);
    const fileSize     = view.getUint32(4, false);
    const version      = view.getUint32(8, false);
    const dataOffset   = view.getUint32(12, false);
    const endian       = u8[16];

    const plausible =
        metadataSize > 0 && metadataSize < fileSize &&
        fileSize <= u8.length + 16 &&
        dataOffset < fileSize &&
        (endian === 0 || endian === 1) &&
        version > 0 && version < 50;

    if (!plausible) return null;
    return { metadataSize, fileSize, version, dataOffset, endianLittle: endian === 1 };
}

export class UWPjsParser {
    constructor(buffer) {
        this.rawBuffer = buffer instanceof ArrayBuffer ? buffer : buffer.buffer;
        this.u8 = new Uint8Array(this.rawBuffer);
        this.result = null;
    }

    parse() {
        if (this.result) return this.result;

        const head64 = new TextDecoder().decode(this.u8.subarray(0, Math.min(64, this.u8.length)));

        try {
            if (head64.startsWith('UnityFS')) {
                this.result = readUnityFSBundle(this.u8);
                return this.result;
            }

            if (head64.startsWith('UnityWeb') || head64.startsWith('UnityRaw')) {
                this.result = readUnityWebBundle(this.u8);
                return this.result;
            }

            const sf = probeSerializedFile(this.u8);
            if (sf) {
                this.result = {
                    ok: true,
                    bundleKind: 'SerializedFile',
                    header: sf,
                    headerStr: `SerializedFile v${sf.version} dataOffset=${sf.dataOffset} endianLittle=${sf.endianLittle}`,
                    files: [{ name: 'root.assets', flags: 0, buffer: this.rawBuffer }]
                };
                return this.result;
            }

            this.result = {
                ok: false,
                bundleKind: 'Unknown',
                headerStr: 'Unknown format',
                files: [],
                error: 'File does not appear to be a Unity bundle or serialized file'
            };
            return this.result;

        } catch (err) {
            this.result = {
                ok: false,
                bundleKind: 'Error',
                headerStr: 'Parse error',
                files: [],
                error: err.message || String(err)
            };
            return this.result;
        }
    }

    parseHeader() {
        const r = this.parse();
        return r.error ? `${r.headerStr} — ${r.error}` : r.headerStr;
    }

    parseAssets() {
        const r = this.parse();
        if (r.files && r.files.length > 0) {
            return r.files.map(f => ({ type: r.bundleKind, name: f.name }));
        }
        return [{ type: r.bundleKind || 'Unknown', name: r.error || r.headerStr || 'No assets' }];
    }

    getFiles() {
        const r = this.parse();
        return r.files || [];
    }
}
