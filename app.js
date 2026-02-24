/**
 * Bulkmass - Frontend Application (Multi-User)
 * Client-side queue, IndexedDB image storage, browser-managed state.
 * Server is a stateless proxy - no SSE, no server jobs.
 */

// ============================================
// INDEXED DB
// ============================================

const DB_NAME = 'bulkmass';
const DB_VERSION = 1;
const STORE_NAME = 'images';

let _dbInstance = null;

function openDB() {
    if (_dbInstance) return Promise.resolve(_dbInstance);
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id' });
            }
        };
        req.onsuccess = () => {
            _dbInstance = req.result;
            _dbInstance.onclose = () => { _dbInstance = null; };
            resolve(_dbInstance);
        };
        req.onerror = () => reject(req.error);
    });
}

async function dbSaveImage(id, blob, prompt) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put({ id, blob, prompt, savedAt: Date.now() });
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
    });
}

async function dbGetImage(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
    });
}

async function dbGetAllImages() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
}

async function dbDeleteImage(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(id);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
    });
}

async function dbClearAll() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).clear();
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
    });
}

// ============================================
// HELPERS
// ============================================

async function base64ToBlob(base64) {
    const dataUrl = base64.startsWith('data:') ? base64 : `data:image/png;base64,${base64}`;
    const res = await fetch(dataUrl);
    return res.blob();
}

function generateId() {
    return `img_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
}

function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ============================================
// STATE
// ============================================

const store = {
    cookie: localStorage.getItem('bulkmass_cookie') || '',
    cookieValid: false,
    email: null,
    stylePrefix: localStorage.getItem('bulkmass_prefix') || '',
    aspectRatio: localStorage.getItem('bulkmass_ratio') || '16:9',
    count: parseInt(localStorage.getItem('bulkmass_count')) || 1,
    jobs: [],
    isRunning: false,
    isPaused: false,
    totalCount: 0,
    completedCount: 0,
    failedCount: 0,
    consecutiveErrors: 0,
    aspectRatio: '16:9',
    stylePrefix: '',

    // Arrays for up to 3 references per category: { image: base64, caption: '' }
    refSubject: [],
    refStyle: [],
    refScene: []
};
// Blob URL cache (not persisted, rebuilt from IndexedDB)
const blobUrls = new Map();

let cookieExpiration = null;
let timerInterval = null;
let editingJobId = null;

// ============================================
// DOM REFS
// ============================================

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const DOM = {};

function cacheDom() {
    DOM.cookieInput = $('#cookie-input');
    DOM.btnValidate = $('#btn-validate');
    DOM.statusBadge = $('#status-badge');
    DOM.statusText = $('#status-text');
    DOM.cookieTimerSection = $('#cookie-timer-section');
    DOM.timerHours = $('#timer-hours');
    DOM.timerMinutes = $('#timer-minutes');
    DOM.timerSeconds = $('#timer-seconds');

    DOM.aspectRatio = $('#aspect-ratio');
    DOM.countInput = $('#count-input');
    DOM.stylePrefix = $('#style-prefix');
    DOM.prefixPreview = $('#prefix-preview');

    DOM.dropZone = $('#drop-zone');
    DOM.fileUpload = $('#file-upload');
    DOM.promptsInput = $('#prompts-input');
    DOM.promptCount = $('#prompt-count');
    DOM.promptsListToggle = $('#prompts-list-toggle');
    DOM.promptsListWrap = $('#prompts-list-wrap');

    DOM.btnStart = $('#btn-start');
    DOM.btnPause = $('#btn-pause');
    DOM.btnStop = $('#btn-stop');
    DOM.sidebarProgress = $('#sidebar-progress');
    DOM.btnRetryErrors = $('#btn-retry-errors');
    DOM.btnClearAll = $('#btn-clear-all');
    DOM.btnDownloadZip = $('#btn-download-zip');

    DOM.mainProgress = $('#main-progress');
    DOM.progressFill = $('#progress-fill');
    DOM.headerDownloadZip = $('#header-download-zip');

    DOM.cardGrid = $('#card-grid');
    DOM.emptyState = $('#empty-state');

    DOM.lightbox = $('#lightbox');
    DOM.lightboxClose = $('#lightbox-close');
    DOM.lightboxImg = $('#lightbox-img');

    DOM.editModal = $('#edit-modal');
    DOM.editPromptInput = $('#edit-prompt-input');
    DOM.modalClose = $('#modal-close');
    DOM.btnCancelEdit = $('#btn-cancel-edit');
    DOM.btnSaveEdit = $('#btn-save-edit');
    DOM.btnSaveRegenerate = $('#btn-save-regenerate');

    DOM.toastContainer = $('#toast-container');

    // Reference Multiple Dropzones
    ['subject', 'style', 'scene'].forEach(cat => {
        DOM[`ref${cat}Dropzone`] = $(`#ref-${cat}-dropzone`);
        DOM[`ref${cat}Upload`] = $(`#ref-${cat}-upload`);
        DOM[`ref${cat}Previews`] = $(`#ref-${cat}-previews`);
        DOM[`ref${cat}Limit`] = $(`#ref-${cat}-limit`);
    });
}

// ============================================
// TOAST
// ============================================

function toast(message, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    DOM.toastContainer.appendChild(el);
    setTimeout(() => el.remove(), 3500);
}

// ============================================
// STATUS & COOKIE
// ============================================

function updateStatus(connected, email) {
    store.cookieValid = connected;
    store.email = email || null;

    if (connected) {
        DOM.statusBadge.classList.add('connected');
        DOM.statusText.textContent = email || 'Connected';
    } else {
        DOM.statusBadge.classList.remove('connected');
        DOM.statusText.textContent = 'Disconnected';
    }

    updateStartButton();
    updateSidebarSteps();
}

function updateStartButton() {
    const hasPrompts = getPromptTexts().length > 0;
    DOM.btnStart.disabled = !store.cookieValid || !hasPrompts || store.isRunning;
}

function updateSidebarSteps() {
    const promptsSection = $('#step-prompts');
    const settingsSection = $('#step-settings');
    if (promptsSection) promptsSection.classList.toggle('disabled', !store.cookieValid);
    if (settingsSection) settingsSection.classList.toggle('disabled', !store.cookieValid);
}

// ============================================
// COOKIE TIMER
// ============================================

function startCookieTimer(expirationMs) {
    if (!expirationMs) return;
    cookieExpiration = expirationMs;
    DOM.cookieTimerSection.style.display = 'block';
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(updateTimer, 1000);
    updateTimer();
}

function updateTimer() {
    if (!cookieExpiration) return;
    const diff = cookieExpiration - Date.now();
    if (diff <= 0) {
        DOM.timerHours.textContent = '0';
        DOM.timerMinutes.textContent = '00';
        DOM.timerSeconds.textContent = '00';
        clearInterval(timerInterval);
        return;
    }
    DOM.timerHours.textContent = Math.floor(diff / 3600000);
    DOM.timerMinutes.textContent = String(Math.floor((diff % 3600000) / 60000)).padStart(2, '0');
    DOM.timerSeconds.textContent = String(Math.floor((diff % 60000) / 1000)).padStart(2, '0');
}

// ============================================
// COOKIE VALIDATION
// ============================================

async function validateCookie() {
    const cookie = DOM.cookieInput.value.trim();
    if (!cookie) { toast('Enter a cookie', 'error'); return; }

    DOM.btnValidate.disabled = true;
    DOM.btnValidate.innerHTML = '<span class="spinner"></span> Checking...';

    try {
        const res = await fetch('/api/validate-cookie', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cookie })
        });

        const data = await res.json();

        if (data.valid) {
            store.cookie = cookie;
            localStorage.setItem('bulkmass_cookie', cookie);
            updateStatus(true, data.email);
            toast('Cookie validated!', 'success');

            // Parse expiration from JSON array
            try {
                const parsed = JSON.parse(cookie.trim());
                if (Array.isArray(parsed)) {
                    const session = parsed.find(c =>
                        c.name?.includes('session') || c.name?.includes('Secure')
                    );
                    if (session?.expirationDate) {
                        startCookieTimer(session.expirationDate * 1000);
                    }
                }
            } catch { }
        } else {
            updateStatus(false);
            toast(data.message || 'Invalid cookie', 'error');
        }
    } catch (error) {
        toast('Connection error: ' + error.message, 'error');
    } finally {
        DOM.btnValidate.disabled = false;
        DOM.btnValidate.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> Validate';
    }
}

// ============================================
// PROMPTS
// ============================================

let _cachedPrompts = null;

function getPromptTexts() {
    if (_cachedPrompts !== null) return _cachedPrompts;
    const text = DOM.promptsInput.value.trim();
    if (!text) return (_cachedPrompts = []);
    _cachedPrompts = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    return _cachedPrompts;
}

function updatePromptCount() {
    _cachedPrompts = null; // invalidate cache on input change
    const prompts = getPromptTexts();
    DOM.promptCount.textContent = `${prompts.length} prompt${prompts.length !== 1 ? 's' : ''}`;
    updateStartButton();
    updatePrefixPreview();
}

function updatePrefixPreview() {
    const prefix = store.stylePrefix.trim();
    const prompts = getPromptTexts();
    if (prefix && prompts.length > 0) {
        DOM.prefixPreview.textContent = `Preview: "${prefix} ${prompts[0]}"`;
        DOM.prefixPreview.style.display = 'block';
    } else {
        DOM.prefixPreview.style.display = 'none';
    }
}

async function handleFileUpload(file) {
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);

    try {
        const res = await fetch('/api/upload-prompts', { method: 'POST', body: formData });
        const data = await res.json();

        if (data.success && data.prompts.length > 0) {
            const current = DOM.promptsInput.value.trim();
            const newText = data.prompts.join('\n');
            DOM.promptsInput.value = current ? current + '\n' + newText : newText;
            updatePromptCount();
            toast(`Imported ${data.count} prompts`, 'success');
        } else {
            toast('No prompts found', 'error');
        }
    } catch (error) {
        toast('Upload failed: ' + error.message, 'error');
    }
}

// ============================================
// REFERENCE IMAGES
// ============================================

const MAX_REFS_PER_CAT = 3;

function bindReferenceEvents() {
    ['subject', 'style', 'scene'].forEach(cat => {
        const dropzone = DOM[`ref${cat}Dropzone`];
        const input = DOM[`ref${cat}Upload`];

        // Drag and Drop Effects
        dropzone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropzone.classList.add('dragover');
        });
        dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
        dropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropzone.classList.remove('dragover');
            handleReferenceUpload(e.dataTransfer.files, cat);
        });

        // Click Upload
        input.addEventListener('change', (e) => handleReferenceUpload(e.target.files, cat));
    });
}

function handleReferenceUpload(fileList, type) {
    if (!fileList || fileList.length === 0) return;

    // Convert to array and filter out non-images
    const files = Array.from(fileList).filter(f => f.type.startsWith('image/'));

    // Capitalize type for store mapping (e.g. 'subject' -> 'refSubject')
    const storeKey = `ref${type.charAt(0).toUpperCase() + type.slice(1)}`;
    let currentRefs = store[storeKey];

    // Calculate how many more we can add
    const availableSlots = MAX_REFS_PER_CAT - currentRefs.length;
    if (availableSlots <= 0) {
        toast(`Max ${MAX_REFS_PER_CAT} images reached for ${type}`, 'error');
        return;
    }

    const filesToAdd = files.slice(0, availableSlots);
    console.log(`[Reference Upload] Added ${filesToAdd.length} files for ${type}`);

    filesToAdd.forEach(file => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const base64 = e.target.result;
            // Push new object with empty caption initially
            store[storeKey].push({ image: base64, caption: '' });
            renderReferencePreviews(type);
        };
        reader.readAsDataURL(file);
    });

    if (files.length > availableSlots) {
        toast(`Only added ${availableSlots} images. Max ${MAX_REFS_PER_CAT} reached.`, 'info');
    }
}

function removeReference(type, index) {
    const storeKey = `ref${type.charAt(0).toUpperCase() + type.slice(1)}`;
    store[storeKey].splice(index, 1);
    renderReferencePreviews(type);
}

function updateReferenceCaption(type, index, value) {
    const storeKey = `ref${type.charAt(0).toUpperCase() + type.slice(1)}`;
    if (store[storeKey][index]) {
        store[storeKey][index].caption = value;
    }
}

function renderReferencePreviews(type) {
    const storeKey = `ref${type.charAt(0).toUpperCase() + type.slice(1)}`;
    const items = store[storeKey];
    const previewContainer = DOM[`ref${type}Previews`];
    const limitLabel = DOM[`ref${type}Limit`];

    console.log(`[Reference Render] Rendering ${items.length} items for ${type}`);

    limitLabel.textContent = `${items.length} / ${MAX_REFS_PER_CAT}`;

    previewContainer.innerHTML = '';

    items.forEach((item, index) => {
        const div = document.createElement('div');
        div.className = 'ref-preview-item';
        div.innerHTML = `
            <div class="ref-preview-thumb-container">
                <img src="${item.image}" alt="${type} reference ${index + 1}">
                <button class="ref-preview-clear" onclick="removeReference('${type}', ${index})">&times;</button>
            </div>
            <input type="text" class="ref-caption-input" placeholder="Custom caption (optional)" value="${item.caption.replace(/"/g, '&quot;')}">
        `;

        // Listen to caption changes
        const input = div.querySelector('.ref-caption-input');
        input.addEventListener('input', (e) => updateReferenceCaption(type, index, e.target.value));

        previewContainer.appendChild(div);
    });

    // Hide dropzone if maxed out
    const dropzone = DOM[`ref${type}Dropzone`];
    if (items.length >= MAX_REFS_PER_CAT) {
        dropzone.style.display = 'none';
    } else {
        dropzone.style.display = 'flex';
        // Reset input so picking same file again works
        DOM[`ref${type}Upload`].value = '';
    }
}

// ============================================
// CLIENT-SIDE QUEUE ENGINE
// ============================================

const BASE_DELAY = 5000;
const MAX_BACKOFF = 32000;

function getBackoffDelay() {
    if (store.consecutiveErrors === 0) return BASE_DELAY;
    return Math.min(BASE_DELAY * Math.pow(2, store.consecutiveErrors), MAX_BACKOFF);
}

function buildJobList() {
    const promptTexts = getPromptTexts();
    const count = parseInt(DOM.countInput.value) || 1;
    const prefix = store.stylePrefix.trim();

    const jobs = [];
    for (const text of promptTexts) {
        const fullPrompt = prefix ? `${prefix} ${text}` : text;
        for (let i = 0; i < count; i++) {
            jobs.push({
                id: generateId(),
                prompt: fullPrompt,
                status: 'pending',
                blobUrl: null,
                error: null
            });
        }
    }
    return jobs;
}

async function startGeneration() {
    const promptTexts = getPromptTexts();
    if (promptTexts.length === 0) { toast('Add prompts first', 'error'); return; }
    if (!store.cookieValid) { toast('Validate cookie first', 'error'); return; }

    store.jobs = buildJobList();
    store.totalCount = store.jobs.length;
    store.completedCount = 0;
    store.failedCount = 0;
    store.consecutiveErrors = 0;
    store.isRunning = true;
    store.isPaused = false;

    DOM.btnStart.disabled = true;
    DOM.btnPause.disabled = false;
    DOM.btnStop.disabled = false;
    DOM.mainProgress.style.display = 'block';
    DOM.progressFill.style.width = '0%';

    renderGrid();
    updateSidebarProgress();
    saveQueueState();
    toast(`Started: ${store.totalCount} images`, 'success');

    processQueue();
}

async function processQueue() {
    if (!store.isRunning || store.isPaused) return;

    const nextJob = store.jobs.find(j => j.status === 'pending');
    if (!nextJob) {
        // All done
        store.isRunning = false;
        resetControls();
        const failed = store.jobs.filter(j => j.status === 'error').length;
        toast(`Done! ${store.completedCount} generated${failed > 0 ? `, ${failed} failed` : ''}`, 'success');
        saveQueueState();
        return;
    }

    // Too many consecutive errors → pause
    if (store.consecutiveErrors >= 5) {
        store.isPaused = true;
        toast('Paused: too many errors. Check cookie or retry.', 'error');
        DOM.btnPause.innerHTML = svgPlay + ' Resume';
        saveQueueState();
        return;
    }

    nextJob.status = 'processing';
    updateCard(nextJob.id);

    const references = [];

    store.refSubject.forEach(ref => references.push({ category: 'SUBJECT', image: ref.image, caption: ref.caption }));
    store.refStyle.forEach(ref => references.push({ category: 'STYLE', image: ref.image, caption: ref.caption }));
    store.refScene.forEach(ref => references.push({ category: 'SCENE', image: ref.image, caption: ref.caption }));

    try {
        const res = await fetch('/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                cookie: store.cookie,
                prompt: nextJob.prompt,
                aspectRatio: store.aspectRatio,
                references
            })
        });

        const data = await res.json();

        if (data.success && data.image) {
            const blob = await base64ToBlob(data.image);
            const blobUrl = URL.createObjectURL(blob);

            nextJob.status = 'completed';
            nextJob.blobUrl = blobUrl;
            blobUrls.set(nextJob.id, blobUrl);

            store.completedCount++;
            store.consecutiveErrors = 0;

            // Persist image to IndexedDB
            await dbSaveImage(nextJob.id, blob, nextJob.prompt);
        } else {
            nextJob.status = 'error';
            nextJob.error = data.error || 'Unknown error';
            store.failedCount++;
            store.consecutiveErrors++;

            // Cookie expired?
            if (res.status === 401 || (data.error && data.error.includes('401'))) {
                store.isPaused = true;
                updateStatus(false);
                toast('Cookie expired. Please paste a new cookie and validate.', 'error');
                DOM.btnPause.innerHTML = svgPlay + ' Resume';
            }
        }
    } catch (err) {
        nextJob.status = 'error';
        nextJob.error = err.message;
        store.failedCount++;
        store.consecutiveErrors++;
    }

    updateCard(nextJob.id);
    updateProgressBar();
    updateSidebarProgress();
    saveQueueState();

    if (!store.isRunning || store.isPaused) return;

    // Rate limit delay with backoff
    const delay = getBackoffDelay();
    if (delay > BASE_DELAY) {
        console.log(`[Queue] Backoff: ${delay}ms (${store.consecutiveErrors} errors)`);
    }
    await sleep(delay);

    // Continue
    processQueue();
}

function pauseGeneration() {
    if (!store.isRunning) return;

    if (store.isPaused) {
        // Resume
        store.isPaused = false;
        store.consecutiveErrors = 0;
        DOM.btnPause.innerHTML = svgPause + ' Pause';
        toast('Resumed', 'info');
        processQueue();
    } else {
        // Pause
        store.isPaused = true;
        DOM.btnPause.innerHTML = svgPlay + ' Resume';
        toast('Paused after current image', 'info');
    }
    saveQueueState();
}

function cancelGeneration() {
    store.isRunning = false;
    store.isPaused = false;

    // Mark remaining pending as cancelled
    store.jobs.forEach(j => {
        if (j.status === 'pending' || j.status === 'processing') {
            j.status = 'pending';
        }
    });

    resetControls();
    renderGrid();
    saveQueueState();
    toast('Stopped', 'info');
}

function retryErrors() {
    let count = 0;
    store.jobs.forEach(j => {
        if (j.status === 'error') {
            j.status = 'pending';
            j.error = null;
            count++;
        }
    });

    if (count === 0) { toast('No errors to retry', 'info'); return; }

    store.failedCount = 0;
    store.consecutiveErrors = 0;
    renderGrid();
    saveQueueState();
    toast(`${count} error${count > 1 ? 's' : ''} reset to pending`, 'info');

    if (!store.isRunning) {
        store.isRunning = true;
        DOM.btnStart.disabled = true;
        DOM.btnPause.disabled = false;
        DOM.btnStop.disabled = false;
        DOM.mainProgress.style.display = 'block';
        processQueue();
    }
}

function resetControls() {
    DOM.btnStart.disabled = !store.cookieValid || getPromptTexts().length === 0;
    DOM.btnPause.disabled = true;
    DOM.btnStop.disabled = true;
    DOM.btnPause.innerHTML = svgPause + ' Pause';
}

// ============================================
// PROGRESS
// ============================================

function updateProgressBar() {
    if (store.totalCount === 0) return;
    const processed = store.completedCount + store.failedCount;
    const percent = Math.round((processed / store.totalCount) * 100);
    DOM.progressFill.style.width = `${percent}%`;
}

function updateSidebarProgress() {
    const processed = store.completedCount + store.failedCount;
    DOM.sidebarProgress.textContent = `${store.completedCount} of ${store.totalCount} completed` +
        (store.failedCount > 0 ? `, ${store.failedCount} failed` : '');
}

// ============================================
// STATE PERSISTENCE
// ============================================

let _saveTimer = null;

function saveQueueState() {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(_doSaveQueueState, 500);
}

function saveQueueStateImmediate() {
    if (_saveTimer) clearTimeout(_saveTimer);
    _doSaveQueueState();
}

function _doSaveQueueState() {
    // Save queue metadata (without blob data) to localStorage
    const meta = store.jobs.map(j => ({
        id: j.id,
        prompt: j.prompt,
        status: j.status,
        error: j.error
    }));

    localStorage.setItem('bulkmass_queue', JSON.stringify({
        jobs: meta,
        isRunning: store.isRunning,
        isPaused: store.isPaused,
        completedCount: store.completedCount,
        failedCount: store.failedCount,
        totalCount: store.totalCount
    }));
}

async function restoreQueueState() {
    try {
        const saved = localStorage.getItem('bulkmass_queue');
        if (!saved) return;

        const data = JSON.parse(saved);
        if (!data.jobs || data.jobs.length === 0) return;

        store.jobs = data.jobs.map(j => ({
            id: j.id,
            prompt: j.prompt,
            status: j.status === 'processing' ? 'pending' : j.status, // Reset any in-progress
            blobUrl: null,
            error: j.error
        }));

        store.completedCount = data.completedCount || 0;
        store.failedCount = data.failedCount || 0;
        store.totalCount = data.totalCount || 0;

        // Restore blob URLs from IndexedDB in parallel
        await Promise.all(
            store.jobs.filter(j => j.status === 'completed').map(async (job) => {
                try {
                    const record = await dbGetImage(job.id);
                    if (record?.blob) {
                        job.blobUrl = URL.createObjectURL(record.blob);
                        blobUrls.set(job.id, job.blobUrl);
                    }
                } catch { }
            })
        );

        renderGrid();
        updateSidebarProgress();

        if (store.totalCount > 0) {
            DOM.mainProgress.style.display = 'block';
            updateProgressBar();
        }
    } catch (e) {
        console.error('[Restore] Error:', e);
    }
}

// ============================================
// CARD GRID RENDERING
// ============================================

function renderGrid() {
    DOM.emptyState.style.display = store.jobs.length === 0 ? 'flex' : 'none';
    DOM.cardGrid.style.display = store.jobs.length === 0 ? 'none' : 'grid';

    // Use DocumentFragment for batch DOM insertion
    DOM.cardGrid.textContent = '';
    const frag = document.createDocumentFragment();
    store.jobs.forEach((job, i) => {
        const tpl = document.createElement('template');
        tpl.innerHTML = buildCard(job, i);
        frag.appendChild(tpl.content);
    });
    DOM.cardGrid.appendChild(frag);
}

function updateCard(jobId) {
    const el = DOM.cardGrid.querySelector(`[data-id="${jobId}"]`);
    if (!el) return;

    const job = store.jobs.find(j => j.id === jobId);
    if (!job) return;

    const i = store.jobs.indexOf(job);
    el.outerHTML = buildCard(job, i);
}

function buildCard(job, index) {
    const statusClass = job.status;
    let imageHtml;

    if (job.status === 'completed' && job.blobUrl) {
        imageHtml = `<img class="card-image" src="${job.blobUrl}" alt="" data-action="preview" data-id="${job.id}">`;
    } else if (job.status === 'processing') {
        imageHtml = `<div class="card-image-placeholder pulse">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4">
                <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
            </svg>
        </div>`;
    } else if (job.status === 'error') {
        imageHtml = `<div class="card-image-placeholder error-placeholder">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5">
                <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
            </svg>
            <div class="error-hint">${escapeHtml(job.error || 'Generation failed')}</div>
        </div>`;
    } else {
        imageHtml = `<div class="card-image-placeholder">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.15">
                <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
            </svg>
        </div>`;
    }

    const statusBadges = {
        pending: '<span class="status-badge status-pending">Pending</span>',
        processing: '<span class="status-badge status-processing">Processing</span>',
        completed: '<span class="status-badge status-completed">Completed</span>',
        error: `<span class="status-badge status-error" title="${escapeHtml(job.error || '')}">Error</span>`
    };

    return `<div class="result-card ${statusClass}" data-id="${job.id}">
        <div class="card-image-wrap">${imageHtml}</div>
        <div class="card-body">
            <div class="card-prompt" title="${escapeHtml(job.prompt)}">${escapeHtml(job.prompt)}</div>
            <div class="card-footer">
                ${statusBadges[job.status] || statusBadges.pending}
                <div class="card-actions">
                    ${job.status === 'error' ? `
                    <button class="card-btn edit" data-action="edit" data-id="${job.id}" title="Edit Prompt">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    </button>
                    <button class="card-btn retry" data-action="regenerate" data-id="${job.id}" title="Regenerate">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                    </button>
                    ` : `
                    <button class="card-btn" data-action="download" data-id="${job.id}" title="Download" ${!job.blobUrl ? 'disabled' : ''}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                    </button>
                    <button class="card-btn" data-action="preview" data-id="${job.id}" title="Preview" ${!job.blobUrl ? 'disabled' : ''}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                    </button>
                    `}
                    <button class="card-btn delete" data-action="delete" data-id="${job.id}" title="Delete">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14H7L5 6"/></svg>
                    </button>
                </div>
            </div>
        </div>
    </div>`;
}

// ============================================
// CARD ACTIONS
// ============================================

function handleCardAction(action, jobId) {
    const job = store.jobs.find(j => j.id === jobId);
    if (!job) return;

    switch (action) {
        case 'download':
            if (job.blobUrl) {
                const a = document.createElement('a');
                a.href = job.blobUrl;
                a.download = `bulkmass_${job.id}.png`;
                a.click();
            }
            break;

        case 'preview':
            if (job.blobUrl) openLightbox(job.blobUrl);
            break;

        case 'edit':
            editingJobId = jobId;
            DOM.editPromptInput.value = job.prompt;
            DOM.editModal.style.display = 'flex';
            DOM.editPromptInput.focus();
            break;

        case 'regenerate':
            regenerateSingleJob(jobId);
            break;

        case 'delete':
            deleteJob(jobId);
            break;
    }
}

async function deleteJob(jobId) {
    const idx = store.jobs.findIndex(j => j.id === jobId);
    if (idx === -1) return;

    // Revoke blob URL
    if (blobUrls.has(jobId)) {
        URL.revokeObjectURL(blobUrls.get(jobId));
        blobUrls.delete(jobId);
    }

    // Remove from IndexedDB
    try { await dbDeleteImage(jobId); } catch { }

    // Remove from state
    if (store.jobs[idx].status === 'completed') store.completedCount--;
    if (store.jobs[idx].status === 'error') store.failedCount--;
    store.totalCount--;
    store.jobs.splice(idx, 1);

    renderGrid();
    updateSidebarProgress();
    updateProgressBar();
    saveQueueState();
}

async function regenerateSingleJob(jobId) {
    const job = store.jobs.find(j => j.id === jobId);
    if (!job) return;

    if (!store.cookieValid) {
        toast('Validate your cookie first', 'error');
        return;
    }

    // Reset job state
    if (job.status === 'error') store.failedCount--;
    job.status = 'processing';
    job.error = null;
    updateCard(job.id);
    saveQueueState();

    const references = [];
    if (store.refSubject) references.push({ category: 'SUBJECT', image: store.refSubject });
    if (store.refStyle) references.push({ category: 'STYLE', image: store.refStyle });
    if (store.refScene) references.push({ category: 'SCENE', image: store.refScene });

    try {
        const res = await fetch('/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                cookie: store.cookie,
                prompt: job.prompt,
                aspectRatio: store.aspectRatio,
                references
            })
        });

        const data = await res.json();

        if (data.success && data.image) {
            const blob = await base64ToBlob(data.image);
            const blobUrl = URL.createObjectURL(blob);

            // Revoke old blob URL if any
            if (blobUrls.has(job.id)) {
                URL.revokeObjectURL(blobUrls.get(job.id));
            }

            job.status = 'completed';
            job.blobUrl = blobUrl;
            blobUrls.set(job.id, blobUrl);
            store.completedCount++;

            await dbSaveImage(job.id, blob, job.prompt);
            toast('Image regenerated!', 'success');
        } else {
            job.status = 'error';
            job.error = data.error || 'Unknown error';
            store.failedCount++;
            toast('Regeneration failed: ' + job.error, 'error');

            if (res.status === 401 || (data.error && data.error.includes('401'))) {
                updateStatus(false);
                toast('Cookie expired. Please re-validate.', 'error');
            }
        }
    } catch (err) {
        job.status = 'error';
        job.error = err.message;
        store.failedCount++;
        toast('Regeneration failed: ' + err.message, 'error');
    }

    updateCard(job.id);
    updateProgressBar();
    updateSidebarProgress();
    saveQueueState();
}

// ============================================
// LIGHTBOX
// ============================================

function openLightbox(url) {
    DOM.lightboxImg.src = url;
    DOM.lightbox.classList.add('open');
}

function closeLightbox() {
    DOM.lightbox.classList.remove('open');
    DOM.lightboxImg.src = '';
}

// ============================================
// ZIP DOWNLOAD (Client-side with JSZip)
// ============================================

async function downloadAllAsZip() {
    const completed = store.jobs.filter(j => j.status === 'completed');
    if (completed.length === 0) {
        toast('No completed images to download', 'error');
        return;
    }

    if (typeof JSZip === 'undefined') {
        toast('JSZip not loaded. Please refresh the page.', 'error');
        return;
    }

    toast('Creating ZIP...', 'info');

    try {
        const zip = new JSZip();

        // Only download images that are on the current dashboard
        const dashboardIds = new Set(completed.map(j => j.id));
        let added = 0;

        for (const job of completed) {
            try {
                const record = await dbGetImage(job.id);
                if (record && record.blob) {
                    added++;
                    zip.file(`${added}.png`, record.blob);
                }
            } catch { }
        }

        if (added === 0) {
            toast('No images found in storage', 'error');
            return;
        }

        const content = await zip.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(content);
        const a = document.createElement('a');
        a.href = url;
        a.download = `bulkmass_${Date.now()}.zip`;
        a.click();
        URL.revokeObjectURL(url);

        toast(`ZIP downloaded (${added} images)`, 'success');
    } catch (error) {
        toast('ZIP failed: ' + error.message, 'error');
    }
}

// ============================================
// CLEAR ALL
// ============================================

async function clearAll() {
    if (store.isRunning) {
        store.isRunning = false;
        store.isPaused = false;
    }

    // Revoke all blob URLs
    for (const [id, url] of blobUrls) {
        URL.revokeObjectURL(url);
    }
    blobUrls.clear();

    // Clear IndexedDB
    try { await dbClearAll(); } catch { }

    // Reset state
    store.jobs = [];
    store.completedCount = 0;
    store.failedCount = 0;
    store.totalCount = 0;
    store.consecutiveErrors = 0;

    // Clear localStorage queue
    localStorage.removeItem('bulkmass_queue');

    // Reset UI
    renderGrid();
    resetControls();
    DOM.mainProgress.style.display = 'none';
    DOM.progressFill.style.width = '0%';
    updateSidebarProgress();

    toast('Everything cleared', 'info');
}

// ============================================
// SVG ICON STRINGS
// ============================================

const svgPause = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
const svgPlay = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>';

// ============================================
// EVENT LISTENERS
// ============================================

function init() {
    cacheDom();

    // Reference Images state init
    store.refSubject = null;
    store.refStyle = null;
    store.refScene = null;

    // Cookie
    DOM.btnValidate.addEventListener('click', validateCookie);
    DOM.cookieInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); validateCookie(); }
    });

    // Prompts
    DOM.promptsInput.addEventListener('input', updatePromptCount);

    // Style prefix
    DOM.stylePrefix.value = store.stylePrefix;
    DOM.stylePrefix.addEventListener('input', () => {
        store.stylePrefix = DOM.stylePrefix.value;
        localStorage.setItem('bulkmass_prefix', store.stylePrefix);
        updatePrefixPreview();
    });

    // Aspect ratio
    DOM.aspectRatio.value = store.aspectRatio;
    DOM.aspectRatio.addEventListener('change', () => {
        store.aspectRatio = DOM.aspectRatio.value;
        localStorage.setItem('bulkmass_ratio', store.aspectRatio);
    });

    // Count
    DOM.countInput.value = store.count;
    DOM.countInput.addEventListener('change', () => {
        store.count = parseInt(DOM.countInput.value) || 1;
        localStorage.setItem('bulkmass_count', store.count);
    });

    // Prompts toggle
    if (DOM.promptsListToggle) {
        DOM.promptsListToggle.addEventListener('click', () => {
            DOM.promptsListToggle.classList.toggle('collapsed');
            DOM.promptsListWrap.classList.toggle('collapsed');
        });
    }

    // File upload
    DOM.dropZone.addEventListener('click', () => DOM.fileUpload.click());
    DOM.fileUpload.addEventListener('change', (e) => {
        if (e.target.files[0]) handleFileUpload(e.target.files[0]);
        e.target.value = '';
    });
    DOM.dropZone.addEventListener('dragover', (e) => { e.preventDefault(); DOM.dropZone.classList.add('dragover'); });
    DOM.dropZone.addEventListener('dragleave', () => DOM.dropZone.classList.remove('dragover'));
    DOM.dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        DOM.dropZone.classList.remove('dragover');
        if (e.dataTransfer.files[0]) handleFileUpload(e.dataTransfer.files[0]);
    });

    // References file uploads
    DOM.refSubjectUpload.addEventListener('change', (e) => handleReferenceUpload(e.target.files, 'Subject'));
    DOM.refStyleUpload.addEventListener('change', (e) => handleReferenceUpload(e.target.files, 'Style'));
    DOM.refSceneUpload.addEventListener('change', (e) => handleReferenceUpload(e.target.files, 'Scene'));

    document.addEventListener('click', (e) => {
        if (e.target.classList.contains('ref-preview-clear')) {
            clearReference(e.target.dataset.type);
        }
    });

    // Generation controls
    DOM.btnStart.addEventListener('click', startGeneration);
    DOM.btnPause.addEventListener('click', pauseGeneration);
    DOM.btnStop.addEventListener('click', cancelGeneration);

    // Sidebar actions
    DOM.btnRetryErrors.addEventListener('click', retryErrors);
    DOM.btnClearAll.addEventListener('click', clearAll);
    DOM.btnDownloadZip.addEventListener('click', downloadAllAsZip);
    if (DOM.headerDownloadZip) DOM.headerDownloadZip.addEventListener('click', downloadAllAsZip);

    // Card grid actions (event delegation)
    DOM.cardGrid.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const action = btn.dataset.action;
        const jobId = btn.dataset.id;
        if (action && jobId) handleCardAction(action, jobId);
    });

    // Lightbox
    DOM.lightbox.addEventListener('click', (e) => {
        if (e.target === DOM.lightbox || e.target === DOM.lightboxClose) closeLightbox();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeLightbox();
            if (DOM.editModal.style.display !== 'none') {
                DOM.editModal.style.display = 'none';
            }
        }
    });

    // Edit modal
    if (DOM.modalClose) DOM.modalClose.addEventListener('click', () => DOM.editModal.style.display = 'none');
    if (DOM.btnCancelEdit) DOM.btnCancelEdit.addEventListener('click', () => DOM.editModal.style.display = 'none');
    if (DOM.btnSaveEdit) DOM.btnSaveEdit.addEventListener('click', () => saveEdit(false));
    if (DOM.btnSaveRegenerate) DOM.btnSaveRegenerate.addEventListener('click', () => saveEdit(true));

    // Restore cookie
    if (store.cookie) {
        DOM.cookieInput.value = store.cookie;
        (async () => {
            try {
                const res = await fetch('/api/validate-cookie', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ cookie: store.cookie })
                });
                const data = await res.json();
                if (data.valid) {
                    updateStatus(true, data.email);
                    try {
                        const parsed = JSON.parse(store.cookie.trim());
                        if (Array.isArray(parsed)) {
                            const session = parsed.find(c =>
                                c.name?.includes('session') || c.name?.includes('Secure')
                            );
                            if (session?.expirationDate) {
                                startCookieTimer(session.expirationDate * 1000);
                            }
                        }
                    } catch { }
                }
            } catch { }
        })();
    }

    // Restore queue state
    restoreQueueState();

    // Bind reference image events (drag-and-drop + click)
    bindReferenceEvents();

    updatePromptCount();
    updatePrefixPreview();
    updateSidebarSteps();
}

function saveEdit(andRegenerate = false) {
    if (!editingJobId) return;
    const job = store.jobs.find(j => j.id === editingJobId);
    const jobId = editingJobId;
    if (job) {
        job.prompt = DOM.editPromptInput.value.trim();
        updateCard(job.id);
        saveQueueState();
    }
    DOM.editModal.style.display = 'none';
    editingJobId = null;

    // Optionally regenerate after saving
    if (andRegenerate && job) {
        regenerateSingleJob(jobId);
    }
}

document.addEventListener('DOMContentLoaded', init);
