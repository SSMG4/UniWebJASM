import { decodeLZMAAlone } from './lzma-decoder.js';

export class BinReader {
    constructor(buffer, offset = 0) {
        const ab = buffer instanceof ArrayBuffer ? buffer
                 : buffer.buffer
                     ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
                     : buffer;
        this.view   = new DataView(ab);
        this.u8     = new Uint8Array(ab);
        this.offset = offset;
    }

    seek(pos)   { this.offset = pos; }
    skip(n)     { this.offset += n; }
    tell()      { return this.offset; }
    remaining() { return this.u8.length - this.offset; }

    u8s()       { return this.u8[this.offset++]; }

    u16be()  { const v = this.view.getUint16(this.offset, false); this.offset += 2; return v; }
    u16le()  { const v = this.view.getUint16(this.offset, true);  this.offset += 2; return v; }

    u32be()  { const v = this.view.getUint32(this.offset, false); this.offset += 4; return v; }
    u32le()  { const v = this.view.getUint32(this.offset, true);  this.offset += 4; return v; }

    i32be()  { const v = this.view.getInt32(this.offset, false);  this.offset += 4; return v; }
    i32le()  { const v = this.view.getInt32(this.offset, true);   this.offset += 4; return v; }

    i64be()  {
        const hi = this.view.getUint32(this.offset, false);
        const lo = this.view.getUint32(this.offset + 4, false);
        this.offset += 8;
        return hi * 4294967296 + lo;
    }

    u8arr(len)  {
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

const COMP_NONE  = 0;
const COMP_LZMA  = 1;
const COMP_LZ4   = 2;
const COMP_LZ4HC = 3;

function lz4BlockDecompress(src, uncompressedSize) {
    const dst  = new Uint8Array(uncompressedSize);
    let sPos   = 0;
    let dPos   = 0;
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

        const offset = src[sPos] | (src[sPos + 1] << 8); sPos += 2;
        if (offset === 0) throw new Error('LZ4: invalid offset 0');

        let matchLen = (token & 0xF) + 4;
        if ((token & 0xF) === 15) {
            let extra;
            do { extra = src[sPos++]; matchLen += extra; } while (extra === 255 && sPos < sLen);
        }

        let mPos = dPos - offset;
        if (mPos < 0) throw new Error(`LZ4: match out of bounds (offset=${offset}, dPos=${dPos})`);
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
    if (compType === COMP_LZ4 || compType === COMP_LZ4HC) return lz4BlockDecompress(data, uncompressedSize);
    if (compType === COMP_LZMA) return decodeLZMAAlone(data);
    throw new Error(`Unknown compression type: ${compType}`);
}

function parseBlockInfoSection(data) {
    const r = new BinReader(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
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
        const offset     = r.i64be();
        const size       = r.i64be();
        const entryFlags = r.u32be();
        const name       = r.zstr();
        dirs.push({ offset, size, flags: entryFlags, name });
    }
    return { blocks, dirs };
}

function parseUnityFSHeader(r) {
    const signature          = r.zstr();
    const version            = r.u32be();
    const unityVersion       = r.zstr();
    const unityRevision      = r.zstr();
    const size               = r.i64be();
    const compressedBlocksInfoSize   = r.u32be();
    const uncompressedBlocksInfoSize = r.u32be();
    const flags              = r.u32be();
    return { signature, version, unityVersion, unityRevision, size, compressedBlocksInfoSize, uncompressedBlocksInfoSize, flags };
}

function readUnityFSBundle(u8) {
    const r   = new BinReader(u8);
    const hdr = parseUnityFSHeader(r);
    const headerEnd = r.tell();

    const compType       = hdr.flags & 0x3F;
    const blockInfoAtEnd = !!(hdr.flags & 0x40);

    const blockInfoStart = blockInfoAtEnd ? hdr.size - hdr.compressedBlocksInfoSize : headerEnd;
    const dataStart      = blockInfoAtEnd ? headerEnd : headerEnd + hdr.compressedBlocksInfoSize;

    const rawBlockInfo = u8.subarray(blockInfoStart, blockInfoStart + hdr.compressedBlocksInfoSize);

    let blockInfoData;
    if (compType === COMP_NONE) {
        blockInfoData = rawBlockInfo;
    } else if (compType === COMP_LZ4 || compType === COMP_LZ4HC) {
        blockInfoData = lz4BlockDecompress(rawBlockInfo, hdr.uncompressedBlocksInfoSize);
    } else if (compType === COMP_LZMA) {
        blockInfoData = decodeLZMAAlone(rawBlockInfo);
    } else {
        throw new Error(`Unknown block info compression type: ${compType}`);
    }

    const { blocks, dirs } = parseBlockInfoSection(blockInfoData);

    const totalUncompressed = blocks.reduce((s, b) => s + b.uncompressedSize, 0);
    const dataOut = new Uint8Array(totalUncompressed);
    let writePos  = 0;
    let readPos   = dataStart;

    for (const block of blocks) {
        const bCompType = block.flags & 0x3F;
        const compData  = u8.subarray(readPos, readPos + block.compressedSize);
        readPos += block.compressedSize;
        const decompData = decompressBlock(compData, bCompType, block.uncompressedSize);
        dataOut.set(decompData, writePos);
        writePos += decompData.length;
    }

    const files = dirs.map(d => ({
        name:   d.name,
        flags:  d.flags,
        data:   dataOut.subarray(d.offset, d.offset + d.size),
        buffer: dataOut.slice(d.offset, d.offset + d.size).buffer,
    }));

    return {
        ok: true,
        bundleKind: 'UnityFS',
        header: hdr,
        headerStr: `UnityFS v${hdr.version} • ${hdr.unityVersion} (${hdr.unityRevision}) blocks=${blocks.length} files=${files.length}`,
        blocks,
        dirs,
        files,
    };
}

function readUnityWebRawBundle(u8) {
    const r            = new BinReader(u8);
    const signature    = r.zstr();
    const fileVersion  = r.u32be();
    const unityVersion = r.zstr();
    const buildTarget  = r.zstr();

    let lzmaStart;

    if (fileVersion === 6) {
        r.u32be();
        const headerSize = r.u32be();
        r.u32be();
        r.u32be();
        const levelCount = r.u32be();
        for (let i = 0; i < levelCount; i++) { r.u32be(); r.u32be(); }
        r.u32be();
        r.u32be();
        r.u32be();
        lzmaStart = (headerSize > r.tell()) ? headerSize : r.tell();
    } else {
        r.u32be();
        const headerSize = r.u32be();
        r.u32be();
        r.u32be();
        lzmaStart = (headerSize > 0 && headerSize < u8.length) ? headerSize : r.tell();
    }

    let decompressed;
    try {
        decompressed = decodeLZMAAlone(u8.subarray(lzmaStart));
    } catch (e) {
        return {
            ok: false,
            bundleKind: signature,
            header: { signature, fileVersion, unityVersion, buildTarget },
            headerStr: `${signature} v${fileVersion} • ${unityVersion}`,
            files: [],
            error: `LZMA decode failed: ${e.message}`,
        };
    }

    const dec = decompressed;
    const view = new DataView(dec.buffer, dec.byteOffset, dec.byteLength);

    const fileCount = view.getUint32(0, false);
    const files     = [];
    let   pos       = 4;

    for (let i = 0; i < fileCount && pos < dec.length; i++) {
        let name = '';
        while (pos < dec.length && dec[pos] !== 0) name += String.fromCharCode(dec[pos++]);
        pos++;
        const offset = view.getUint32(pos, false); pos += 4;
        const size   = view.getUint32(pos, false); pos += 4;

        const slice  = dec.subarray(offset, offset + size);
        files.push({
            name,
            flags:  0,
            data:   slice,
            buffer: slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength),
        });
    }

    return {
        ok: true,
        bundleKind: signature,
        header: { signature, fileVersion, unityVersion, buildTarget },
        headerStr: `${signature} v${fileVersion} • ${unityVersion} (${buildTarget}) files=${files.length}`,
        files,
    };
}

function probeSerializedFile(u8) {
    if (u8.length < 20) return null;
    const view         = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const metadataSize = view.getUint32(0, false);
    const fileSize     = view.getUint32(4, false);
    const version      = view.getUint32(8, false);
    const dataOffset   = view.getUint32(12, false);
    const endian       = u8[16];
    const plausible    =
        metadataSize > 0 && metadataSize < fileSize &&
        fileSize <= u8.length + 16 &&
        dataOffset < fileSize &&
        (endian === 0 || endian === 1) &&
        version > 0 && version < 50;
    if (!plausible) return null;
    return { metadataSize, fileSize, version, dataOffset, endianLittle: endian === 0 };
}

export class UWPjsParser {
    constructor(buffer) {
        this.rawBuffer = buffer instanceof ArrayBuffer ? buffer : buffer.buffer;
        this.u8        = new Uint8Array(this.rawBuffer);
        this.result    = null;
    }

    parse() {
        if (this.result) return this.result;
        const sig = new TextDecoder().decode(this.u8.subarray(0, Math.min(16, this.u8.length)));

        try {
            if (sig.startsWith('UnityFS')) {
                this.result = readUnityFSBundle(this.u8);
                return this.result;
            }
            if (sig.startsWith('UnityWeb') || sig.startsWith('UnityRaw')) {
                this.result = readUnityWebRawBundle(this.u8);
                return this.result;
            }
            const sf = probeSerializedFile(this.u8);
            if (sf) {
                this.result = {
                    ok: true,
                    bundleKind: 'SerializedFile',
                    header: sf,
                    headerStr: `SerializedFile v${sf.version} dataOffset=${sf.dataOffset} endianLittle=${sf.endianLittle}`,
                    files: [{ name: 'root.assets', flags: 0, data: this.u8, buffer: this.rawBuffer }],
                };
                return this.result;
            }
            this.result = {
                ok: false,
                bundleKind: 'Unknown',
                headerStr: 'Unknown format',
                files: [],
                error: 'File does not appear to be a Unity bundle or serialized file',
            };
        } catch (err) {
            this.result = {
                ok: false,
                bundleKind: 'Error',
                headerStr: 'Parse error',
                files: [],
                error: err.message || String(err),
            };
        }
        return this.result;
    }

    parseHeader()  { const r = this.parse(); return r.error ? `${r.headerStr} — ${r.error}` : r.headerStr; }
    parseAssets()  { const r = this.parse(); return (r.files || []).map(f => ({ type: r.bundleKind, name: f.name })); }
    getFiles()     { return (this.parse().files) || []; }
}
