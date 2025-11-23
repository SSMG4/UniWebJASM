// runtime.js – Mono WASM runtime skeleton
// Goal: load assemblies and execute entry points

export class UnityRuntime {
    constructor() {
        this.loadedAssemblies = [];
    }

    async init() {
        console.log("UnityRuntime init (stub) – would load mono-wasm here");
    }

    async loadAssembly(blob) {
        console.log("UnityRuntime loadAssembly called", blob);
        this.loadedAssemblies.push(blob);
    }

    async run() {
        console.log("UnityRuntime run (stub) – would execute Main/Awake/Start");
    }
}
