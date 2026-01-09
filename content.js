// Scroll Depth Dimmer - Content Script

// ============================================================================
// Constants
// ============================================================================

const PIXELS_PER_METER = 600;
const SCROLL_THROTTLE_MS = 100;
const PATH_CHECK_INTERVAL_MS = 500; // Check for SPA navigation

// ============================================================================
// Overlay Management
// ============================================================================

let overlayHost = null;
let overlay = null;
let isActive = false;

function createOverlay() {
  if (overlayHost) return;

  // Create host element
  overlayHost = document.createElement('div');
  overlayHost.id = 'scroll-dimmer-host';
  overlayHost.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    z-index: 2147483647;
    pointer-events: none;
  `;

  // Use Shadow DOM to isolate styles
  const shadowRoot = overlayHost.attachShadow({ mode: 'closed' });

  overlay = document.createElement('div');
  overlay.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-color: black;
    opacity: 0;
    transition: opacity 0.3s ease;
  `;

  shadowRoot.appendChild(overlay);

  // Append to document
  if (document.documentElement) {
    document.documentElement.appendChild(overlayHost);
  } else {
    // Wait for document to be ready
    document.addEventListener('DOMContentLoaded', () => {
      document.documentElement.appendChild(overlayHost);
    }, { once: true });
  }
}

function setOverlayOpacity(opacity) {
  if (!overlay) createOverlay();
  if (overlay) {
    overlay.style.opacity = opacity.toString();
  }
}

function removeOverlay() {
  if (overlayHost && overlayHost.parentNode) {
    overlayHost.parentNode.removeChild(overlayHost);
  }
  overlayHost = null;
  overlay = null;
  isActive = false;
}

// ============================================================================
// Scroll Tracking (High Water Mark System)
// ============================================================================

let highWaterMark = 0; // Deepest scroll position (in pixels) on current page
let currentPath = ''; // Current URL path to detect SPA navigation
let pathCheckInterval = null;

function throttle(func, limit) {
  let inThrottle = false;
  return function(...args) {
    if (!inThrottle) {
      func.apply(this, args);
      inThrottle = true;
      setTimeout(() => inThrottle = false, limit);
    }
  };
}

function handleScroll() {
  if (!isActive) return;

  const currentScrollY = window.scrollY;

  // Only count if we've scrolled past the high water mark
  if (currentScrollY > highWaterMark) {
    const deltaPixels = currentScrollY - highWaterMark;
    const deltaMeters = deltaPixels / PIXELS_PER_METER;

    chrome.runtime.sendMessage({
      type: 'SCROLL_UPDATE',
      deltaMeters
    }).catch(() => {
      // Extension might not be ready
    });

    // Update high water mark
    highWaterMark = currentScrollY;
  }
}

const throttledScrollHandler = throttle(handleScroll, SCROLL_THROTTLE_MS);

function resetHighWaterMark() {
  // Set to a very high value temporarily to ignore all scrolls
  highWaterMark = Infinity;

  // After a delay, set to current scroll position
  // This gives the browser time to restore scroll position after navigation
  setTimeout(() => {
    highWaterMark = window.scrollY;
  }, 100);
}

function getCurrentPath() {
  return location.pathname + location.search + location.hash;
}

function checkForPathChange() {
  const newPath = getCurrentPath();
  if (newPath !== currentPath) {
    currentPath = newPath;
    resetHighWaterMark();
  }
}

function startScrollTracking() {
  // Initialize high water mark and path
  highWaterMark = window.scrollY;
  currentPath = getCurrentPath();

  // Listen for scroll events
  window.addEventListener('scroll', throttledScrollHandler, { passive: true });

  // Listen for browser back/forward navigation
  window.addEventListener('popstate', () => {
    currentPath = getCurrentPath();
    resetHighWaterMark();
  });

  // Poll for SPA navigation (history.pushState doesn't fire events)
  pathCheckInterval = setInterval(checkForPathChange, PATH_CHECK_INTERVAL_MS);
}

function stopScrollTracking() {
  window.removeEventListener('scroll', throttledScrollHandler);
  window.removeEventListener('popstate', checkForPathChange);
  if (pathCheckInterval) {
    clearInterval(pathCheckInterval);
    pathCheckInterval = null;
  }
}

// ============================================================================
// Message Handling
// ============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'SET_BRIGHTNESS':
      setOverlayOpacity(message.opacity);
      sendResponse({ success: true });
      break;

    case 'DISABLE_OVERLAY':
      removeOverlay();
      stopScrollTracking();
      sendResponse({ success: true });
      break;

    default:
      sendResponse({ error: 'Unknown message type' });
  }
  return false;
});

// ============================================================================
// Initialization
// ============================================================================

async function init() {
  // Skip non-http pages
  if (!location.protocol.startsWith('http')) {
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_BRIGHTNESS' });

    if (response && response.active) {
      isActive = true;
      createOverlay();
      setOverlayOpacity(response.opacity);
      startScrollTracking();
    }
  } catch (e) {
    // Extension might not be ready
  }
}

// Run initialization
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
