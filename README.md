# UWP.js

**UWP.js** is an open source project to revive Unity Web Player games in the browser using modern JS/WASM technology.  
Upload your `.unity3d` files to play them directly — no plugin required.

## Features

- Upload and inspect Unity Web Player games (`.unity3d`)
- AssetBundle decompression (gzip, zlib, LZ4)
- Asset browser: textures, meshes, audio, assemblies
- Light/dark theme toggle
- 100% open source, no server required

## Roadmap

- Full UnityFS block decompression (LZ4HC, LZMA)
- SerializedFile type tree parsing
- Texture2D / Mesh / AudioClip extraction
- WebGL scene rendering
- Scene hierarchy viewer

## Usage

1. Serve the project root with any static file server
2. Open `index.html`
3. Upload a `.unity3d` file

## Development

```bash
node fetch-libs.js
python3 -m http.server 8000
```

---

© UWP.js contributors
