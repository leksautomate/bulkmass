/**
 * Worker - Background job processor
 * Fixes: processing lock, backoff, project refresh, memory management
 */

const path = require('path');
const fs = require('fs');
const queue = require('./queue');

const OUTPUT_DIR = path.join(__dirname, 'output');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

let isRunning = false;
let isProcessing = false;  // LOCK: prevents re-entrant processing
let Whisk = null;
let broadcastFn = () => {};
const whiskInstances = new Map();
const MAX_INSTANCES = 5;

// Backoff state
let consecutiveErrors = 0;
const BASE_DELAY = 4000;       // 4s between API calls
const MAX_BACKOFF = 60000;     // max 60s backoff
const PROJECT_REFRESH_EVERY = 10;  // refresh Whisk project every N images

// ============================================
// WHISK HELPERS
// ============================================

function getWhiskInstance(cookie) {
    if (!Whisk) throw new Error('Whisk API not loaded');

    const hash = Buffer.from(cookie).toString('base64').slice(0, 32);

    if (!whiskInstances.has(hash)) {
        const instance = new Whisk(cookie);
        whiskInstances.set(hash, {
            whisk: instance,
            project: null,
            lastUsed: Date.now(),
            generationCount: 0
        });

        // Cleanup if too many
        if (whiskInstances.size > MAX_INSTANCES) {
            const entries = [...whiskInstances.entries()]
                .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
            while (whiskInstances.size > MAX_INSTANCES) {
                const [h] = entries.shift();
                whiskInstances.delete(h);
                console.log(`[Worker] Evicted stale Whisk instance`);
            }
        }
    } else {
        whiskInstances.get(hash).lastUsed = Date.now();
    }

    return whiskInstances.get(hash);
}

function mapAspectRatio(ratio) {
    const map = {
        '1:1': 'IMAGE_ASPECT_RATIO_SQUARE',
        '16:9': 'IMAGE_ASPECT_RATIO_LANDSCAPE',
        '9:16': 'IMAGE_ASPECT_RATIO_PORTRAIT',
        'SQUARE': 'IMAGE_ASPECT_RATIO_SQUARE',
        'LANDSCAPE': 'IMAGE_ASPECT_RATIO_LANDSCAPE',
        'PORTRAIT': 'IMAGE_ASPECT_RATIO_PORTRAIT'
    };
    return map[ratio] || 'IMAGE_ASPECT_RATIO_SQUARE';
}

function getBackoffDelay() {
    if (consecutiveErrors === 0) return BASE_DELAY;
    // Exponential backoff: 4s, 8s, 16s, 32s, 60s cap
    return Math.min(BASE_DELAY * Math.pow(2, consecutiveErrors), MAX_BACKOFF);
}

// ============================================
// JOB PROCESSING
// ============================================

async function processPrompt(job, prompt) {
    const text = prompt.text || '';
    console.log(`[Worker] Processing: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);

    try {
        // Mock mode
        if (job.cookie === 'MOCK') {
            await new Promise(r => setTimeout(r, 800));
            const filename = `mock_${Date.now()}_${Math.random().toString(36).substr(2, 6)}.png`;
            const filepath = path.join(OUTPUT_DIR, filename);
            fs.writeFileSync(filepath, 'MOCK');

            const imageUrl = `/output/${filename}`;
            const updated = queue.updatePrompt(job.id, prompt.id, { status: 'completed', imageUrl });

            broadcastFn({
                type: 'prompt-completed',
                jobId: job.id,
                promptId: prompt.id,
                imageUrl,
                progress: updated?.progress || 0,
                completedCount: updated?.completedCount || 0,
                totalCount: updated?.totalCount || 0
            });

            consecutiveErrors = 0;
            return true;
        }

        const instance = getWhiskInstance(job.cookie);

        // Refresh project if null or after N generations
        if (!instance.project || instance.generationCount >= PROJECT_REFRESH_EVERY) {
            try {
                console.log(`[Worker] Creating new Whisk project (gen count: ${instance.generationCount})`);
                instance.project = await instance.whisk.newProject('Bulkmass Generation');
                instance.generationCount = 0;
            } catch (projErr) {
                console.error(`[Worker] Failed to create project: ${projErr.message}`);
                // Clear the project so next attempt creates fresh
                instance.project = null;
                throw projErr;
            }
        }

        const media = await instance.project.generateImage({
            prompt: text,
            aspectRatio: mapAspectRatio(job.aspectRatio)
        });

        const savedPath = media.save(OUTPUT_DIR);
        const imageUrl = `/output/${path.basename(savedPath)}`;

        console.log(`[Worker] Generated: ${imageUrl}`);

        instance.generationCount++;

        const updated = queue.updatePrompt(job.id, prompt.id, { status: 'completed', imageUrl });

        broadcastFn({
            type: 'prompt-completed',
            jobId: job.id,
            promptId: prompt.id,
            imageUrl,
            progress: updated?.progress || 0,
            completedCount: updated?.completedCount || 0,
            totalCount: updated?.totalCount || 0
        });

        consecutiveErrors = 0;
        return true;
    } catch (error) {
        consecutiveErrors++;
        console.error(`[Worker] Error (streak: ${consecutiveErrors}): ${error.message}`);

        // If project-related error, clear the project for fresh retry
        const instance = whiskInstances.get(Buffer.from(job.cookie).toString('base64').slice(0, 32));
        if (instance && (
            error.message.includes('project') ||
            error.message.includes('404') ||
            error.message.includes('500') ||
            error.message.includes('ECONNRESET') ||
            error.message.includes('socket')
        )) {
            instance.project = null;
            instance.generationCount = 0;
            console.log('[Worker] Cleared stale project reference');
        }

        const updated = queue.updatePrompt(job.id, prompt.id, { status: 'error', error: error.message });

        broadcastFn({
            type: 'prompt-error',
            jobId: job.id,
            promptId: prompt.id,
            error: error.message,
            progress: updated?.progress || 0,
            completedCount: updated?.completedCount || 0,
            failedCount: updated?.failedCount || 0,
            totalCount: updated?.totalCount || 0
        });

        return false;
    }
}

async function processJob(job) {
    console.log(`[Worker] Starting job: ${job.id} (${job.totalCount} prompts)`);

    queue.updateJob(job.id, {
        status: queue.Status.PROCESSING,
        startedAt: new Date().toISOString()
    });

    broadcastFn({ type: 'job-started', jobId: job.id });

    let promptsProcessed = 0;

    try {
        let prompt;
        while ((prompt = queue.getNextPendingPrompt(job.id)) !== null) {
            // Check cancellation
            const current = queue.getJob(job.id);
            if (!current || current.status === queue.Status.CANCELLED) {
                console.log(`[Worker] Job cancelled: ${job.id}`);
                return;
            }

            // Too many consecutive errors → abort job
            if (consecutiveErrors >= 5) {
                console.error(`[Worker] Too many consecutive errors (${consecutiveErrors}), pausing job`);
                queue.updateJob(job.id, {
                    status: queue.Status.FAILED,
                    completedAt: new Date().toISOString()
                });
                broadcastFn({
                    type: 'job-completed',
                    jobId: job.id,
                    error: 'Too many consecutive errors',
                    completedCount: current.completedCount,
                    failedCount: current.failedCount,
                    totalCount: current.totalCount
                });
                return;
            }

            queue.updatePrompt(job.id, prompt.id, { status: 'processing' });

            broadcastFn({
                type: 'prompt-processing',
                jobId: job.id,
                promptId: prompt.id,
                text: prompt.text
            });

            await processPrompt(job, prompt);
            promptsProcessed++;

            // Rate limit with backoff
            const delay = getBackoffDelay();
            if (delay > BASE_DELAY) {
                console.log(`[Worker] Backoff delay: ${delay}ms (${consecutiveErrors} errors)`);
            }
            await new Promise(r => setTimeout(r, delay));

            // Trigger GC every 5 prompts to keep memory under control
            if (promptsProcessed % 5 === 0 && global.gc) {
                try { global.gc(); } catch {}
            }
        }
    } catch (loopError) {
        console.error(`[Worker] Job loop error: ${loopError.message}`);
    }

    // Finalize job
    const final = queue.getJob(job.id);
    if (final && final.status === queue.Status.PROCESSING) {
        queue.updateJob(job.id, {
            status: queue.Status.COMPLETED,
            completedAt: new Date().toISOString()
        });

        broadcastFn({
            type: 'job-completed',
            jobId: job.id,
            completedCount: final.completedCount,
            failedCount: final.failedCount,
            totalCount: final.totalCount
        });

        console.log(`[Worker] Job done: ${job.id} (${final.completedCount}/${final.totalCount} ok, ${final.failedCount} failed)`);
    }

    // GC after job completes
    if (global.gc) {
        try { global.gc(); } catch {}
    }
}

// ============================================
// WORKER LOOP
// ============================================

async function workerLoop() {
    if (!isRunning) return;

    // LOCK: skip if already processing
    if (!isProcessing) {
        try {
            isProcessing = true;

            if (queue.canStartNew()) {
                const job = queue.getNextPendingJob();
                if (job) {
                    await processJob(job);
                }
            }

            // Random cleanup (~once per hour at 3s intervals)
            if (Math.random() < 1 / 1200) {
                queue.cleanupOldJobs();
            }
        } catch (error) {
            console.error('[Worker] Loop error:', error.message);
        } finally {
            isProcessing = false;
        }
    }

    if (isRunning) {
        setTimeout(workerLoop, 3000);
    }
}

function recoverInterruptedJobs() {
    try {
        const jobs = queue.loadJobs();
        let recovered = 0;

        jobs.forEach(job => {
            if (job.status === queue.Status.PROCESSING) {
                job.status = queue.Status.PENDING;
                job.startedAt = null;
                recovered++;
            }
            if (job.prompts) {
                job.prompts.forEach(p => {
                    if (p.status === 'processing') {
                        p.status = 'pending';
                        recovered++;
                    }
                });
            }
        });

        if (recovered > 0) {
            queue.saveJobs(jobs);
            console.log(`[Worker] Recovered ${recovered} interrupted items`);
        }
    } catch (error) {
        console.error('[Worker] Recovery error:', error.message);
    }
}

// ============================================
// EXPORTS
// ============================================

function start(WhiskClass, broadcast) {
    if (isRunning) return;

    Whisk = WhiskClass;
    broadcastFn = broadcast || (() => {});
    isRunning = true;
    consecutiveErrors = 0;

    console.log('[Worker] Started');
    recoverInterruptedJobs();
    workerLoop();
}

function stop() {
    isRunning = false;
    console.log('[Worker] Stopped');
}

module.exports = { start, stop, isRunning: () => isRunning };
