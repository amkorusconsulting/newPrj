const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const pool = require('../db');
const { authRequired } = require('../middleware/auth');
const { extractAllTexts } = require('../services/file-parser');

const router = express.Router();

// Rate limiting: 20 requests per minute per user
const rateLimits = new Map();
const RATE_LIMIT = 20;
const RATE_WINDOW = 60 * 1000;

function checkRateLimit(userId) {
    const now = Date.now();
    const userRequests = rateLimits.get(userId) || [];
    const recent = userRequests.filter(t => now - t < RATE_WINDOW);
    if (recent.length >= RATE_LIMIT) return false;
    recent.push(now);
    rateLimits.set(userId, recent);
    return true;
}

router.post('/deals/:id/chat', authRequired, async (req, res) => {
    const dealId = req.params.id;
    const userId = req.user.id;

    // Validate messages
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: 'Сообщения не переданы.' });
    }

    // Check participant access
    const participantCheck = await pool.query(
        'SELECT role FROM deal_participants WHERE deal_id = $1 AND user_id = $2',
        [dealId, userId]
    );
    if (participantCheck.rows.length === 0 && !req.user.is_admin) {
        return res.status(403).json({ error: 'Нет доступа к этой сделке.' });
    }

    // Check API key
    if (!process.env.ANTHROPIC_API_KEY) {
        return res.status(503).json({ error: 'AI-сервис не настроен. Обратитесь к администратору.' });
    }

    // Rate limit
    if (!checkRateLimit(userId)) {
        return res.status(429).json({ error: 'Слишком много запросов. Подождите минуту.' });
    }

    try {
        // Get deal info
        const dealResult = await pool.query(
            `SELECT d.*, u.name as initiator_name
             FROM deals d LEFT JOIN users u ON d.initiator_id = u.id
             WHERE d.id = $1`,
            [dealId]
        );
        if (dealResult.rows.length === 0) {
            return res.status(404).json({ error: 'Сделка не найдена.' });
        }
        const deal = dealResult.rows[0];

        // Get documents and extract texts
        const docsResult = await pool.query(
            'SELECT id, filename, filedata, uploaded_at FROM documents WHERE deal_id = $1 ORDER BY uploaded_at',
            [dealId]
        );
        const docTexts = await extractAllTexts(docsResult.rows);

        // Build system prompt
        let systemPrompt = `Ты — AI-ассистент системы "КОРУС Крупные сделки". Помогаешь анализировать документы сделки и отвечаешь на вопросы по их содержимому.

Данные сделки:
- ID: ${deal.id}
- Клиент: ${deal.client}
- Подразделение: ${deal.department}
- Предмет: ${deal.subject}
- Сумма: ${deal.amount ? Number(deal.amount).toLocaleString('ru-RU') + ' руб.' : 'не указана'}
- Статус: ${deal.status}
- Инициатор: ${deal.initiator_name || 'не указан'}`;

        if (docTexts.length > 0) {
            systemPrompt += '\n\nДокументы сделки:\n';
            for (const dt of docTexts) {
                systemPrompt += `\n=== ${dt.filename} ===\n${dt.text}\n`;
            }
        } else {
            systemPrompt += '\n\nДокументы к сделке не прикреплены или не поддерживаются для анализа.';
        }

        systemPrompt += '\n\nОтвечай на русском языке. Будь точным и конкретным, ссылайся на содержимое документов.';

        // SSE setup
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });

        const client = new Anthropic();
        const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';

        const stream = await client.messages.stream({
            model,
            max_tokens: 4096,
            system: systemPrompt,
            messages: messages.map(m => ({
                role: m.role === 'user' ? 'user' : 'assistant',
                content: m.content,
            })),
        });

        for await (const event of stream) {
            if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
            }
        }

        res.write('data: [DONE]\n\n');
        res.end();
    } catch (err) {
        console.error('Chat error:', err);
        let userError = 'Ошибка AI-сервиса.';
        if (err.status === 400 && err.message && err.message.includes('credit balance')) {
            const orgId = err.headers && err.headers.get ? err.headers.get('anthropic-organization-id') : null;
            userError = 'Недостаточно средств на балансе Anthropic API.' +
                (orgId ? ' Аккаунт: ' + orgId + '.' : '') +
                ' Пополните баланс на console.anthropic.com/settings/billing';
        } else if (err.status === 401) {
            userError = 'Неверный API-ключ Anthropic. Обратитесь к администратору.';
        } else if (err.status === 429) {
            userError = 'Превышен лимит запросов к AI. Попробуйте позже.';
        }
        if (!res.headersSent) {
            return res.status(502).json({ error: userError });
        }
        res.write(`data: ${JSON.stringify({ error: userError })}\n\n`);
        res.end();
    }
});

module.exports = router;
