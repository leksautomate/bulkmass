/**
 * Bulkmass Server - Stateless Whisk API Proxy
 * Each user brings their own cookie. Server just proxies to Whisk API.
 * No job queue, no worker, no SSE, no image storage.
 */

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

// ============================================
// GLOBAL ERROR HANDLERS
// ============================================

process.on('uncaughtException', (error) => {
    console.error('[FATAL] Uncaught Exception:', error.message);
    console.error(error.stack);
});

process.on('unhandledRejection', (reason) => {
    console.error('[WARN] Unhandled Rejection:', reason instanceof Error ? reason.message : reason);
});

// ============================================
// SETUP
// ============================================

const app = express();
const PORT = process.env.PORT || 5000;

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({ dest: UPLOADS_DIR, limits: { fileSize: 5 * 1024 * 1024 } });

// Whisk API (ESM dynamic import)
let Whisk = null;
let MediaClass = null;
let whiskLoaded = false;

async function loadWhiskApi() {
    if (whiskLoaded) return;
    try {
        const localPath = path.resolve(__dirname, 'whisk-api-source/dist/index.js');
        const localUrl = 'file://' + localPath.replace(/\\/g, '/');

        const mod = await import(localUrl);
        console.log('[Whisk] Local API loaded');

        Whisk = mod.Whisk || mod.default?.Whisk || mod.default;
        MediaClass = mod.Media || mod.default?.Media;
        whiskLoaded = true;
    } catch (e) {
        console.warn('[Whisk] API not available:', e.message);
        console.warn(e.stack);
        Whisk = null;
        MediaClass = null;
    }
}

// Trust proxy (for rate limiting behind nginx/reverse proxy)
app.set('trust proxy', 1);

// Middleware
app.use(cors());
app.use(compression());
app.use(express.json({ limit: '50mb' }));

// Security headers
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});

// Serve only public frontend files (not server code)
const PUBLIC_DIR = __dirname;
const ALLOWED_FILES = ['index.html', 'app.js', 'styles.css', 'favicon.ico', 'cinescript.html', 'cinescript.js', 'cinescript.css'];

app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
ALLOWED_FILES.forEach(file => {
    app.get(`/${file}`, (req, res, next) => {
        const filePath = path.join(PUBLIC_DIR, file);
        if (fs.existsSync(filePath)) return res.sendFile(filePath);
        next();
    });
});

// ============================================
// RATE LIMITING
// ============================================

const rateLimits = new Map();

// Clean up stale rate limit entries every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [ip, record] of rateLimits) {
        if (now > record.resetAt) rateLimits.delete(ip);
    }
}, 5 * 60 * 1000);

app.use('/api/generate', (req, res, next) => {
    const ip = req.ip;
    const now = Date.now();
    let record = rateLimits.get(ip);

    if (!record || now > record.resetAt) {
        record = { count: 0, resetAt: now + 60000 };
    }

    record.count++;
    rateLimits.set(ip, record);

    if (record.count > 20) {
        return res.status(429).json({
            success: false,
            error: 'Rate limited: max 20 requests per minute. Please wait.'
        });
    }

    next();
});

// ============================================
// HELPERS
// ============================================

function parseCookies(input) {
    if (!input) return { cookieString: '', expirationDate: null };

    let cookieString = '';
    let expirationDate = null;
    const trimmed = input.trim();

    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        try {
            const parsed = JSON.parse(trimmed);

            if (Array.isArray(parsed)) {
                cookieString = parsed.map(c => `${c.name}=${c.value}`).join('; ');
                const session = parsed.find(c =>
                    c.name === '__Secure-next-auth.session-token' ||
                    c.name.includes('session')
                );
                if (session?.expirationDate) {
                    expirationDate = session.expirationDate * 1000;
                }
            } else if (parsed.cookie) {
                return parseCookies(parsed.cookie);
            } else if (parsed.name && parsed.value) {
                cookieString = `${parsed.name}=${parsed.value}`;
            } else {
                cookieString = Object.entries(parsed).map(([k, v]) => `${k}=${v}`).join('; ');
            }
        } catch {
            cookieString = input;
        }
    } else {
        cookieString = input;
    }

    if (typeof cookieString === 'string') {
        if (cookieString.trim().toLowerCase().startsWith('cookie:')) {
            cookieString = cookieString.trim().substring(7).trim();
        }
        if (cookieString.startsWith('"') && cookieString.endsWith('"')) {
            cookieString = cookieString.slice(1, -1);
        }
    }

    return { cookieString, expirationDate };
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

// ============================================
// API ROUTES
// ============================================

// Health check
app.get('/api/health', (req, res) => {
    const mem = process.memoryUsage();
    res.json({
        status: 'ok',
        whiskAvailable: !!Whisk,
        memory: {
            heapUsed: `${Math.round(mem.heapUsed / 1024 / 1024)} MB`,
            rss: `${Math.round(mem.rss / 1024 / 1024)} MB`
        },
        uptime: Math.round(process.uptime())
    });
});

// Validate cookie
app.post('/api/validate-cookie', async (req, res) => {
    try {
        const { cookie } = req.body;
        if (!cookie) return res.status(400).json({ valid: false, message: 'Cookie is required' });

        if (cookie === 'MOCK') {
            return res.json({ valid: true, message: 'Mock Mode Active', email: 'mock@example.com' });
        }

        if (!Whisk) {
            return res.status(500).json({ valid: false, message: 'Whisk API not available' });
        }

        const { cookieString } = parseCookies(cookie);
        if (!cookieString) return res.status(400).json({ valid: false, message: 'Invalid cookie format' });

        try {
            const whisk = new Whisk(cookieString);
            await whisk.account.refresh();

            res.json({
                valid: true,
                message: 'Cookie validated',
                email: whisk.account.userEmail || null
            });
        } catch (error) {
            const isAuth = error.message && (
                error.message.includes('401') ||
                error.message.includes('Unauthorized') ||
                error.message.includes('cookie')
            );

            res.json({
                valid: false,
                message: isAuth
                    ? 'Cookie is invalid or expired. Please get a fresh cookie.'
                    : error.message
            });
        }
    } catch (error) {
        console.error('[Validate] Error:', error);
        res.status(500).json({ valid: false, message: error.message });
    }
});

// Generate a single image (stateless - creates Whisk per request)
app.post('/api/generate', async (req, res) => {
    try {
        const { cookie, prompt, aspectRatio, references } = req.body;
        if (!cookie) return res.status(400).json({ success: false, error: 'Cookie is required' });
        if (!prompt) return res.status(400).json({ success: false, error: 'Prompt is required' });

        if (!Whisk) {
            return res.status(500).json({ success: false, error: 'Whisk API not available' });
        }

        // Mock mode for testing
        if (cookie === 'MOCK') {
            await new Promise(r => setTimeout(r, 800));
            // Return a tiny 1x1 transparent PNG as base64
            const mockBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
            return res.json({
                success: true,
                image: mockBase64,
                prompt,
                seed: Math.floor(Math.random() * 999999),
                mediaId: `mock_${Date.now()}`
            });
        }

        const { cookieString } = parseCookies(cookie);
        if (!cookieString) return res.status(400).json({ success: false, error: 'Invalid cookie format' });

        // 60s timeout for Whisk API calls
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60000);

        try {
            const whisk = new Whisk(cookieString);
            const project = await whisk.newProject('Bulkmass');

            let hasReferences = false;
            if (references && Array.isArray(references)) {
                for (const ref of references) {
                    if (!ref.image || !ref.category) continue;

                    // Strip the base64 data URI prefix
                    const cleanBase64 = ref.image.replace(/^data:image\/\w+;base64,/, '');
                    const customCaption = ref.caption?.trim() || undefined;

                    if (ref.category === 'SUBJECT') {
                        await project.addSubject(cleanBase64, customCaption);
                        hasReferences = true;
                    } else if (ref.category === 'SCENE') {
                        await project.addScene(cleanBase64, customCaption);
                        hasReferences = true;
                    } else if (ref.category === 'STYLE') {
                        await project.addStyle(cleanBase64, customCaption);
                        hasReferences = true;
                    }
                }
            }

            let media;
            if (hasReferences) {
                media = await project.generateImageWithReferences({
                    prompt,
                    aspectRatio: mapAspectRatio(aspectRatio || '1:1')
                });
            } else {
                media = await project.generateImage({
                    prompt,
                    aspectRatio: mapAspectRatio(aspectRatio || '1:1')
                });
            }

            // Fire-and-forget delete project, just like before but we should keep it clean if we created it
            try { project.delete().catch(() => { }); } catch (e) { }

            clearTimeout(timeout);

            res.json({
                success: true,
                image: media.encodedMedia,
                prompt: media.prompt,
                seed: media.seed,
                mediaId: media.mediaGenerationId
            });
        } catch (innerError) {
            clearTimeout(timeout);
            if (innerError.name === 'AbortError') {
                throw new Error('Generation timed out (60s)');
            }
            throw innerError;
        }
    } catch (error) {
        console.error('[Generate] Error:', error.message);
        const status = error.message?.includes('401') ? 401 : 500;
        res.status(status).json({ success: false, error: error.message });
    }
});

// Animate a single image to video
app.post('/api/animate', async (req, res) => {
    try {
        const { cookie, imageBase64, imagePrompt, videoScript, model } = req.body;
        if (!cookie) return res.status(400).json({ success: false, error: 'Cookie is required' });
        if (!imageBase64) return res.status(400).json({ success: false, error: 'Image data is required' });
        if (!videoScript?.trim()) return res.status(400).json({ success: false, error: 'Video script is required' });

        if (!Whisk || !MediaClass) {
            return res.status(500).json({ success: false, error: 'Whisk API not available' });
        }

        const { cookieString } = parseCookies(cookie);
        if (!cookieString) return res.status(400).json({ success: false, error: 'Invalid cookie format' });

        // Strip data URI prefix to get raw base64
        const rawBytes = imageBase64.replace(/^data:image\/\w+;base64,/, '');

        const videoModel = model === 'VEO_3_1' ? 'VEO_3_1_I2V_12STEP' : 'veo_3_1_i2v_s_fast';

        // 150s timeout — video generation polls for ~40s
        const timeout = setTimeout(() => {
            if (!res.headersSent) {
                res.status(504).json({ success: false, error: 'Animation timed out (150s)' });
            }
        }, 150000);

        try {
            const whisk = new Whisk(cookieString);
            const project = await whisk.newProject('Bulkmass-Video');

            const media = new MediaClass({
                seed: 0,
                prompt: imagePrompt || 'image',
                workflowId: project.projectId,
                encodedMedia: rawBytes,
                mediaGenerationId: 'tmp_' + Date.now(),
                aspectRatio: 'IMAGE_ASPECT_RATIO_LANDSCAPE',
                mediaType: 'IMAGE',
                model: 'IMAGEN_3_5',
                account: whisk.account
            });

            const videoMedia = await media.animate(videoScript, videoModel);

            clearTimeout(timeout);

            if (res.headersSent) return;

            res.json({
                success: true,
                video: videoMedia.encodedMedia,
                prompt: videoMedia.prompt,
                mediaId: videoMedia.mediaGenerationId
            });

            try { project.delete().catch(() => {}); } catch (_) {}
        } catch (innerError) {
            clearTimeout(timeout);
            if (res.headersSent) return;
            throw innerError;
        }
    } catch (error) {
        console.error('[Animate] Error:', error.message);
        const status = error.message?.includes('401') ? 401 : 500;
        if (!res.headersSent) res.status(status).json({ success: false, error: error.message });
    }
});

// Upload prompts file
app.post('/api/upload-prompts', upload.single('file'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

        const content = fs.readFileSync(req.file.path, 'utf8');
        let prompts = [];
        const name = req.file.originalname.toLowerCase();

        if (name.endsWith('.json')) {
            try {
                const data = JSON.parse(content);
                if (Array.isArray(data)) {
                    prompts = data.map(item =>
                        typeof item === 'string' ? item : (item.prompt || item.text || '')
                    ).filter(Boolean);
                } else if (data.prompts && Array.isArray(data.prompts)) {
                    prompts = data.prompts;
                }
            } catch {
                prompts = content.split('\n').map(l => l.trim()).filter(Boolean);
            }
        } else if (name.endsWith('.csv')) {
            const lines = content.split('\n').filter(l => l.trim());
            const startIdx = lines[0]?.toLowerCase().includes('prompt') ? 1 : 0;
            prompts = lines.slice(startIdx).map(line => {
                return line.split(',')[0].replace(/^["']|["']$/g, '').trim();
            }).filter(Boolean);
        } else {
            prompts = content.split('\n')
                .map(l => l.trim())
                .filter(l => l && !l.startsWith('#'));
        }

        try { fs.unlinkSync(req.file.path); } catch { }

        res.json({ success: true, prompts, count: prompts.length });
    } catch (error) {
        if (req.file?.path) {
            try { fs.unlinkSync(req.file.path); } catch { }
        }
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// ERROR HANDLING
// ============================================

app.use((err, req, res, next) => {
    console.error('[Server] Express error:', err.message);
    if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error', message: err.message });
    }
});

// ============================================
// START
// ============================================

(async () => {
    await loadWhiskApi();

    const server = app.listen(PORT, () => {
        console.log(`
========================================
  Bulkmass Server (Multi-User)
  URL: http://localhost:${PORT}
  Whisk: ${Whisk ? 'Available' : 'Not installed'}
  Mode: Stateless Proxy
========================================
        `);
    });

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.error(`
==========================================
  ⚠  PORT ${PORT} IS ALREADY IN USE!
==========================================
  Another process is using port ${PORT}.
  
  To fix this, either:
    1. Stop the other process using port ${PORT}
    2. Use a different port:
       PORT=3000 node server.js
       PORT=8080 node server.js
  
  To find what's using the port:
    Linux/Mac: lsof -i :${PORT}
    Windows:   netstat -ano | findstr :${PORT}
==========================================
`);
            process.exit(1);
        } else {
            console.error('[Server] Failed to start:', err.message);
            process.exit(1);
        }
    });
})();

module.exports = app;
