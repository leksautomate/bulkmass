/**
 * Cine-Script AI - Script Generation Wizard
 * Uses Groq API (llama-3.3-70b-versatile)
 * All state in browser (localStorage for API key, memory for wizard state)
 */

// ============================================
// GROQ API
// ============================================

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const LS_KEY_API = 'cinescript_groq_key';

function getApiKey() {
    return document.getElementById('api-key-input').value.trim() || localStorage.getItem(LS_KEY_API) || '';
}

async function callGroq(prompt) {
    const apiKey = getApiKey();
    if (!apiKey) {
        throw new Error('No API Key set. Please add your Groq API Key in Settings.');
    }

    const maxRetries = 5;
    let delay = 1000;

    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await fetch(GROQ_API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model: GROQ_MODEL,
                    messages: [{ role: 'user', content: prompt }],
                    temperature: 0.8,
                    max_tokens: 4096
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                if (response.status === 401 || response.status === 403) {
                    throw new Error(`Authentication failed (${response.status}). Please check your API Key in Settings.`);
                }
                throw new Error(`API Error: ${response.status} ${response.statusText} - ${errorText}`);
            }

            const data = await response.json();

            if (data.error) throw new Error(data.error.message);
            if (!data.choices || !data.choices[0] || !data.choices[0].message) {
                throw new Error('Invalid API response format');
            }

            return data.choices[0].message.content;
        } catch (error) {
            console.warn(`Attempt ${i + 1} failed:`, error);
            if (error.message.includes('Authentication failed') || i === maxRetries - 1) {
                throw error;
            }
            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= 2;
        }
    }
}

function cleanAndParseJSON(text) {
    try {
        // Remove markdown code fences if present
        let cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
        const match = cleaned.match(/\[[\s\S]*\]/);
        if (match) {
            return JSON.parse(match[0]);
        }
        return JSON.parse(cleaned);
    } catch (e) {
        console.error('JSON Parse Error on text:', text, e);
        throw new Error('Failed to parse AI response. Please try again.');
    }
}

// ============================================
// STATE
// ============================================

let currentStep = 0;
let isLoading = false;
let topic = '';
let angles = [];
let selectedAngle = '';
let ideas = [];
let selectedIdea = '';
let hook = '';
let script = '';

// ============================================
// DOM
// ============================================

function $(sel) { return document.querySelector(sel); }

function showStep(step) {
    currentStep = step;
    document.querySelectorAll('.cs-step').forEach(el => el.classList.remove('active'));
    const stepEl = document.getElementById(`cs-step-${step}`);
    if (stepEl) {
        stepEl.classList.add('active');
        // Add animation
        stepEl.style.animation = 'none';
        stepEl.offsetHeight; // trigger reflow
        stepEl.style.animation = step === 0 ? 'cs-fadeIn 0.5s ease both' : 'cs-slideRight 0.5s ease both';
    }
    // Update step counter
    const counter = $('#cs-step-counter');
    if (counter) counter.textContent = `STEP ${step + 1}/5`;
}

function setLoading(show) {
    isLoading = show;
    const el = $('#cs-loading');
    if (el) el.style.display = show ? 'flex' : 'none';
}

function showError(msg) {
    const container = $('#cs-error-container');
    if (!container) return;
    if (!msg) {
        container.innerHTML = '';
        return;
    }
    container.innerHTML = `
        <div class="cs-error">
            <div class="cs-error-dot"></div>
            <span>${escapeHtml(msg)}</span>
        </div>
    `;
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function showToast(msg) {
    const container = $('#cs-toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'cs-toast';
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

// ============================================
// NAVIGATION SIDEBAR
// ============================================

function openNav() {
    const sidebar = $('#nav-sidebar');
    const overlay = $('#nav-overlay');
    if (sidebar) sidebar.classList.add('open');
    if (overlay) overlay.classList.add('open');
}

function closeNav() {
    const sidebar = $('#nav-sidebar');
    const overlay = $('#nav-overlay');
    if (sidebar) sidebar.classList.remove('open');
    if (overlay) overlay.classList.remove('open');
}

// ============================================
// SETTINGS
// ============================================

function toggleSettings() {
    const panel = $('#cs-settings-panel');
    const btn = $('#cs-settings-btn');
    if (panel) panel.classList.toggle('open');
    if (btn) btn.classList.toggle('active');
}

function saveApiKey() {
    const key = document.getElementById('api-key-input').value.trim();
    if (key) {
        localStorage.setItem(LS_KEY_API, key);
    } else {
        localStorage.removeItem(LS_KEY_API);
    }
}

// ============================================
// STEP HANDLERS
// ============================================

async function handleGenerateAngles() {
    const input = document.getElementById('topic-input');
    topic = input.value.trim();
    if (!topic) return;

    setLoading(true);
    showError(null);

    const prompt = `
Hey, I've been thinking about this lately: [${topic}].
Can you give me 10 unusual, surprising, or underexplored reasons why this happened / existed / became important?
Please number them clearly. I'm looking for story angles that most people don't talk about.

IMPORTANT: Return ONLY a valid JSON array of strings. No markdown, no introduction, no code fences.
Example: ["Reason 1 text", "Reason 2 text"]
    `.trim();

    try {
        const rawText = await callGroq(prompt);
        angles = cleanAndParseJSON(rawText);
        renderAngles();
        showStep(1);
    } catch (err) {
        showError(err.message || 'Failed to generate angles. Please try again.');
        if (err.message.includes('Authentication failed') || err.message.includes('No API Key')) {
            const panel = $('#cs-settings-panel');
            if (panel && !panel.classList.contains('open')) toggleSettings();
        }
    } finally {
        setLoading(false);
    }
}

async function handleGenerateIdeas(angle) {
    selectedAngle = angle;
    setLoading(true);
    showError(null);

    const prompt = `
Topic: ${topic}
I think reason number [${angle}] is really interesting.
Can you break down that one reason into 5 short, specific ideas — events, turning points, contradictions, or facts — that are shocking, emotional, or visually powerful?
Keep them tightly related to that reason.

IMPORTANT: Return ONLY a valid JSON array of strings. No markdown, no code fences.
Example: ["Idea 1 text", "Idea 2 text"]
    `.trim();

    try {
        const rawText = await callGroq(prompt);
        ideas = cleanAndParseJSON(rawText);
        renderIdeas();
        showStep(2);
    } catch (err) {
        showError(err.message || 'Failed to generate ideas. Please try again.');
        if (err.message.includes('Authentication failed')) {
            const panel = $('#cs-settings-panel');
            if (panel && !panel.classList.contains('open')) toggleSettings();
        }
    } finally {
        setLoading(false);
    }
}

async function handleGenerateHook(idea) {
    const currentIdea = idea || selectedIdea;
    if (idea) selectedIdea = idea;

    setLoading(true);
    showError(null);

    const prompt = `
I want you to help me create a short, dramatic hook in this format for [${currentIdea}] related to topic: ${topic}.
Don't mention names, countries, or places directly. Use words like this man, this woman, this city, this village, etc.

Here's the structure I want:

Start with: "This [character type]" (e.g. "This girl," "This soldier")
Add a short phrase describing where or when, in parentheses: (e.g. "(in a war-torn village)")
Then, add one powerful trait or unique detail that makes them special
Then, describe one key action they did
Then, pause (add a line break or em dash)
Finally, give a twist or consequence. A reversal. Something unexpected, ironic, tragic, or mysterious.

Example Output:
This girl (in medieval France) dressed like a soldier, claimed she spoke to God, and led an army — just to be betrayed by the king she fought for.

IMPORTANT: Return ONLY the hook text. No explanations, no quotes around it.
    `.trim();

    try {
        const text = await callGroq(prompt);
        hook = text.trim().replace(/^["']|["']$/g, '');
        renderHook();
        showStep(3);
    } catch (err) {
        showError(err.message || 'Failed to generate hook.');
        if (err.message.includes('Authentication failed')) {
            const panel = $('#cs-settings-panel');
            if (panel && !panel.classList.contains('open')) toggleSettings();
        }
    } finally {
        setLoading(false);
    }
}

async function handleGenerateFinalScript() {
    setLoading(true);
    showError(null);

    const prompt = `
Write a dramatic short story in this exact format and pacing for the following topic [${selectedIdea}].
Each sentence should be short and cinematic — like subtitles. No long paragraphs.

Follow this 7-part structure exactly:

CONTEXT (PART 1)
Start with the date and place: "It's [year]. [City or country]."
Introduce characters and setup in simple, factual lines
Add a cultural or shocking historical norm

SMALL TWIST (PART 2)
Use a transitional line like "And for a while… it worked."
Add a sentence or two showing early success or tension building

PLOT TWIST (PART 3)
Show what went wrong
Add betrayal, ambition, or power struggle
End with a dramatic shift (exile, downfall, turning point)

CONTEXT (PART 4)
Show how the main character responded
Use short action sentences (e.g. "She camped outside the walls. Built an army.")
Mention an important alliance if relevant

SMALL TWIST (PART 5)
Use a quiet tension line (e.g. "And one night… she snuck back in.")
Do not overexplain — it's a stealth or setup move

FINAL CONSEQUENCE (PART 6)
Reveal the major event or fallout
Keep it mysterious ("No one knows how." "But one thing was clear…")

REVEAL (PART 7)
Final punchline with identity:
"And the [girl/man/place] who did it… was [name]."

Tone should be visual, cold, and factual — like a narrated historical scene.
No internal thoughts. No explanations. Just actions and outcomes. Do not include the Headers (like "CONTEXT (PART 1)"), just the script text.
    `.trim();

    try {
        const scriptText = await callGroq(prompt);
        script = scriptText.trim();
        renderFinalScript();
        showStep(4);
    } catch (err) {
        showError(err.message || 'Failed to generate script.');
        if (err.message.includes('Authentication failed')) {
            const panel = $('#cs-settings-panel');
            if (panel && !panel.classList.contains('open')) toggleSettings();
        }
    } finally {
        setLoading(false);
    }
}

// ============================================
// RENDERERS
// ============================================

function renderAngles() {
    const grid = $('#angles-grid');
    if (!grid) return;
    grid.innerHTML = angles.map((angle, idx) => `
        <button class="cs-option-card" onclick="handleGenerateIdeas(${JSON.stringify(angle).replace(/"/g, '&quot;')})">
            <span class="cs-option-num">${String(idx + 1).padStart(2, '0')}</span>
            <span class="cs-option-text">${escapeHtml(angle)}</span>
            <span class="cs-option-arrow">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
                </svg>
            </span>
        </button>
    `).join('');
    // Update context
    const ctx = $('#angles-topic');
    if (ctx) ctx.innerHTML = `Based on: <span>"${escapeHtml(topic)}"</span>`;
}

function renderIdeas() {
    const grid = $('#ideas-grid');
    if (!grid) return;
    grid.innerHTML = ideas.map((idea, idx) => `
        <button class="cs-option-card" onclick="handleGenerateHook(${JSON.stringify(idea).replace(/"/g, '&quot;')})">
            <span class="cs-option-num">${String(idx + 1).padStart(2, '0')}</span>
            <span class="cs-option-text">${escapeHtml(idea)}</span>
            <span class="cs-option-arrow">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/>
                    <line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/>
                    <line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/>
                    <line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/>
                    <line x1="17" y1="7" x2="22" y2="7"/>
                </svg>
            </span>
        </button>
    `).join('');
    // Update context
    const ctx = $('#ideas-angle');
    if (ctx) ctx.textContent = selectedAngle;
}

function renderHook() {
    const el = $('#hook-text');
    if (el) el.textContent = `"${hook}"`;
}

function renderFinalScript() {
    const hookEl = $('#final-hook');
    const scriptEl = $('#final-script');
    if (hookEl) hookEl.textContent = hook;
    if (scriptEl) scriptEl.textContent = script;
}

// ============================================
// ACTIONS
// ============================================

function copyScript() {
    const text = `${hook}\n\n${script}`;
    navigator.clipboard.writeText(text).then(() => {
        showToast('Script copied to clipboard!');
    }).catch(() => {
        // Fallback
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        showToast('Script copied to clipboard!');
    });
}

function resetWizard() {
    currentStep = 0;
    topic = '';
    angles = [];
    selectedAngle = '';
    ideas = [];
    selectedIdea = '';
    hook = '';
    script = '';
    showError(null);
    const input = document.getElementById('topic-input');
    if (input) input.value = '';
    showStep(0);
}

// ============================================
// INIT
// ============================================

document.addEventListener('DOMContentLoaded', () => {
    // Load saved API key
    const savedKey = localStorage.getItem(LS_KEY_API);
    const keyInput = document.getElementById('api-key-input');
    if (savedKey && keyInput) {
        keyInput.value = savedKey;
    }

    // API key auto-save on change
    if (keyInput) {
        keyInput.addEventListener('input', saveApiKey);
    }

    // Topic input enter key
    const topicInput = document.getElementById('topic-input');
    if (topicInput) {
        topicInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') handleGenerateAngles();
        });
    }

    // Nav sidebar
    const hamburger = $('#hamburger-btn');
    const navOverlay = $('#nav-overlay');
    if (hamburger) hamburger.addEventListener('click', openNav);
    if (navOverlay) navOverlay.addEventListener('click', closeNav);

    const navClose = $('#nav-sidebar-close');
    if (navClose) navClose.addEventListener('click', closeNav);

    // Settings toggle
    const settingsBtn = $('#cs-settings-btn');
    if (settingsBtn) settingsBtn.addEventListener('click', toggleSettings);

    const settingsClose = $('#cs-settings-close');
    if (settingsClose) settingsClose.addEventListener('click', toggleSettings);

    // Show initial step
    showStep(0);
});
