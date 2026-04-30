const VS_WIREFRAME = `#version 300 es
precision highp float;
layout(location=0) in vec3 a_pos;
uniform mat4 u_mvp;
void main() { gl_Position = u_mvp * vec4(a_pos, 1.0); }
`;

const FS_WIREFRAME = `#version 300 es
precision mediump float;
uniform vec4 u_color;
out vec4 fragColor;
void main() { fragColor = u_color; }
`;

const VS_TEXTURE = `#version 300 es
precision highp float;
layout(location=0) in vec3 a_pos;
layout(location=1) in vec2 a_uv;
uniform mat4 u_mvp;
out vec2 v_uv;
void main() { v_uv = a_uv; gl_Position = u_mvp * vec4(a_pos, 1.0); }
`;

const FS_TEXTURE = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_tex;
out vec4 fragColor;
void main() { fragColor = texture(u_tex, v_uv); }
`;

function compileShader(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const err = gl.getShaderInfoLog(s);
        gl.deleteShader(s);
        throw new Error(`Shader compile error: ${err}`);
    }
    return s;
}

function linkProgram(gl, vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        const err = gl.getProgramInfoLog(p);
        gl.deleteProgram(p);
        throw new Error(`Program link error: ${err}`);
    }
    return p;
}

function mat4Mul(a, b) {
    const out = new Float32Array(16);
    for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
            let sum = 0;
            for (let k = 0; k < 4; k++) sum += a[r + k * 4] * b[k + c * 4];
            out[r + c * 4] = sum;
        }
    }
    return out;
}

function mat4Perspective(fovY, aspect, near, far) {
    const f   = 1.0 / Math.tan(fovY * 0.5);
    const nf  = 1.0 / (near - far);
    const out = new Float32Array(16);
    out[0]  = f / aspect;
    out[5]  = f;
    out[10] = (far + near) * nf;
    out[11] = -1;
    out[14] = 2 * far * near * nf;
    return out;
}

function mat4LookAt(eye, center, up) {
    const f = normalize3(sub3(center, eye));
    const s = normalize3(cross3(f, up));
    const u = cross3(s, f);
    const out = new Float32Array(16);
    out[0]=s[0]; out[4]=s[1]; out[8] =s[2];
    out[1]=u[0]; out[5]=u[1]; out[9] =u[2];
    out[2]=-f[0];out[6]=-f[1];out[10]=-f[2];
    out[12]=-(s[0]*eye[0]+s[1]*eye[1]+s[2]*eye[2]);
    out[13]=-(u[0]*eye[0]+u[1]*eye[1]+u[2]*eye[2]);
    out[14]= (f[0]*eye[0]+f[1]*eye[1]+f[2]*eye[2]);
    out[15]=1;
    return out;
}

function mat4Identity() {
    const m = new Float32Array(16);
    m[0]=m[5]=m[10]=m[15]=1;
    return m;
}

function sub3(a,b)   { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function dot3(a,b)   { return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
function cross3(a,b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
function normalize3(v) {
    const l = Math.sqrt(dot3(v,v));
    return l > 0 ? [v[0]/l, v[1]/l, v[2]/l] : [0,0,0];
}

function extractVertexData(meshData) {
    if (!meshData) return null;

    let verts   = null;
    let indices = null;

    const vd = meshData.m_VertexData ?? meshData.VertexData;
    if (vd) {
        const extracted = extractUnityVertexData(vd);
        if (extracted) verts = extracted;
    }

    if (!verts) {
        const maybeVerts = meshData.m_Vertices ?? meshData.vertices;
        if (maybeVerts?.raw instanceof Uint8Array) {
            const raw = maybeVerts.raw;
            verts = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength >> 2);
        }
    }

    const idxRaw = meshData.m_IndexBuffer ?? meshData.m_Indices ?? meshData.indices;
    if (idxRaw?.raw instanceof Uint8Array) {
        const raw = idxRaw.raw;
        indices = raw.byteLength % 4 === 0
            ? new Uint32Array(raw.buffer, raw.byteOffset, raw.byteLength >> 2)
            : new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength >> 1);
    }

    const submeshes = meshData.m_SubMeshes ?? meshData.m_submeshes;
    let indexCount = indices ? indices.length : 0;
    if (Array.isArray(submeshes) && submeshes.length > 0) {
        indexCount = submeshes.reduce((s, sm) => s + (sm.indexCount ?? sm.triangleCount * 3 ?? 0), 0) || indexCount;
    }

    if (!verts || verts.length < 3) return null;
    return { verts, indices, indexCount };
}

function extractUnityVertexData(vd) {
    const vertCount = vd.m_VertexCount ?? vd.VertexCount;
    if (!vertCount || vertCount === 0) return null;

    const dataSrc = vd.m_DataSize ?? vd.DataSize;
    if (!dataSrc?.raw) return null;
    const dataBytes = dataSrc.raw;
    const dataView  = new DataView(dataBytes.buffer, dataBytes.byteOffset, dataBytes.byteLength);

    const channelsSrc = vd.m_Channels ?? vd.Channels;
    const streamsSrc  = vd.m_Streams  ?? vd.Streams;

    if (Array.isArray(channelsSrc) && channelsSrc.length > 0) {
        const ch = channelsSrc[0];
        const stream  = ch.stream  ?? ch.Stream  ?? 0;
        const offset  = ch.offset  ?? ch.Offset  ?? 0;
        const format  = ch.format  ?? ch.Format  ?? 0;
        const dim     = ch.dimension ?? ch.Dimension ?? 3;

        let stride = 12;
        let streamOff = 0;

        if (Array.isArray(streamsSrc) && streamsSrc.length > stream) {
            const st = streamsSrc[stream];
            stride    = st.stride    ?? st.Stride    ?? 12;
            streamOff = st.offset    ?? st.Offset    ?? 0;
        }

        if (format === 0) {
            const out = new Float32Array(vertCount * 3);
            for (let v = 0; v < vertCount; v++) {
                const base = streamOff + v * stride + offset;
                out[v * 3 + 0] = dataView.getFloat32(base + 0,  true);
                out[v * 3 + 1] = dataView.getFloat32(base + 4,  true);
                out[v * 3 + 2] = dataView.getFloat32(base + 8,  true);
            }
            return out;
        }

        if (format === 1) {
            const out = new Float32Array(vertCount * 3);
            for (let v = 0; v < vertCount; v++) {
                const base = streamOff + v * stride + offset;
                out[v * 3 + 0] = dataView.getUint16(base + 0, true) / 65535;
                out[v * 3 + 1] = dataView.getUint16(base + 2, true) / 65535;
                out[v * 3 + 2] = dataView.getUint16(base + 4, true) / 65535;
            }
            return out;
        }
    }

    if (Array.isArray(streamsSrc) && streamsSrc.length > 0) {
        const st     = streamsSrc[0];
        const stride = st.stride ?? st.Stride ?? 12;
        const off    = st.offset ?? st.Offset ?? 0;
        if (stride >= 12) {
            const out = new Float32Array(vertCount * 3);
            for (let v = 0; v < vertCount; v++) {
                const base = off + v * stride;
                out[v * 3 + 0] = dataView.getFloat32(base + 0, true);
                out[v * 3 + 1] = dataView.getFloat32(base + 4, true);
                out[v * 3 + 2] = dataView.getFloat32(base + 8, true);
            }
            return out;
        }
    }

    return null;
}

export class UWPjsRenderer {
    constructor(canvasId = 'game-canvas') {
        this.canvas = document.getElementById(canvasId);
        if (!this.canvas) {
            this.canvas        = document.createElement('canvas');
            this.canvas.id     = canvasId;
            this.canvas.width  = 960;
            this.canvas.height = 480;
            (document.getElementById('game-container') ?? document.body).appendChild(this.canvas);
        }

        this._overlayCanvas        = document.createElement('canvas');
        this._overlayCanvas.width  = this.canvas.width;
        this._overlayCanvas.height = this.canvas.height;
        this._overlayCanvas.style.cssText =
            'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;';

        const wrap = this.canvas.parentElement;
        if (wrap && getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';
        if (wrap) wrap.appendChild(this._overlayCanvas);

        this.gl = this.canvas.getContext('webgl2');
        if (!this.gl) {
            console.warn('[UWPjsRenderer] WebGL2 not available');
            return;
        }

        this._meshes    = [];
        this._textures  = [];
        this._angle     = 0;
        this._sceneInfo = null;

        this._initPrograms();

        this.gl.enable(this.gl.DEPTH_TEST);
        this.gl.depthFunc(this.gl.LEQUAL);
    }

    _initPrograms() {
        const gl = this.gl;
        const vsW = compileShader(gl, gl.VERTEX_SHADER,   VS_WIREFRAME);
        const fsW = compileShader(gl, gl.FRAGMENT_SHADER, FS_WIREFRAME);
        this._progWire = linkProgram(gl, vsW, fsW);

        const vsT = compileShader(gl, gl.VERTEX_SHADER,   VS_TEXTURE);
        const fsT = compileShader(gl, gl.FRAGMENT_SHADER, FS_TEXTURE);
        this._progTex  = linkProgram(gl, vsT, fsT);
    }

    loadMeshes(sfObjects) {
        const gl = this.gl;
        if (!gl) return;

        const meshAssets = sfObjects.filter(o => o.classID === 43 && o.meshData);
        this._meshes = [];

        for (const m of meshAssets) {
            const vd = extractVertexData(m.meshData);
            if (!vd) continue;

            const vao = gl.createVertexArray();
            gl.bindVertexArray(vao);

            const vbo = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
            gl.bufferData(gl.ARRAY_BUFFER, vd.verts, gl.STATIC_DRAW);
            gl.enableVertexAttribArray(0);
            gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

            let ebo = null;
            let drawCount = vd.indexCount || (vd.verts.length / 3);

            if (vd.indices) {
                ebo = gl.createBuffer();
                gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
                gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, vd.indices, gl.STATIC_DRAW);
                drawCount = vd.indices.length;
            }

            gl.bindVertexArray(null);

            this._meshes.push({ vao, ebo, drawCount, name: m.name });
            console.log(`[UWPjsRenderer] Uploaded mesh "${m.name}" — ${vd.verts.length / 3} verts, ${drawCount} indices`);
        }
    }

    loadTexture(imageData, width, height) {
        const gl = this.gl;
        if (!gl) return null;

        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, imageData);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        this._textures.push(tex);
        return tex;
    }

    drawMesh(mesh, mvp, wireColor) {
        const gl   = this.gl;
        if (!gl || !mesh) return;

        gl.useProgram(this._progWire);
        gl.uniformMatrix4fv(gl.getUniformLocation(this._progWire, 'u_mvp'), false, mvp);
        gl.uniform4fv(gl.getUniformLocation(this._progWire, 'u_color'), wireColor ?? [0.4, 0.9, 0.4, 1.0]);

        gl.bindVertexArray(mesh.vao);
        if (mesh.ebo) {
            gl.drawElements(gl.TRIANGLES, mesh.drawCount, gl.UNSIGNED_SHORT, 0);
        } else {
            gl.drawArrays(gl.TRIANGLES, 0, mesh.drawCount);
        }
        gl.bindVertexArray(null);
    }

    renderFrame() {
        const gl = this.gl;
        if (!gl) return;

        const W = this.canvas.width, H = this.canvas.height;
        gl.viewport(0, 0, W, H);
        gl.clearColor(0.08, 0.08, 0.12, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        if (!this._meshes.length) {
            gl.clearColor(0.05, 0.05, 0.08, 1.0);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            this._drawInfoOverlay();
            return;
        }

        this._angle += 0.005;

        const proj = mat4Perspective(Math.PI / 4, W / H, 0.1, 1000);
        const view = mat4LookAt(
            [Math.sin(this._angle) * 5, 2, Math.cos(this._angle) * 5],
            [0, 0, 0],
            [0, 1, 0]
        );
        const vp = mat4Mul(proj, view);
        const model = mat4Identity();
        const mvp   = mat4Mul(vp, model);

        for (const mesh of this._meshes) {
            this.drawMesh(mesh, mvp);
        }
    }

    setSceneInfo(info) {
        this._sceneInfo = info;
    }

    _drawInfoOverlay() {
        const canvas = this._overlayCanvas;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const W = canvas.width, H = canvas.height;
        ctx.clearRect(0, 0, W, H);

        ctx.fillStyle = '#0d0d14';
        ctx.fillRect(0, 0, W, H);

        const cx = W / 2, cy = H / 2;

        ctx.strokeStyle = '#1e2a3a';
        ctx.lineWidth   = 1;
        const step = 40;
        for (let x = step; x < W; x += step) {
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
        }
        for (let y = step; y < H; y += step) {
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
        }

        ctx.strokeStyle = '#2a3f5a';
        ctx.lineWidth   = 1.5;
        ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, H); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(W, cy); ctx.stroke();

        const info = this._sceneInfo;

        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle    = '#3a6090';
        ctx.font         = 'bold 13px monospace';
        ctx.fillText('NO MESH ASSETS', cx, cy - 58);

        ctx.fillStyle    = '#8ab4d4';
        ctx.font         = '12px monospace';
        ctx.fillText('Geometry is generated at runtime via C# — not stored in the bundle.', cx, cy - 36);
        ctx.fillText('Actual rendering requires C# / Mono execution (not yet implemented).', cx, cy - 18);

        if (info) {
            ctx.fillStyle = '#4a7fa8';
            ctx.font      = '11px monospace';
            ctx.fillText(`Scene: ${info.gameObjects ?? 0} GameObjects  •  ${info.cameras ?? 0} Cameras  •  ${info.lights ?? 0} Lights  •  ${info.monoBehaviours ?? 0} MonoBehaviours`, cx, cy + 12);
            if (info.assemblies?.length) {
                const asmStr = info.assemblies.slice(0, 4).join('  ') + (info.assemblies.length > 4 ? ' …' : '');
                ctx.fillStyle = '#35607a';
                ctx.fillText(asmStr, cx, cy + 32);
            }
        }

        ctx.fillStyle    = '#2a4060';
        ctx.font         = '10px monospace';
        ctx.fillText('UWP.js  —  Unity Web Player Emulator', cx, H - 16);
    }
}
