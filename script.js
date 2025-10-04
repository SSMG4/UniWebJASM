// Theme toggle
const themeToggle = document.getElementById('theme-toggle');
const docEl = document.documentElement;
let darkMode = localStorage.getItem('theme') === 'dark';

function applyTheme() {
    if (darkMode) {
        docEl.setAttribute('data-theme', 'dark');
        themeToggle.textContent = '☀️';
    } else {
        docEl.setAttribute('data-theme', 'light');
        themeToggle.textContent = '🌙';
    }
}

themeToggle.addEventListener('click', () => {
    darkMode = !darkMode;
    localStorage.setItem('theme', darkMode ? 'dark' : 'light');
    applyTheme();
});

applyTheme();

// File upload handling
unityFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) {
        statusDiv.textContent = 'No file selected.';
        return;
    }
    if (!file.name.endsWith('.unity3d')) {
        statusDiv.textContent = 'Please select a .unity3d file.';
        return;
    }

    // Read the file as ArrayBuffer
    const buffer = await file.arrayBuffer();

    // Parse the buffer and get info
    const info = parseUnity3dBuffer(buffer);

    // Display parsed info in the status area
    statusDiv.textContent =
        `Loaded "${file.name}"\n` +
        `Signature: ${info.signature}\n` +
        `Version: ${info.version}\n` +
        `Size: ${info.fileSize} bytes`;

    // Show a placeholder in the game container
    gameContainer.textContent = 'Asset parsing in prototype stage.';
});
