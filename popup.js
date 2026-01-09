// Scroll Depth Dimmer - Popup Script

// ============================================================================
// DOM Elements
// ============================================================================

const elements = {
    // Screens
    screensContainer: document.querySelector('.screens-container'),
    mainScreen: document.getElementById('mainScreen'),
    sitesScreen: document.getElementById('sitesScreen'),

    // Main screen elements
    currentDomain: document.getElementById('currentDomain'),
    toggleButton: document.getElementById('toggleButton'),
    fadeSpeed: document.getElementById('fadeSpeed'),
    fadeSpeedLabel: document.getElementById('fadeSpeedLabel'),
    recoveryTime: document.getElementById('recoveryTime'),
    openSitesBtn: document.getElementById('openSitesBtn'),
    siteCount: document.getElementById('siteCount'),

    // Sites screen elements
    backBtn: document.getElementById('backBtn'),
    newSiteInput: document.getElementById('newSiteInput'),
    addSiteBtn: document.getElementById('addSiteBtn'),
    siteList: document.getElementById('siteList'),
    emptyMessage: document.getElementById('emptyMessage'),
    refreshHint: document.getElementById('refreshHint')
};

// ============================================================================
// State
// ============================================================================

let currentDomain = null;
let state = {
    settings: { fadeSpeed: 2, recoveryTimeMinutes: 20 },
    whitelist: {},
    pausedDomains: {}
};

// ============================================================================
// Screen Navigation
// ============================================================================

function showSitesScreen() {
    elements.screensContainer.classList.add('show-sites');
    // Focus on input when opening sites screen
    setTimeout(() => elements.newSiteInput.focus(), 300);
}

function showMainScreen() {
    elements.screensContainer.classList.remove('show-sites');
}

// ============================================================================
// Initialization
// ============================================================================

async function init() {
    // Get current tab info
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (tab && tab.url) {
        const response = await chrome.runtime.sendMessage({
            type: 'GET_CURRENT_DOMAIN',
            url: tab.url
        });
        currentDomain = response.domain;
    }

    // Get state from background
    const stateResponse = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    state = stateResponse;

    // Render UI
    renderCurrentSite();
    renderSettings();
    renderSiteCount();
    renderWhitelist();

    // Setup event listeners
    setupEventListeners();
}

// ============================================================================
// Rendering
// ============================================================================

function renderCurrentSite() {
    if (!currentDomain) {
        elements.currentDomain.textContent = '-';
        elements.toggleButton.disabled = true;
        elements.toggleButton.textContent = 'Start Tracking';
        return;
    }

    elements.currentDomain.textContent = currentDomain;

    const isWhitelisted = state.whitelist[currentDomain];
    const isPaused = state.pausedDomains[currentDomain];

    if (!isWhitelisted) {
        // Not in whitelist - show add button
        elements.toggleButton.disabled = false;
        elements.toggleButton.textContent = 'Start Tracking';
        elements.toggleButton.classList.remove('paused');
        elements.toggleButton.classList.add('btn-add-site');
    } else if (isPaused) {
        // In whitelist but paused
        elements.toggleButton.disabled = false;
        elements.toggleButton.textContent = 'Resume';
        elements.toggleButton.classList.add('paused');
        elements.toggleButton.classList.remove('btn-add-site');
    } else {
        // In whitelist and active
        elements.toggleButton.disabled = false;
        elements.toggleButton.textContent = 'Pause';
        elements.toggleButton.classList.remove('paused');
        elements.toggleButton.classList.remove('btn-add-site');
    }

    // Always hide hint by default on render (e.g. when switching back from sites screen)
    elements.refreshHint.classList.add('hidden');
}

function renderSettings() {
    elements.fadeSpeed.value = state.settings.fadeSpeed;
    elements.fadeSpeedLabel.textContent = `Level ${state.settings.fadeSpeed}`;

    // Update label color class
    elements.fadeSpeedLabel.className = 'slider-label';
    elements.fadeSpeedLabel.classList.add(`level-${state.settings.fadeSpeed}`);

    elements.recoveryTime.value = state.settings.recoveryTimeMinutes;
}

function renderSiteCount() {
    const count = Object.keys(state.whitelist).length;
    elements.siteCount.textContent = count;
    elements.siteCount.classList.toggle('empty', count === 0);
}

function renderWhitelist() {
    const domains = Object.keys(state.whitelist).reverse();

    if (domains.length === 0) {
        elements.siteList.innerHTML = '';
        elements.siteList.classList.add('hidden');
        elements.emptyMessage.classList.remove('hidden');
        return;
    }

    elements.siteList.classList.remove('hidden');
    elements.emptyMessage.classList.add('hidden');

    elements.siteList.innerHTML = domains.map(domain => `
    <li>
      <span class="site-name">${escapeHtml(domain)}</span>
      <button class="btn btn-remove" data-domain="${escapeHtml(domain)}">Remove</button>
    </li>
  `).join('');

    // Add click handlers for remove buttons
    elements.siteList.querySelectorAll('.btn-remove').forEach(btn => {
        btn.addEventListener('click', () => handleRemoveSite(btn.dataset.domain));
    });
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ============================================================================
// Event Handlers
// ============================================================================

function setupEventListeners() {
    // Screen navigation
    elements.openSitesBtn.addEventListener('click', showSitesScreen);
    elements.backBtn.addEventListener('click', showMainScreen);

    // Toggle button (add site or pause/resume)
    elements.toggleButton.addEventListener('click', handleToggleButton);

    // Fade speed slider
    elements.fadeSpeed.addEventListener('input', () => {
        const level = elements.fadeSpeed.value;
        elements.fadeSpeedLabel.textContent = `Level ${level}`;

        // Update label color class
        elements.fadeSpeedLabel.className = 'slider-label';
        elements.fadeSpeedLabel.classList.add(`level-${level}`);
    });

    elements.fadeSpeed.addEventListener('change', handleFadeSpeedChange);

    // Recovery time
    elements.recoveryTime.addEventListener('change', handleRecoveryTimeChange);

    // Limit input to 3 digits
    elements.recoveryTime.addEventListener('input', () => {
        if (elements.recoveryTime.value.length > 3) {
            elements.recoveryTime.value = elements.recoveryTime.value.slice(0, 3);
        }
    });

    // Add site
    elements.addSiteBtn.addEventListener('click', handleAddSite);
    elements.newSiteInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleAddSite();
    });

    // Reload link
    const reloadLink = document.getElementById('reloadLink');
    if (reloadLink) {
        reloadLink.addEventListener('click', () => {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                if (tabs[0]) {
                    chrome.tabs.reload(tabs[0].id);
                    window.close(); // Close popup after clicking refresh
                }
            });
        });
    }
}

async function handleToggleButton() {
    if (!currentDomain) return;

    const isWhitelisted = state.whitelist[currentDomain];

    if (!isWhitelisted) {
        // Add site to whitelist
        const response = await chrome.runtime.sendMessage({
            type: 'ADD_WHITELIST',
            url: currentDomain
        });

        if (response.success && response.domain) {
            state.whitelist[response.domain] = true;
            renderCurrentSite();
            renderSiteCount();
            renderWhitelist();

            // Show refresh hint
            elements.refreshHint.classList.remove('hidden');
        }
    } else {
        // Toggle pause/resume
        const response = await chrome.runtime.sendMessage({
            type: 'TOGGLE_PAUSE',
            domain: currentDomain
        });

        if (response.success) {
            state.pausedDomains[currentDomain] = response.paused;
            renderCurrentSite();
        }
    }
}

async function handleFadeSpeedChange() {
    const newValue = parseInt(elements.fadeSpeed.value, 10);

    const response = await chrome.runtime.sendMessage({
        type: 'UPDATE_SETTINGS',
        settings: { fadeSpeed: newValue }
    });

    if (response.success) {
        state.settings.fadeSpeed = newValue;
    }
}

async function handleRecoveryTimeChange() {
    let newValue = parseInt(elements.recoveryTime.value, 10);

    // Clamp value
    if (isNaN(newValue) || newValue < 1) newValue = 1;
    if (newValue > 360) newValue = 360;

    elements.recoveryTime.value = newValue;

    const response = await chrome.runtime.sendMessage({
        type: 'UPDATE_SETTINGS',
        settings: { recoveryTimeMinutes: newValue }
    });

    if (response.success) {
        state.settings.recoveryTimeMinutes = newValue;
    }
}

async function handleAddSite() {
    const input = elements.newSiteInput.value.trim();
    if (!input) return;

    const response = await chrome.runtime.sendMessage({
        type: 'ADD_WHITELIST',
        url: input
    });

    if (response.success && response.domain) {
        state.whitelist[response.domain] = true;
        elements.newSiteInput.value = '';
        renderWhitelist();
        renderSiteCount();
        renderCurrentSite(); // Update if current site was just added
    }
}

async function handleRemoveSite(domain) {
    const response = await chrome.runtime.sendMessage({
        type: 'REMOVE_WHITELIST',
        domain
    });

    if (response.success) {
        delete state.whitelist[domain];
        delete state.pausedDomains[domain];
        renderWhitelist();
        renderSiteCount();
        renderCurrentSite(); // Update if current site was just removed
    }
}

// ============================================================================
// Start
// ============================================================================

init();
