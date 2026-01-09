// Scroll Depth Dimmer - Background Service Worker

// ============================================================================
// State Management
// ============================================================================

let state = null;

const DEFAULT_STATE = {
    settings: {
        fadeSpeed: 2,
        recoveryTimeMinutes: 20
    },
    whitelist: {},
    pausedDomains: {},
    domainData: {},
    domainTabs: {}
};

async function ensureInitialized() {
    if (state) return state;

    const stored = await chrome.storage.local.get([
        'settings', 'whitelist', 'pausedDomains', 'domainData', 'domainTabs'
    ]);

    state = {
        settings: stored.settings || DEFAULT_STATE.settings,
        whitelist: stored.whitelist || {},
        pausedDomains: stored.pausedDomains || {},
        domainData: stored.domainData || {},
        domainTabs: stored.domainTabs || {}
    };

    // Rebuild domainTabs from actual open tabs (in case of crash/restart)
    await rebuildDomainTabs();

    return state;
}

async function rebuildDomainTabs() {
    const tabs = await chrome.tabs.query({});
    const newDomainTabs = {};

    for (const tab of tabs) {
        if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('about:')) {
            continue;
        }

        const domain = extractDomain(tab.url);
        if (domain && state.whitelist[domain]) {
            if (!newDomainTabs[domain]) {
                newDomainTabs[domain] = [];
            }
            newDomainTabs[domain].push(tab.id);
        }
    }

    state.domainTabs = newDomainTabs;
    await saveState();
}

async function saveState() {
    await chrome.storage.local.set({
        settings: state.settings,
        whitelist: state.whitelist,
        pausedDomains: state.pausedDomains,
        domainData: state.domainData,
        domainTabs: state.domainTabs
    });
}

// ============================================================================
// Domain Extraction
// ============================================================================

function extractDomain(urlString) {
    try {
        const url = new URL(urlString);
        let hostname = url.hostname;

        // Remove leading 'www.' if present
        if (hostname.startsWith('www.')) {
            hostname = hostname.substring(4);
        }

        return hostname;
    } catch (e) {
        return null;
    }
}

// Normalize user input URL to domain
function normalizeUrlToDomain(input) {
    let cleaned = input.trim();

    // Add protocol if missing for URL parsing
    if (!cleaned.startsWith('http://') && !cleaned.startsWith('https://')) {
        cleaned = 'https://' + cleaned;
    }

    return extractDomain(cleaned);
}

// ============================================================================
// Brightness Calculation
// ============================================================================

const PIXELS_PER_METER = 300;

function calculateBrightness(domain) {
    if (!state.domainData[domain]) {
        return { overlayOpacity: 0 };
    }

    const { totalMetersScrolled, lastClosedTimestamp, recoveryStartBrightness } = state.domainData[domain];
    const { fadeSpeed, recoveryTimeMinutes } = state.settings;

    // Calculate dimness from scrolling
    // fadeSpeed 1: 1% per meter, fadeSpeed 2: 2% per meter, fadeSpeed 3: 3% per meter
    const dimPerMeter = fadeSpeed * 0.01;
    let dimness = Math.min(1.0, totalMetersScrolled * dimPerMeter);

    // Apply recovery if all tabs are closed
    if (lastClosedTimestamp !== null) {
        const elapsedMs = Date.now() - lastClosedTimestamp;
        const recoveryTimeMs = recoveryTimeMinutes * 60 * 1000;
        const recoveryProgress = Math.min(1.0, elapsedMs / recoveryTimeMs);

        // Recovery reduces dimness from where it started
        const startDimness = recoveryStartBrightness / 100;
        const recoveredAmount = startDimness * recoveryProgress;
        dimness = Math.max(0, dimness - recoveredAmount);
    }

    return { overlayOpacity: dimness };
}

// Handle returning to a domain after partial recovery
function handleDomainReturn(domain) {
    const data = state.domainData[domain];
    if (!data || data.lastClosedTimestamp === null) return;

    const { recoveryTimeMinutes } = state.settings;
    const elapsedMs = Date.now() - data.lastClosedTimestamp;
    const recoveryTimeMs = recoveryTimeMinutes * 60 * 1000;
    const recoveryProgress = Math.min(1.0, elapsedMs / recoveryTimeMs);

    // Reduce meters scrolled proportionally to recovery
    data.totalMetersScrolled = data.totalMetersScrolled * (1 - recoveryProgress);

    // Clear recovery state
    data.lastClosedTimestamp = null;
    data.recoveryStartBrightness = 0;
}

// ============================================================================
// Tab Lifecycle Tracking
// ============================================================================

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete') return;
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('about:')) return;

    await ensureInitialized();

    const domain = extractDomain(tab.url);
    if (!domain || !state.whitelist[domain]) return;

    // Add tab to domain tracking
    if (!state.domainTabs[domain]) {
        state.domainTabs[domain] = [];
    }

    if (!state.domainTabs[domain].includes(tabId)) {
        state.domainTabs[domain].push(tabId);

        // If domain was recovering, handle return
        if (state.domainData[domain]?.lastClosedTimestamp !== null) {
            handleDomainReturn(domain);
        }

        await saveState();
    }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
    await ensureInitialized();

    // Find which domain this tab belonged to
    for (const [domain, tabIds] of Object.entries(state.domainTabs)) {
        const index = tabIds.indexOf(tabId);
        if (index !== -1) {
            tabIds.splice(index, 1);

            // If no more tabs for this domain, start recovery
            if (tabIds.length === 0 && state.domainData[domain]) {
                const { overlayOpacity } = calculateBrightness(domain);
                state.domainData[domain].lastClosedTimestamp = Date.now();
                state.domainData[domain].recoveryStartBrightness = overlayOpacity * 100;
            }

            await saveState();
            break;
        }
    }
});

// ============================================================================
// Broadcast Brightness to All Tabs of a Domain
// ============================================================================

async function broadcastBrightness(domain) {
    const tabIds = state.domainTabs[domain] || [];
    const isPaused = state.pausedDomains[domain];
    const { overlayOpacity } = calculateBrightness(domain);

    for (const tabId of tabIds) {
        try {
            await chrome.tabs.sendMessage(tabId, {
                type: 'SET_BRIGHTNESS',
                opacity: isPaused ? 0 : overlayOpacity
            });
        } catch (e) {
            // Tab might not have content script ready
        }
    }
}

// Periodic recovery updates
chrome.alarms.create('recovery-tick', { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === 'recovery-tick') {
        await ensureInitialized();

        // Broadcast updated brightness for all recovering domains
        for (const [domain, data] of Object.entries(state.domainData)) {
            if (data.lastClosedTimestamp !== null) {
                // Domain is recovering - if someone comes back, they'll get updated brightness
                // No active tabs to broadcast to
            }
        }
    }
});

// ============================================================================
// Message Handling
// ============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message, sender).then(sendResponse);
    return true; // Keep channel open for async response
});

async function handleMessage(message, sender) {
    await ensureInitialized();

    switch (message.type) {
        case 'SCROLL_UPDATE': {
            const { deltaMeters } = message;
            const tabId = sender.tab?.id;
            const url = sender.tab?.url;

            if (!url || !tabId) return { success: false };

            const domain = extractDomain(url);
            if (!domain || !state.whitelist[domain] || state.pausedDomains[domain]) {
                return { success: false };
            }

            // Initialize domain data if needed
            if (!state.domainData[domain]) {
                state.domainData[domain] = {
                    totalMetersScrolled: 0,
                    lastClosedTimestamp: null,
                    recoveryStartBrightness: 0
                };
            }

            // Update scroll distance
            state.domainData[domain].totalMetersScrolled += deltaMeters;
            await saveState();

            // Broadcast new brightness to all tabs of this domain
            await broadcastBrightness(domain);

            const { overlayOpacity } = calculateBrightness(domain);
            return { success: true, opacity: overlayOpacity };
        }

        case 'GET_BRIGHTNESS': {
            const url = sender.tab?.url;
            const tabId = sender.tab?.id;

            if (!url) return { active: false };

            const domain = extractDomain(url);
            if (!domain || !state.whitelist[domain]) {
                return { active: false };
            }

            // Track this tab
            if (tabId) {
                if (!state.domainTabs[domain]) {
                    state.domainTabs[domain] = [];
                }
                if (!state.domainTabs[domain].includes(tabId)) {
                    state.domainTabs[domain].push(tabId);

                    // Handle return from recovery
                    if (state.domainData[domain]?.lastClosedTimestamp !== null) {
                        handleDomainReturn(domain);
                    }

                    await saveState();
                }
            }

            const isPaused = state.pausedDomains[domain];
            const { overlayOpacity } = calculateBrightness(domain);

            return {
                active: true,
                paused: isPaused,
                opacity: isPaused ? 0 : overlayOpacity
            };
        }

        case 'GET_STATE': {
            return {
                settings: state.settings,
                whitelist: state.whitelist,
                pausedDomains: state.pausedDomains
            };
        }

        case 'UPDATE_SETTINGS': {
            state.settings = { ...state.settings, ...message.settings };
            await saveState();
            return { success: true };
        }

        case 'ADD_WHITELIST': {
            const domain = normalizeUrlToDomain(message.url);
            if (domain) {
                state.whitelist[domain] = true;
                await saveState();
                return { success: true, domain };
            }
            return { success: false };
        }

        case 'REMOVE_WHITELIST': {
            const { domain } = message;
            delete state.whitelist[domain];
            delete state.pausedDomains[domain];
            delete state.domainData[domain];
            delete state.domainTabs[domain];
            await saveState();

            // Tell any open tabs of this domain to remove overlay
            const tabs = await chrome.tabs.query({});
            for (const tab of tabs) {
                if (tab.url && extractDomain(tab.url) === domain) {
                    try {
                        await chrome.tabs.sendMessage(tab.id, { type: 'DISABLE_OVERLAY' });
                    } catch (e) { }
                }
            }

            return { success: true };
        }

        case 'TOGGLE_PAUSE': {
            const { domain } = message;
            state.pausedDomains[domain] = !state.pausedDomains[domain];
            await saveState();

            // Broadcast updated state to tabs
            await broadcastBrightness(domain);

            return { success: true, paused: state.pausedDomains[domain] };
        }

        case 'GET_CURRENT_DOMAIN': {
            const url = message.url;
            if (!url) return { domain: null };
            return { domain: extractDomain(url) };
        }

        default:
            return { error: 'Unknown message type' };
    }
}

// Initialize on install
chrome.runtime.onInstalled.addListener(async () => {
    await ensureInitialized();
});
