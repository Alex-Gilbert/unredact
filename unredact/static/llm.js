// @ts-check
/** LLM integration — direct browser-to-Anthropic API calls. */

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const SONNET_MODEL = 'claude-sonnet-4-6';
const BATCH_SIZE = 50;

// ---------------------------------------------------------------------------
// Core API call
// ---------------------------------------------------------------------------

/**
 * Call the Anthropic Messages API directly from the browser.
 *
 * @param {string} apiKey
 * @param {string} model
 * @param {Array<{role: string, content: string}>} messages
 * @param {object[]} tools
 * @param {{type: string, name: string}} toolChoice
 * @param {number} [maxTokens=1024]
 * @returns {Promise<object>}
 */
export async function callClaude(apiKey, model, messages, tools, toolChoice, maxTokens = 1024) {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({ model, messages, tools, tool_choice: toolChoice, max_tokens: maxTokens }),
    });
    if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: { message: resp.statusText } }));
        throw new Error(err.error?.message || `API error ${resp.status}`);
    }
    return resp.json();
}

// ---------------------------------------------------------------------------
// Redaction detection
// ---------------------------------------------------------------------------

/** @type {object} */
const REPORT_REDACTIONS_TOOL = {
    name: 'report_redactions',
    description: 'Report redacted sections found in the OCR text.',
    input_schema: {
        type: 'object',
        properties: {
            redactions: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        line_index: { type: 'integer', description: 'Zero-based line index' },
                        left_word: { type: 'string', description: 'Last clean word before redaction. Empty if at line start.' },
                        right_word: { type: 'string', description: 'First clean word after redaction. Empty if at line end.' },
                    },
                    required: ['line_index', 'left_word', 'right_word'],
                },
            },
        },
        required: ['redactions'],
    },
};

/**
 * Build the prompt for redaction detection.
 * @param {Array<{text: string}>} ocrLines
 * @returns {string}
 */
function buildDetectPrompt(ocrLines) {
    const header =
        'You are analyzing OCR output from a scanned legal document. ' +
        'Some parts of the document have been redacted (blacked out). ' +
        'The OCR engine often produces garbled text, brackets, pipes, or ' +
        'random characters where redactions are.\n\n' +
        'Identify each redacted section. For each one, report:\n' +
        '- The zero-based line index\n' +
        '- The last clean word BEFORE the redaction (empty string if ' +
        'redaction is at the start of the line)\n' +
        '- The first clean word AFTER the redaction (empty string if ' +
        'redaction is at the end of the line)\n\n' +
        'OCR lines:\n';

    const lines = ocrLines.map((l, i) => `[${i}] ${l.text}`);
    return header + lines.join('\n');
}

/**
 * Find a word in the OCR char list and return {startX, endX}.
 *
 * @param {{text: string, chars: Array<{text: string, x: number, y: number, w: number, h: number}>}} line
 * @param {string} word
 * @param {number} searchFrom - only consider matches starting at or after this x position
 * @param {boolean} fromRight - if true, return the rightmost match
 * @returns {{startX: number, endX: number}|null}
 */
function findWordInChars(line, word, searchFrom, fromRight) {
    if (!word) return null;

    const text = line.text;
    const chars = line.chars;
    /** @type {{startX: number, endX: number}|null} */
    let best = null;

    let start = 0;
    while (true) {
        const idx = text.indexOf(word, start);
        if (idx === -1) break;

        const charStart = chars[idx];
        const charEnd = chars[idx + word.length - 1];
        const startX = charStart.x;
        const endX = charEnd.x + charEnd.w;

        if (startX >= searchFrom) {
            if (fromRight) {
                best = { startX, endX };
            } else {
                return { startX, endX };
            }
        }

        start = idx + 1;
    }

    return best;
}

/**
 * Map the LLM tool response back to pixel positions using OCR char data.
 *
 * @param {object} toolInput - The input dict from the tool_use content block.
 * @param {Array<{text: string, x: number, y: number, w: number, h: number, chars: Array<{text: string, x: number, y: number, w: number, h: number}>}>} lines
 * @returns {Array<{lineIndex: number, leftWord: string, rightWord: string, leftX: number, rightX: number, lineY: number, lineH: number}>}
 */
function parseDetectResponse(toolInput, lines) {
    const redactions = [];

    for (const item of (toolInput.redactions || [])) {
        const lineIndex = item.line_index;
        const leftWord = item.left_word;
        const rightWord = item.right_word;

        if (lineIndex < 0 || lineIndex >= lines.length) continue;

        const line = lines[lineIndex];

        // Determine leftX: right edge of left_word, or line start
        let leftX;
        if (leftWord) {
            const found = findWordInChars(line, leftWord, 0, false);
            if (!found) continue;
            leftX = found.endX;
        } else {
            leftX = line.x;
        }

        // Determine rightX: left edge of right_word, or line end
        let rightX;
        if (rightWord) {
            const searchAfter = leftWord ? leftX : 0;
            const found = findWordInChars(line, rightWord, searchAfter, false);
            if (!found) continue;
            rightX = found.startX;
        } else {
            rightX = line.x + line.w;
        }

        redactions.push({
            lineIndex,
            leftWord,
            rightWord,
            leftX,
            rightX,
            lineY: line.y,
            lineH: line.h,
        });
    }

    return redactions;
}

/**
 * Detect redactions by sending OCR text to Claude Haiku.
 *
 * @param {Array<{text: string, x: number, y: number, w: number, h: number, chars: Array<{text: string, x: number, y: number, w: number, h: number}>}>} ocrLines
 * @param {string} apiKey
 * @returns {Promise<Array<{lineIndex: number, leftWord: string, rightWord: string, leftX: number, rightX: number, lineY: number, lineH: number}>>}
 */
export async function detectRedactionsLlm(ocrLines, apiKey) {
    if (!ocrLines.length) return [];

    const prompt = buildDetectPrompt(ocrLines);

    const response = await callClaude(
        apiKey,
        HAIKU_MODEL,
        [{ role: 'user', content: prompt }],
        [REPORT_REDACTIONS_TOOL],
        { type: 'tool', name: 'report_redactions' },
        2048,
    );

    for (const block of (response.content || [])) {
        if (block.type === 'tool_use' && block.name === 'report_redactions') {
            return parseDetectResponse(block.input, ocrLines);
        }
    }

    return [];
}

// ---------------------------------------------------------------------------
// Boundary text identification
// ---------------------------------------------------------------------------

/** @type {object} */
const BOUNDARY_TOOL = {
    name: 'report_boundary_text',
    description: 'Report the clean text on each side of a redaction in an OCR line.',
    input_schema: {
        type: 'object',
        properties: {
            left_text: {
                type: 'string',
                description: 'Clean text before the redaction, with OCR artifacts removed. Empty string if redaction is at line start.',
            },
            right_text: {
                type: 'string',
                description: 'Clean text after the redaction, with OCR artifacts removed. Empty string if redaction is at line end.',
            },
        },
        required: ['left_text', 'right_text'],
    },
};

/**
 * Build prompt for single-line boundary text identification.
 *
 * @param {{text: string, chars: Array<{text: string, x: number, y: number, w: number, h: number}>}} line
 * @param {number} boxX
 * @param {number} boxW
 * @returns {string}
 */
function buildBoundaryPrompt(line, boxX, boxW) {
    const leftChars = line.chars.filter(c => c.x + c.w / 2 < boxX);
    const midChars = line.chars.filter(c => c.x + c.w / 2 >= boxX && c.x + c.w / 2 <= boxX + boxW);
    const rightChars = line.chars.filter(c => c.x + c.w / 2 > boxX + boxW);

    const leftRaw = leftChars.map(c => c.text).join('');
    const midRaw = midChars.map(c => c.text).join('');
    const rightRaw = rightChars.map(c => c.text).join('');

    return (
        'You are analyzing a single line of OCR text from a scanned legal document. ' +
        'Part of this line has been redacted (blacked out), which causes the OCR engine ' +
        'to produce garbled characters near the redaction edges.\n\n' +
        `Full OCR line: ${line.text}\n` +
        `Approximate split: LEFT="${leftRaw}" REDACTED="${midRaw}" RIGHT="${rightRaw}"\n\n` +
        'The characters immediately adjacent to the redaction may be misread or truncated ' +
        'by the OCR engine. For example, \'Se\' might actually be \'Sent\' with the \'nt\' ' +
        'lost to redaction artifacts.\n\n' +
        'Return the clean, corrected text that should appear to the left and right of ' +
        'the redaction. Fix any obvious OCR errors near the boundary. Do not include ' +
        'any redaction artifacts (brackets, pipes, random characters). ' +
        'If the redaction is at the start or end of the line, use an empty string ' +
        'for that side.'
    );
}

/**
 * Use LLM to identify clean boundary text around a single redaction.
 * Falls back to center-point character filtering if the API call fails.
 *
 * @param {{text: string, chars: Array<{text: string, x: number, y: number, w: number, h: number}>}} line
 * @param {number} boxX - X pixel position of the redaction box
 * @param {number} boxW - Width of the redaction box in pixels
 * @param {string} apiKey
 * @returns {Promise<{leftText: string, rightText: string}>}
 */
export async function identifyBoundaryText(line, boxX, boxW, apiKey) {
    // Fallback: center-point character filtering
    function fallback() {
        const left = line.chars.filter(c => c.x + c.w / 2 < boxX);
        const right = line.chars.filter(c => c.x + c.w / 2 > boxX + boxW);
        return {
            leftText: left.map(c => c.text).join('').trim(),
            rightText: right.map(c => c.text).join('').trim(),
        };
    }

    try {
        const prompt = buildBoundaryPrompt(line, boxX, boxW);

        const response = await callClaude(
            apiKey,
            HAIKU_MODEL,
            [{ role: 'user', content: prompt }],
            [BOUNDARY_TOOL],
            { type: 'tool', name: 'report_boundary_text' },
            512,
        );

        for (const block of (response.content || [])) {
            if (block.type === 'tool_use' && block.name === 'report_boundary_text') {
                return {
                    leftText: (block.input.left_text || '').trim(),
                    rightText: (block.input.right_text || '').trim(),
                };
            }
        }

        return fallback();
    } catch (_err) {
        return fallback();
    }
}

// ---------------------------------------------------------------------------
// Candidate validation / scoring
// ---------------------------------------------------------------------------

/** @type {object} */
const SCORE_TOOL = {
    name: 'score_candidates',
    description: 'Score each candidate word on how well it fits the redacted gap contextually.',
    input_schema: {
        type: 'object',
        properties: {
            scores: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        index: { type: 'integer', description: '1-based index of the candidate in the list.' },
                        score: { type: 'integer', description: 'Contextual fit score from 0-100.', minimum: 0, maximum: 100 },
                    },
                    required: ['index', 'score'],
                },
            },
        },
        required: ['scores'],
    },
};

/**
 * Build the prompt for LLM validation of solve candidates.
 *
 * @param {string} leftContext
 * @param {string} rightContext
 * @param {string[]} candidates
 * @returns {string}
 */
function buildValidationPrompt(leftContext, rightContext, candidates) {
    const numbered = candidates.map((c, i) => `${i + 1}. ${c}`).join('\n');
    return (
        'You are analyzing a redacted document. A word or phrase has been ' +
        'blacked out. The original sentence reads:\n\n' +
        `"${leftContext} _____ ${rightContext}"\n\n` +
        'For each candidate below, mentally substitute it into the blank and ' +
        'evaluate: Does the resulting sentence read naturally? Is it ' +
        'grammatically correct? Does it make sense?\n\n' +
        'Score each candidate 0-100 based on whether it produces a ' +
        'coherent sentence:\n' +
        '- 80-100: The sentence reads naturally and makes sense\n' +
        '- 50-79: Grammatically acceptable but slightly awkward or unusual\n' +
        '- 20-49: Grammatically questionable or semantically odd\n' +
        '- 0-19: Ungrammatical, nonsensical, or wrong part of speech\n\n' +
        `Candidates:\n${numbered}`
    );
}

/**
 * Score a single batch of candidates. Returns scores in same order.
 *
 * @param {string} apiKey
 * @param {string} leftContext
 * @param {string} rightContext
 * @param {string[]} candidates
 * @returns {Promise<number[]>}
 */
async function scoreBatch(apiKey, leftContext, rightContext, candidates) {
    const prompt = buildValidationPrompt(leftContext, rightContext, candidates);

    const response = await callClaude(
        apiKey,
        SONNET_MODEL,
        [{ role: 'user', content: prompt }],
        [SCORE_TOOL],
        { type: 'tool', name: 'score_candidates' },
        16384,
    );

    const scores = new Array(candidates.length).fill(0);

    for (const block of (response.content || [])) {
        if (block.type === 'tool_use' && block.name === 'score_candidates') {
            for (const item of (block.input.scores || [])) {
                const idx = (item.index || 0) - 1; // 1-based to 0-based
                const score = item.score || 0;
                if (idx >= 0 && idx < candidates.length) {
                    scores[idx] = score;
                }
            }
            break;
        }
    }

    return scores;
}

/**
 * Score candidates using LLM. Returns list of scores in same order as candidates.
 * Batches candidates into groups of 50 to stay within output token limits.
 *
 * @param {string} leftContext
 * @param {string} rightContext
 * @param {string[]} candidates
 * @param {string} apiKey
 * @param {((scored: number, total: number) => void)} [onProgress]
 * @returns {Promise<number[]>}
 */
export async function validateCandidates(leftContext, rightContext, candidates, apiKey, onProgress) {
    if (!candidates.length) return [];

    const scores = new Array(candidates.length).fill(0);
    const totalBatches = Math.ceil(candidates.length / BATCH_SIZE);

    for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
        const start = batchIdx * BATCH_SIZE;
        const end = Math.min(start + BATCH_SIZE, candidates.length);
        const batch = candidates.slice(start, end);

        const batchScores = await scoreBatch(apiKey, leftContext, rightContext, batch);

        for (let i = 0; i < batchScores.length; i++) {
            scores[start + i] = batchScores[i];
        }

        if (onProgress) {
            onProgress(end, candidates.length);
        }
    }

    return scores;
}
