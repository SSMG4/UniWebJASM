// emulator.js – orchestrator tying parser + runtime + renderer together

import { UnityParser } from "./parser.js";
import { UnityRuntime } from "./runtime.js";
import { UnityRenderer } from "./renderer.js";

export class UniWebJASM {
    constructor(buffer) {
        this.buffer = buffer;
        this.parser = new UnityParser(buffer);
        this.runtime = new UnityRuntime();
        this.renderer = new UnityRenderer();
    }

    async start() {
        console.log("UniWebJASM start");
        const header = this.parser.parseHeader();
        const assets = this.parser.parseAssets();
        await this.runtime.init();
        for (const asset of assets) {
            if (asset.type === "MonoBehaviour") {
                await this.runtime.loadAssembly(asset);
            }
        }
        this.renderer.renderFrame();
        console.log("Emulation cycle complete (stub). Header:", header, "Assets:", assets);
    }
}
