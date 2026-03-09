// settings.js — API key and preferences management
import { getSetting, setSetting, saveUserFont, getUserFonts, deleteUserFont, savePersonDb, getPersonDb, deletePersonDb, saveEmailList, getEmailList, deleteEmailList } from './db.js';

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

function renderUserFonts(fonts, container, onDelete) {
    container.innerHTML = '';
    for (const f of fonts) {
        const div = document.createElement('div');
        div.className = 'user-font-item';

        const nameSpan = document.createElement('span');
        nameSpan.textContent = f.name;

        const removeBtn = document.createElement('button');
        removeBtn.className = 'user-font-remove';
        removeBtn.textContent = '\u00d7';
        removeBtn.title = `Remove ${f.name}`;
        removeBtn.addEventListener('click', () => onDelete(f));

        div.appendChild(nameSpan);
        div.appendChild(removeBtn);
        container.appendChild(div);
    }
}

/**
 * Initialize settings UI — call once from main.js.
 * @param {{ onFontAdded?: (font: {id: string, name: string}) => void, onFontRemoved?: (fontId: string) => void, onDefaultFontsToggled?: (disabled: boolean) => void }} [callbacks]
 */
export async function initSettings(callbacks) {
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

    // Font upload
    const fontUploadBtn = document.getElementById('font-upload-btn');
    const fontUploadInput = document.getElementById('font-upload-input');
    const userFontList = document.getElementById('user-font-list');

    // Default fonts toggle
    const defaultFontsCheckbox = document.getElementById('disable-default-fonts');

    function updateToggleState(userFontCount) {
        defaultFontsCheckbox.disabled = userFontCount === 0;
        if (userFontCount === 0 && defaultFontsCheckbox.checked) {
            defaultFontsCheckbox.checked = false;
            setSetting('defaultFontsDisabled', false);
            if (callbacks?.onDefaultFontsToggled) callbacks.onDefaultFontsToggled(false);
        }
    }

    // Load saved toggle state
    const savedDisabled = await getSetting('defaultFontsDisabled');
    const existingFonts = await getUserFonts();
    if (savedDisabled && existingFonts.length > 0) {
        defaultFontsCheckbox.checked = true;
    }
    updateToggleState(existingFonts.length);

    defaultFontsCheckbox.addEventListener('change', async () => {
        const disabled = defaultFontsCheckbox.checked;
        await setSetting('defaultFontsDisabled', disabled);
        if (callbacks?.onDefaultFontsToggled) callbacks.onDefaultFontsToggled(disabled);
    });

    async function handleDelete(f) {
        await deleteUserFont(f.fontId);
        for (const face of document.fonts) {
            if (face.family === f.name) { document.fonts.delete(face); break; }
        }
        const fonts = await getUserFonts();
        renderUserFonts(fonts, userFontList, handleDelete);
        updateToggleState(fonts.length);
        if (callbacks?.onFontRemoved) callbacks.onFontRemoved(f.fontId);
    }

    // Render existing user fonts
    renderUserFonts(existingFonts, userFontList, handleDelete);

    fontUploadBtn.addEventListener('click', () => fontUploadInput.click());
    fontUploadInput.addEventListener('change', async () => {
        const file = fontUploadInput.files[0];
        if (!file) return;
        const name = file.name.replace(/\.(ttf|otf|woff2?)$/i, '');
        const fontId = 'user-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const blob = new Blob([await file.arrayBuffer()], { type: file.type });
        await saveUserFont(fontId, name, blob);

        // Register font immediately
        const face = new FontFace(name, await blob.arrayBuffer());
        const loaded = await face.load();
        document.fonts.add(loaded);

        // Update list
        const fonts = await getUserFonts();
        renderUserFonts(fonts, userFontList, handleDelete);
        updateToggleState(fonts.length);
        fontUploadInput.value = '';

        if (callbacks?.onFontAdded) callbacks.onFontAdded({ id: fontId, name });
    });

    // Person database upload
    const personDbInput = document.getElementById('person-db-input');
    const personDbUpload = document.getElementById('person-db-upload');
    const personDbClear = document.getElementById('person-db-clear');
    const personDbStatus = document.getElementById('person-db-status');

    // Check for existing person DB
    const existingPersonDb = await getPersonDb();
    if (existingPersonDb?.names) {
        const count = Object.keys(existingPersonDb.persons || {}).length;
        personDbStatus.textContent = `Loaded: ${count} persons`;
        personDbStatus.className = 'api-key-status saved';
        personDbClear.hidden = false;
    }

    personDbUpload.addEventListener('click', () => personDbInput.click());
    personDbInput.addEventListener('change', async () => {
        const file = personDbInput.files[0];
        if (!file) return;
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            if (!data.names || !data.persons) {
                personDbStatus.textContent = 'Invalid schema: must have "names" and "persons" keys';
                personDbStatus.className = 'api-key-status error';
                return;
            }
            await savePersonDb(data);
            const count = Object.keys(data.persons).length;
            personDbStatus.textContent = `Loaded: ${count} persons`;
            personDbStatus.className = 'api-key-status saved';
            personDbClear.hidden = false;
            personDbInput.value = '';
            if (callbacks?.onPersonDbChanged) callbacks.onPersonDbChanged(data);
        } catch (e) {
            personDbStatus.textContent = 'Error: ' + e.message;
            personDbStatus.className = 'api-key-status error';
        }
    });

    personDbClear.addEventListener('click', async () => {
        await deletePersonDb();
        personDbStatus.textContent = 'Person database removed';
        personDbStatus.className = 'api-key-status';
        personDbClear.hidden = true;
        if (callbacks?.onPersonDbChanged) callbacks.onPersonDbChanged(null);
    });

    // Email dictionary upload
    const emailInput = document.getElementById('email-list-input');
    const emailUpload = document.getElementById('email-list-upload');
    const emailClear = document.getElementById('email-list-clear');
    const emailStatus = document.getElementById('email-list-status');

    const existingEmails = await getEmailList();
    if (existingEmails?.length) {
        emailStatus.textContent = `Loaded: ${existingEmails.length} emails`;
        emailStatus.className = 'api-key-status saved';
        emailClear.hidden = false;
    }

    emailUpload.addEventListener('click', () => emailInput.click());
    emailInput.addEventListener('change', async () => {
        const file = emailInput.files[0];
        if (!file) return;
        try {
            const text = await file.text();
            const emails = text.split('\n').map(l => l.trim()).filter(l => l && l.includes('@'));
            if (emails.length === 0) {
                emailStatus.textContent = 'No valid email addresses found in file';
                emailStatus.className = 'api-key-status error';
                return;
            }
            await saveEmailList(emails);
            emailStatus.textContent = `Loaded: ${emails.length} emails`;
            emailStatus.className = 'api-key-status saved';
            emailClear.hidden = false;
            emailInput.value = '';
        } catch (e) {
            emailStatus.textContent = 'Error: ' + e.message;
            emailStatus.className = 'api-key-status error';
        }
    });

    emailClear.addEventListener('click', async () => {
        await deleteEmailList();
        emailStatus.textContent = 'Email list removed';
        emailStatus.className = 'api-key-status';
        emailClear.hidden = true;
    });
}
