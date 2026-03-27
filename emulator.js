import { UWPjsParser } from "./parser.js";
import { UWPjsRuntime } from "./runtime.js";
import { UWPjsRenderer } from "./renderer.js";

export class UWPjs {
    constructor(buffer) {
        this.buffer = buffer;
        this.parser = new UWPjsParser(buffer);
        this.runtime = new UWPjsRuntime();
        this.renderer = new UWPjsRenderer();
    }

    async start() {
        console.log("UWPjs start");
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
