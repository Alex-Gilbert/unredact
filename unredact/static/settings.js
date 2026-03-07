// settings.js — API key and preferences management
import { getSetting, setSetting } from './db.js';

export async function getApiKey() {
    return getSetting('anthropic_api_key');
}

export async function setApiKey(key) {
    return setSetting('anthropic_api_key', key);
}

export async function clearApiKey() {
    return setSetting('anthropic_api_key', null);
}

// Show/hide the settings modal
export function showSettingsModal() {
    document.getElementById('settings-modal').hidden = false;
}

export function hideSettingsModal() {
    document.getElementById('settings-modal').hidden = true;
}

// Initialize settings UI — call once from main.js
export async function initSettings() {
    const settingsBtn = document.getElementById('settings-btn');
    const modal = document.getElementById('settings-modal');
    const apiKeyInput = document.getElementById('api-key-input');
    const saveBtn = document.getElementById('api-key-save');
    const clearBtn = document.getElementById('api-key-clear');
    const closeBtn = document.getElementById('settings-close');
    const statusEl = document.getElementById('api-key-status');

    // Load existing key
    const existing = await getApiKey();
    if (existing) {
        apiKeyInput.value = existing;
        statusEl.textContent = 'API key saved';
        statusEl.className = 'api-key-status saved';
    }

    settingsBtn.addEventListener('click', () => {
        modal.hidden = false;
    });

    closeBtn.addEventListener('click', () => {
        modal.hidden = true;
    });

    // Close on backdrop click
    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.hidden = true;
    });

    saveBtn.addEventListener('click', async () => {
        const key = apiKeyInput.value.trim();
        if (!key) {
            statusEl.textContent = 'Please enter an API key';
            statusEl.className = 'api-key-status error';
            return;
        }
        if (!key.startsWith('sk-ant-')) {
            statusEl.textContent = 'Invalid key format (should start with sk-ant-)';
            statusEl.className = 'api-key-status error';
            return;
        }
        await setApiKey(key);
        statusEl.textContent = 'API key saved';
        statusEl.className = 'api-key-status saved';
    });

    clearBtn.addEventListener('click', async () => {
        apiKeyInput.value = '';
        await clearApiKey();
        statusEl.textContent = 'API key cleared';
        statusEl.className = 'api-key-status';
    });
}
