export class UWPjsRuntime {
    constructor() {
        this.loadedAssemblies = [];
    }

    async init() {
        console.log("UWPjsRuntime init (stub) – would load mono-wasm here");
    }

    async loadAssembly(blob) {
        console.log("UWPjsRuntime loadAssembly called", blob);
        this.loadedAssemblies.push(blob);
    }

    async run() {
        console.log("UWPjsRuntime run (stub) – would execute Main/Awake/Start");
    }
}
