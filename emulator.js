import { UWPjsParser }  from './parser.js';
import { UWPjsRuntime } from './runtime.js';
import { UWPjsRenderer } from './renderer.js';
import { parseSerializedFile } from './serializedf.js';

export class UWPjs {
    constructor(buffer, opts = {}) {
        this.buffer   = buffer instanceof ArrayBuffer ? buffer : buffer.buffer;
        this.opts     = opts;
        this.parser   = new UWPjsParser(this.buffer);
        this.runtime  = new UWPjsRuntime();
        this.renderer = new UWPjsRenderer(opts.canvasId ?? 'game-canvas');
        this._logFn   = opts.onLog ?? (msg => console.log('[UWPjs]', msg));
    }

    _log(msg) { this._logFn(msg); }

    async start() {
        this._log('Parsing bundle …');
        const parsed = this.parser.parse();
        if (!parsed.ok) {
            this._log(`Bundle parse failed: ${parsed.error}`);
            return { ok: false, error: parsed.error };
        }

        this._log(`Format: ${parsed.bundleKind} — ${parsed.headerStr}`);

        const files  = parsed.files ?? [];
        const sfList = [];

        for (const f of files) {
            if (f.name.endsWith('.dll') || f.name.endsWith('.mdb')) continue;

            let sf;
            try {
                sf = parseSerializedFile(f.buffer, f.name);
            } catch (e) {
                this._log(`  SerializedFile parse error (${f.name}): ${e.message}`);
                continue;
            }

            if (!sf.ok) {
                this._log(`  ${f.name}: ${sf.error}`);
                continue;
            }

            this._log(`  ${f.name}: SF v${sf.version} / Unity ${sf.unityVersion} — ${sf.objectCount} objects`);
            sfList.push(sf);
        }

        await this.runtime.init();
        this.runtime.loadAssemblies(files);
        const scene = this.runtime.buildSceneGraph(sfList);
        this.runtime.simulateLifecycle(scene);

        const allObjects = sfList.flatMap(sf => sf.objects);
        this.renderer.loadMeshes(allObjects);

        this.runtime.startLoop(() => this.renderer.renderFrame());
        this._log('Game loop started.');

        return { ok: true, scene, sfCount: sfList.length };
    }

    stop() {
        this.runtime.stopLoop();
        this._log('Game loop stopped.');
    }
}
