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
const unityFileInput = document.getElementById('unity-file');
const statusDiv = document.getElementById('status');
const gameContainer = document.getElementById('game-container');

unityFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) {
        statusDiv.textContent = 'No file selected.';
        return;
    }
    if (!file.name.endsWith('.unity3d')) {
        statusDiv.textContent = 'Please select a .unity3d file.';
        return;
    }
    statusDiv.textContent = `Loaded "${file.name}". (Emulation coming soon)`;
    // Placeholder: Here you’d initiate WASM/JS emulation
    gameContainer.textContent = 'Unity Web Player emulation not implemented yet.';
});
