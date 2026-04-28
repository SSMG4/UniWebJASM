export class UWPjsRuntime {
    constructor() {
        this.assemblies     = new Map();
        this.gameObjects    = new Map();
        this.components     = new Map();
        this.sceneRoot      = [];
        this.running        = false;
        this._frameId       = null;
        this._onFrame       = null;
        this._listeners     = {};

        this._monoReady  = false;
        this._pakoReady  = false;
    }

    on(event, fn) {
        if (!this._listeners[event]) this._listeners[event] = [];
        this._listeners[event].push(fn);
        return this;
    }

    _emit(event, data) {
        (this._listeners[event] ?? []).forEach(fn => fn(data));
    }

    async init() {
        this._log('Runtime init — attempting Mono/WASM bootstrap');

        const candidates = [
            'https://cdn.jsdelivr.net/npm/@xamarin/mono-wasm-sdk/index.js',
        ];

        for (const url of candidates) {
            try {
                const res = await fetch(url, { cache: 'force-cache' });
                if (res.ok) {
                    this._monoReady = true;
                    this._log(`Mono candidate fetched from ${url} (full IL2CPP/Mono is not yet wired — C# execution is stubbed)`);
                    break;
                }
            } catch {}
        }

        if (!this._monoReady) {
            this._log('Mono WASM not available — C# MonoBehaviour execution will be simulated');
        }

        this._emit('ready', { monoReady: this._monoReady });
    }

    loadAssemblies(files) {
        for (const f of files) {
            if (!f.name.endsWith('.dll')) continue;
            this.assemblies.set(f.name, f.data ?? new Uint8Array(f.buffer));
            this._log(`Loaded assembly: ${f.name} (${(f.data?.length ?? f.buffer?.byteLength ?? 0)} bytes)`);
        }
        this._emit('assemblies', { count: this.assemblies.size });
    }

    buildSceneGraph(assetFiles) {
        const gameObjects  = [];
        const transforms   = [];
        const meshFilters  = [];
        const meshRenderers= [];
        const cameras      = [];
        const lights       = [];
        const monoBehaviours = [];

        for (const { objects } of assetFiles) {
            if (!objects) continue;
            for (const obj of objects) {
                switch (obj.classID) {
                    case 1:   gameObjects.push(obj);    break;
                    case 4:   transforms.push(obj);     break;
                    case 20:  cameras.push(obj);        break;
                    case 23:  meshRenderers.push(obj);  break;
                    case 33:  meshFilters.push(obj);    break;
                    case 108: lights.push(obj);         break;
                    case 114: monoBehaviours.push(obj); break;
                }
            }
        }

        for (const go of gameObjects) {
            this.gameObjects.set(go.pathID, {
                pathID:     go.pathID,
                name:       go.name || `GameObject#${go.pathID}`,
                isActive:   go.isActive ?? 1,
                layer:      go.layer ?? 0,
                components: [],
                children:   [],
                parent:     null,
            });
        }

        for (const tf of transforms) {
            const go = this.gameObjects.get(tf.pathID);
            if (go) {
                go.localPosition = tf.localPosition ?? { x: 0, y: 0, z: 0 };
                go.localRotation = tf.localRotation ?? { x: 0, y: 0, z: 0, w: 1 };
                go.localScale    = tf.localScale    ?? { x: 1, y: 1, z: 1 };
            }
        }

        const scene = {
            gameObjects:  [...this.gameObjects.values()],
            cameras,
            lights,
            meshFilters,
            meshRenderers,
            monoBehaviours,
            assemblies:   [...this.assemblies.keys()],
        };

        this.sceneRoot = scene.gameObjects.filter(go => !go.parent);
        this._emit('scene', scene);
        this._log(`Scene graph built — ${scene.gameObjects.length} GameObjects, ${cameras.length} cameras, ${lights.length} lights, ${monoBehaviours.length} MonoBehaviours`);
        return scene;
    }

    simulateLifecycle(scene) {
        this._log('Simulating Awake() → OnEnable() → Start() …');

        for (const mb of scene.monoBehaviours) {
            const scriptName = mb.name || '(anonymous MonoBehaviour)';
            this._log(`  [Awake]  ${scriptName}`);
            this._emit('awake', mb);
        }

        for (const mb of scene.monoBehaviours) {
            const scriptName = mb.name || '(anonymous MonoBehaviour)';
            this._log(`  [Start]  ${scriptName}`);
            this._emit('start', mb);
        }

        this._log('Lifecycle simulation complete');
    }

    startLoop(onFrame) {
        if (this.running) return;
        this.running  = true;
        this._onFrame = onFrame;
        this._tick();
    }

    stopLoop() {
        this.running = false;
        if (this._frameId !== null) {
            cancelAnimationFrame(this._frameId);
            this._frameId = null;
        }
    }

    _tick() {
        if (!this.running) return;
        if (this._onFrame) this._onFrame();
        this._emit('update', null);
        this._frameId = requestAnimationFrame(() => this._tick());
    }

    _log(msg) {
        console.log('[UWPjsRuntime]', msg);
        this._emit('log', msg);
    }
}
