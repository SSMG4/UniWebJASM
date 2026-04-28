const kNumBitModelTotalBits = 11;
const kBitModelTotal        = 1 << kNumBitModelTotalBits;
const kNumMoveBits          = 5;
const kNumStates            = 12;
const kNumPosSlotBits       = 6;
const kNumAlignBits         = 4;
const kNumLenToPosStates    = 4;
const kMatchMinLen          = 2;
const kStartPosModelIndex   = 4;
const kEndPosModelIndex     = 14;
const kNumFullDistances     = 1 << (kEndPosModelIndex >> 1);
const kLenNumLowBits        = 3;
const kLenNumMidBits        = 3;
const kLenNumHighBits       = 8;
const kLenNumLowSymbols     = 1 << kLenNumLowBits;
const kLenNumMidSymbols     = 1 << kLenNumMidBits;
const kLenNumHighSymbols    = 1 << kLenNumHighBits;

function mkProbs(n) {
    const a = new Int32Array(n);
    a.fill(kBitModelTotal >> 1);
    return a;
}

const LIT_NEXT  = new Uint8Array([0,0,0,0,1,2,3,4,5,6,4,5]);
const MATCH_NEXT = new Uint8Array([7,7,7,7,7,7,7,10,10,10,10,10]);
const REP_NEXT   = new Uint8Array([8,8,8,8,8,8,8,11,11,11,11,11]);

const SPECIAL_DIST_OFFSETS = new Int32Array(kEndPosModelIndex);
(function () {
    let off = 0;
    for (let s = kStartPosModelIndex; s < kEndPosModelIndex; s++) {
        SPECIAL_DIST_OFFSETS[s] = off;
        off += 1 << ((s >> 1) - 1);
    }
})();
const SPECIAL_DIST_TOTAL = SPECIAL_DIST_OFFSETS[kEndPosModelIndex - 1] + (1 << ((kEndPosModelIndex - 1 >> 1) - 1));

class RangeDecoder {
    constructor(src, startPos) {
        this.src   = src;
        this.pos   = startPos + 1;
        this.range = 0xFFFFFFFF;
        this.code  = 0;
        for (let i = 0; i < 4; i++) {
            this.code = ((this.code << 8) | this.src[this.pos++]) >>> 0;
        }
    }

    normalize() {
        if ((this.range >>> 0) < 0x1000000) {
            this.range = ((this.range << 8)) >>> 0;
            this.code  = (((this.code  << 8) | this.src[this.pos++])) >>> 0;
        }
    }

    decodeBit(probs, idx) {
        this.normalize();
        const prob  = probs[idx];
        const bound = (((this.range >>> 0) >>> kNumBitModelTotalBits) * prob) >>> 0;
        if ((this.code >>> 0) < (bound >>> 0)) {
            this.range     = bound;
            probs[idx]     = (prob + ((kBitModelTotal - prob) >>> kNumMoveBits)) | 0;
            return 0;
        } else {
            this.range     = (this.range - bound) >>> 0;
            this.code      = (this.code  - bound) >>> 0;
            probs[idx]     = (prob - (prob >>> kNumMoveBits)) | 0;
            return 1;
        }
    }

    decodeBitTree(probs, offset, numBits) {
        let m = 1;
        for (let i = 0; i < numBits; i++) m = (m << 1) | this.decodeBit(probs, offset + m);
        return m - (1 << numBits);
    }

    decodeRevBitTree(probs, offset, numBits) {
        let m = 1, sym = 0;
        for (let i = 0; i < numBits; i++) {
            const bit = this.decodeBit(probs, offset + m);
            m   = (m << 1) | bit;
            sym |= bit << i;
        }
        return sym;
    }

    decodeDirectBits(numBits) {
        let result = 0;
        for (let i = numBits - 1; i >= 0; i--) {
            this.normalize();
            this.range = (this.range >>> 1) >>> 0;
            const bit  = ((this.code >>> 0) >= (this.range >>> 0)) ? 1 : 0;
            if (bit) this.code = (this.code - this.range) >>> 0;
            result |= bit << i;
        }
        return result >>> 0;
    }
}

function decodeLen(rd, probs, posState, numPosStates) {
    const choiceOff  = 0;
    const choice2Off = 1;
    const lowOff     = 2;
    const midOff     = lowOff  + numPosStates * kLenNumLowSymbols;
    const highOff    = midOff  + numPosStates * kLenNumMidSymbols;
    if (rd.decodeBit(probs, choiceOff) === 0) {
        return kMatchMinLen + rd.decodeBitTree(probs, lowOff + posState * kLenNumLowSymbols, kLenNumLowBits);
    }
    if (rd.decodeBit(probs, choice2Off) === 0) {
        return kMatchMinLen + kLenNumLowSymbols + rd.decodeBitTree(probs, midOff + posState * kLenNumMidSymbols, kLenNumMidBits);
    }
    return kMatchMinLen + kLenNumLowSymbols + kLenNumMidSymbols + rd.decodeBitTree(probs, highOff, kLenNumHighBits);
}

export function decodeLZMAAlone(src) {
    if (!(src instanceof Uint8Array)) src = new Uint8Array(src);
    if (src.length < 13) throw new Error('LZMA header too small');

    const propsByte = src[0];
    if (propsByte >= 9 * 5 * 5) throw new Error('LZMA: invalid properties byte ' + propsByte);
    const pb = Math.trunc(propsByte / (9 * 5));
    const lp = Math.trunc((propsByte % (9 * 5)) / 9);
    const lc = propsByte % 9;
    const posMask = (1 << pb) - 1;

    const dictSize = ((src[1]) | (src[2] << 8) | (src[3] << 16) | (src[4] << 24)) >>> 0;
    const sizeLoU  = ((src[5]) | (src[6] << 8) | (src[7] << 16) | (src[8] << 24)) >>> 0;
    const sizeHiU  = ((src[9]) | (src[10] << 8) | (src[11] << 16) | (src[12] << 24)) >>> 0;
    const unknownSize = (sizeLoU === 0xFFFFFFFF && sizeHiU === 0xFFFFFFFF);
    const uncompressedSize = unknownSize ? -1 : (sizeHiU * 4294967296 + sizeLoU);

    const effectiveDictSize = Math.max(dictSize, 4096);
    const dict   = new Uint8Array(effectiveDictSize);
    const maxOut = unknownSize ? 256 * 1024 * 1024 : uncompressedSize;
    const out    = new Uint8Array(maxOut);

    const numPosStates = 1 << pb;
    const numLitStates = 0x300 << (lc + lp);
    const litPosMask   = (1 << lp) - 1;

    const kLenTotal = 2 + numPosStates * (kLenNumLowSymbols + kLenNumMidSymbols) + kLenNumHighSymbols;

    const pIsMatch    = mkProbs(kNumStates * 16);
    const pIsRep      = mkProbs(kNumStates);
    const pIsRepG0    = mkProbs(kNumStates);
    const pIsRepG1    = mkProbs(kNumStates);
    const pIsRepG2    = mkProbs(kNumStates);
    const pIsRep0Long = mkProbs(kNumStates * 16);
    const pDistSlot   = mkProbs(kNumLenToPosStates * (1 << kNumPosSlotBits));
    const pSpecDist   = mkProbs(SPECIAL_DIST_TOTAL);
    const pAlign      = mkProbs(1 << kNumAlignBits);
    const pLenMatch   = mkProbs(kLenTotal);
    const pLenRep     = mkProbs(kLenTotal);
    const pLit        = mkProbs(numLitStates);

    const rd = new RangeDecoder(src, 13);

    let state  = 0;
    let rep0   = 0, rep1 = 0, rep2 = 0, rep3 = 0;
    let dictPos = 0;
    let outPos  = 0;
    let prevByte = 0;

    function getDictByte(dist) {
        let p = dictPos - dist - 1;
        if (p < 0) p += effectiveDictSize;
        return dict[p];
    }

    function emitByte(b) {
        dict[dictPos] = b;
        dictPos = (dictPos + 1 === effectiveDictSize) ? 0 : dictPos + 1;
        out[outPos++] = b;
        prevByte = b;
    }

    outer: while (outPos < maxOut) {
        const posState = outPos & posMask;

        if (rd.decodeBit(pIsMatch, state * 16 + posState) === 0) {
            const litState = ((outPos & litPosMask) << lc) | (prevByte >> (8 - lc));
            const litOff   = litState * 0x300;

            let sym = 1;
            if (state >= 7) {
                const matchByte = getDictByte(rep0);
                let i = 7;
                while (i >= 0) {
                    const mb  = (matchByte >> i) & 1;
                    const bit = rd.decodeBit(pLit, litOff + (1 + mb) * 256 + sym);
                    sym = (sym << 1) | bit;
                    if (mb !== bit) {
                        i--;
                        while (i >= 0) { sym = (sym << 1) | rd.decodeBit(pLit, litOff + sym); i--; }
                        break;
                    }
                    i--;
                }
            } else {
                sym = 1;
                for (let i = 0; i < 8; i++) sym = (sym << 1) | rd.decodeBit(pLit, litOff + sym);
            }

            state = LIT_NEXT[state];
            emitByte(sym - 256);
            continue;
        }

        let len;

        if (rd.decodeBit(pIsRep, state) === 0) {
            len = decodeLen(rd, pLenMatch, posState, numPosStates);

            const lenState = Math.min(len - kMatchMinLen, kNumLenToPosStates - 1);
            const distSlot = rd.decodeBitTree(pDistSlot, lenState * (1 << kNumPosSlotBits), kNumPosSlotBits);

            let dist;
            if (distSlot < kStartPosModelIndex) {
                dist = distSlot;
            } else if (distSlot < kEndPosModelIndex) {
                const footerBits = (distSlot >> 1) - 1;
                const base = (2 | (distSlot & 1)) << footerBits;
                dist = base + rd.decodeRevBitTree(pSpecDist, SPECIAL_DIST_OFFSETS[distSlot], footerBits);
            } else {
                const footerBits = (distSlot >> 1) - 1;
                const base = (2 | (distSlot & 1)) << footerBits;
                const midBits   = rd.decodeDirectBits(footerBits - kNumAlignBits);
                const alignBits = rd.decodeRevBitTree(pAlign, 0, kNumAlignBits);
                dist = base + (midBits << kNumAlignBits) + alignBits;
            }

            if (dist === 0xFFFFFFFF) break outer;

            rep3 = rep2; rep2 = rep1; rep1 = rep0; rep0 = dist;
            state = MATCH_NEXT[state];

        } else {
            let dist;

            if (rd.decodeBit(pIsRepG0, state) === 0) {
                if (rd.decodeBit(pIsRep0Long, state * 16 + posState) === 0) {
                    state = state < 7 ? 9 : 11;
                    emitByte(getDictByte(rep0));
                    continue;
                }
                dist = rep0;
            } else {
                if (rd.decodeBit(pIsRepG1, state) === 0) {
                    dist = rep1;
                } else {
                    if (rd.decodeBit(pIsRepG2, state) === 0) {
                        dist = rep2; rep2 = rep1;
                    } else {
                        dist = rep3; rep3 = rep2; rep2 = rep1;
                    }
                    rep1 = rep0;
                }
                rep1 = rep0;
                rep0 = dist;
            }

            len   = decodeLen(rd, pLenRep, posState, numPosStates);
            state = REP_NEXT[state];
        }

        if (outPos + len > maxOut) len = maxOut - outPos;
        for (let i = 0; i < len; i++) emitByte(getDictByte(rep0));
    }

    return out.subarray(0, outPos);
}
