export class UWPjsRenderer {
    constructor(canvasId = "game-canvas") {
        this.canvas = document.getElementById(canvasId);
        if (!this.canvas) {
            this.canvas = document.createElement("canvas");
            this.canvas.id = canvasId;
            this.canvas.width = 960;
            this.canvas.height = 600;
            document.getElementById("game-container").appendChild(this.canvas);
        }
        this.gl = this.canvas.getContext("webgl2");
        console.log("UWPjsRenderer initialized", this.gl);
    }

    drawMesh(mesh) {
        console.log("UWPjsRenderer drawMesh stub:", mesh);
        
    }

    renderFrame() {
        console.log("UWPjsRenderer renderFrame stub");
        this.gl.clearColor(0.1, 0.1, 0.1, 1.0);
        this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    }
}
