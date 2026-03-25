const path = require('path');

const MAX_PER_FILE = 50000;
const MAX_TOTAL = 150000;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

const cache = new Map();

function getCacheKey(files) {
    return files.map(f => `${f.id}:${f.uploaded_at}`).sort().join('|');
}

async function extractText(buffer, filename) {
    const ext = path.extname(filename).toLowerCase();

    if (ext === '.txt' || ext === '.csv') {
        return buffer.toString('utf-8');
    }

    if (ext === '.pdf') {
        const pdfParse = require('pdf-parse');
        const data = await pdfParse(buffer);
        return data.text;
    }

    if (ext === '.docx') {
        const mammoth = require('mammoth');
        const result = await mammoth.extractRawText({ buffer });
        return result.value;
    }

    if (ext === '.xlsx' || ext === '.xls') {
        const XLSX = require('xlsx');
        const workbook = XLSX.read(buffer, { type: 'buffer' });
        const texts = [];
        for (const sheetName of workbook.SheetNames) {
            const sheet = workbook.Sheets[sheetName];
            const csv = XLSX.utils.sheet_to_csv(sheet);
            texts.push(`--- ${sheetName} ---\n${csv}`);
        }
        return texts.join('\n\n');
    }

    return null;
}

async function extractAllTexts(documents) {
    const key = getCacheKey(documents);
    const cached = cache.get(key);
    if (cached && Date.now() - cached.time < CACHE_TTL) {
        return cached.result;
    }

    const results = [];
    let totalLength = 0;

    for (const doc of documents) {
        try {
            if (!doc.filedata) continue;

            let text = await extractText(doc.filedata, doc.filename);
            if (!text) continue;

            if (text.length > MAX_PER_FILE) {
                text = text.slice(0, MAX_PER_FILE) + '\n... (текст обрезан)';
            }

            if (totalLength + text.length > MAX_TOTAL) {
                const remaining = MAX_TOTAL - totalLength;
                if (remaining > 500) {
                    text = text.slice(0, remaining) + '\n... (достигнут лимит общего объёма)';
                    results.push({ filename: doc.filename, text });
                }
                break;
            }

            results.push({ filename: doc.filename, text });
            totalLength += text.length;
        } catch (err) {
            console.error(`File parse error [${doc.filename}]:`, err.message);
            results.push({ filename: doc.filename, text: '(не удалось извлечь текст)' });
        }
    }

    const result = results;
    cache.set(key, { result, time: Date.now() });

    // Cleanup old cache entries
    if (cache.size > 100) {
        const now = Date.now();
        for (const [k, v] of cache) {
            if (now - v.time > CACHE_TTL) cache.delete(k);
        }
    }

    return result;
}

module.exports = { extractAllTexts };
