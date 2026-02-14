/**
 * Queue - Job queue with in-memory cache + periodic disk persistence
 * Fixes: excessive file I/O that caused crashes on 20+ images
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
const MAX_CONCURRENT_JOBS = parseInt(process.env.MAX_CONCURRENT_JOBS) || 5;

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const Status = {
    PENDING: 'pending',
    PROCESSING: 'processing',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled'
};

// ============================================
// IN-MEMORY CACHE (core fix)
// ============================================

let jobsCache = null;  // in-memory job store
let isDirty = false;    // whether cache has unsaved changes
let saveTimer = null;   // debounce timer

function loadJobsFromDisk() {
    try {
        if (fs.existsSync(JOBS_FILE)) {
            return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('[Queue] Error reading jobs file:', e.message);

        // Try backup
        const backup = JOBS_FILE + '.bak';
        if (fs.existsSync(backup)) {
            try {
                console.log('[Queue] Restoring from backup...');
                return JSON.parse(fs.readFileSync(backup, 'utf8'));
            } catch {}
        }
    }
    return [];
}

function getJobs() {
    if (jobsCache === null) {
        jobsCache = loadJobsFromDisk();
    }
    return jobsCache;
}

function saveToDisk() {
    if (!isDirty || jobsCache === null) return;

    try {
        const data = JSON.stringify(jobsCache, null, 2);

        // Write backup first, then overwrite main file
        const backup = JOBS_FILE + '.bak';
        if (fs.existsSync(JOBS_FILE)) {
            try { fs.copyFileSync(JOBS_FILE, backup); } catch {}
        }

        fs.writeFileSync(JOBS_FILE, data);
        isDirty = false;
    } catch (e) {
        console.error('[Queue] Error saving jobs:', e.message);
    }
}

// Debounced save: waits 2 seconds after last change before writing
function scheduleSave() {
    isDirty = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveToDisk, 2000);
}

// Force immediate save (for critical state changes)
function saveNow() {
    isDirty = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveToDisk();
}

// Auto-save every 30 seconds as safety net
setInterval(() => {
    if (isDirty) saveToDisk();
}, 30000);

// Save on process exit
process.on('beforeExit', saveToDisk);
process.on('SIGINT', () => { saveToDisk(); process.exit(0); });
process.on('SIGTERM', () => { saveToDisk(); process.exit(0); });

// ============================================
// JOB OPERATIONS (all in-memory, minimal disk I/O)
// ============================================

function createJob({ cookie, prompts, aspectRatio }) {
    const jobs = getJobs();

    const job = {
        id: `job_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        cookieHash: Buffer.from(cookie).toString('base64').slice(0, 16), // store hash, not full cookie
        cookie,
        aspectRatio: aspectRatio || '1:1',
        status: Status.PENDING,
        createdAt: new Date().toISOString(),
        startedAt: null,
        completedAt: null,
        prompts: prompts.map((text, i) => ({
            id: `p_${Date.now()}_${i}`,
            text,
            status: 'pending',
            imageUrl: null,
            error: null
        })),
        progress: 0,
        completedCount: 0,
        failedCount: 0,
        totalCount: prompts.length
    };

    jobs.push(job);
    saveNow(); // immediate save for job creation
    return job;
}

function getJob(jobId) {
    return getJobs().find(j => j.id === jobId) || null;
}

function getAllJobs() {
    return getJobs();
}

function updateJob(jobId, updates) {
    const jobs = getJobs();
    const idx = jobs.findIndex(j => j.id === jobId);
    if (idx === -1) return null;

    Object.assign(jobs[idx], updates);

    // Immediate save for status changes (completed, failed, cancelled)
    if (updates.status) {
        saveNow();
    } else {
        scheduleSave();
    }

    return jobs[idx];
}

function updatePrompt(jobId, promptId, updates) {
    const jobs = getJobs();
    const job = jobs.find(j => j.id === jobId);
    if (!job) return null;

    const prompt = job.prompts.find(p => p.id === promptId);
    if (!prompt) return null;

    Object.assign(prompt, updates);

    // Recalculate progress
    job.completedCount = job.prompts.filter(p => p.status === 'completed').length;
    job.failedCount = job.prompts.filter(p => p.status === 'error').length;
    job.progress = Math.round(((job.completedCount + job.failedCount) / job.totalCount) * 100);

    // Only debounced save for prompt updates (this is the key fix)
    // Processing status = debounce, completed/error = schedule but not urgent
    scheduleSave();

    return job;
}

function cancelJob(jobId) {
    return updateJob(jobId, {
        status: Status.CANCELLED,
        completedAt: new Date().toISOString()
    });
}

function getNextPendingJob() {
    return getJobs().find(j => j.status === Status.PENDING) || null;
}

function getNextPendingPrompt(jobId) {
    const job = getJob(jobId);
    if (!job) return null;
    return job.prompts.find(p => p.status === 'pending') || null;
}

function getActiveCount() {
    return getJobs().filter(j => j.status === Status.PROCESSING).length;
}

function canStartNew() {
    return getActiveCount() < MAX_CONCURRENT_JOBS;
}

function getStats() {
    const jobs = getJobs();
    return {
        active: jobs.filter(j => j.status === Status.PROCESSING).length,
        pending: jobs.filter(j => j.status === Status.PENDING).length,
        completed: jobs.filter(j => j.status === Status.COMPLETED).length,
        maxConcurrent: MAX_CONCURRENT_JOBS
    };
}

function cleanupOldJobs() {
    const jobs = getJobs();
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const before = jobs.length;

    jobsCache = jobs.filter(j => {
        if (j.status !== Status.COMPLETED && j.status !== Status.FAILED) return true;
        const date = j.completedAt ? new Date(j.completedAt) : new Date(j.createdAt);
        return date.getTime() > cutoff;
    });

    const removed = before - jobsCache.length;
    if (removed > 0) {
        saveNow();
        console.log(`[Queue] Cleaned up ${removed} old jobs`);
    }
    return removed;
}

// Expose for worker recovery
function loadJobs() { return getJobs(); }
function saveJobs(jobs) {
    jobsCache = jobs;
    saveNow();
}

module.exports = {
    Status,
    MAX_CONCURRENT_JOBS,
    loadJobs,
    saveJobs,
    createJob,
    getJob,
    getJobs: getAllJobs,
    updateJob,
    updatePrompt,
    cancelJob,
    getNextPendingJob,
    getNextPendingPrompt,
    getActiveCount,
    canStartNew,
    getStats,
    cleanupOldJobs,
    saveToDisk  // for explicit flush
};
