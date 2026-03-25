const Anthropic = require('@anthropic-ai/sdk');
const pool = require('../db');
const { extractAllTexts } = require('./file-parser');

async function generateOpinion(dealId) {
    if (process.env.NODE_ENV === 'test') return;
    try {
        // Получаем промпт
        const promptResult = await pool.query('SELECT prompt FROM ai_prompt ORDER BY id DESC LIMIT 1');
        if (promptResult.rows.length === 0 || !promptResult.rows[0].prompt) {
            await saveOpinion(dealId, 'Сведения от ИИ не запрашивались: промпт не настроен', null);
            return;
        }
        const adminPrompt = promptResult.rows[0].prompt;

        // Получаем данные сделки
        const dealResult = await pool.query(
            `SELECT d.*, u.name AS initiator_name FROM deals d
             LEFT JOIN users u ON d.initiator_id = u.id WHERE d.id = $1`, [dealId]
        );
        if (dealResult.rows.length === 0) return;
        const deal = dealResult.rows[0];

        // Получаем документы
        const docsResult = await pool.query(
            'SELECT id, filename, filedata, uploaded_at FROM documents WHERE deal_id = $1 ORDER BY uploaded_at',
            [dealId]
        );
        if (docsResult.rows.length === 0) {
            await saveOpinion(dealId, 'Сведения от ИИ не запрашивались: документы не загружены', null);
            return;
        }

        // Извлекаем тексты
        const docTexts = await extractAllTexts(docsResult.rows);
        if (docTexts.length === 0) {
            await saveOpinion(dealId, 'Сведения от ИИ не запрашивались: не удалось извлечь текст из документов', null);
            return;
        }

        // Проверяем API-ключ
        if (!process.env.ANTHROPIC_API_KEY) {
            await saveOpinion(dealId, 'Сведения от ИИ не запрашивались: API-ключ не настроен', null);
            return;
        }

        // Формируем контекст
        let context = `Данные сделки:
- ID: ${deal.id}
- Клиент: ${deal.client}
- Подразделение: ${deal.department}
- Предмет: ${deal.subject}
- Сумма: ${deal.amount ? Number(deal.amount).toLocaleString('ru-RU') + ' руб.' : 'не указана'}
- Инициатор: ${deal.initiator_name || 'не указан'}

Документы сделки:
`;
        for (const dt of docTexts) {
            context += `\n=== ${dt.filename} ===\n${dt.text}\n`;
        }

        const systemPrompt = `${adminPrompt}\n\n${context}`;

        // Вызываем Claude API
        const client = new Anthropic();
        const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';

        const response = await client.messages.create({
            model,
            max_tokens: 4096,
            system: systemPrompt,
            messages: [{ role: 'user', content: 'Проанализируй документы сделки и дай своё экспертное мнение согласно инструкции.' }],
        });

        const opinion = response.content.map(c => c.text).join('\n');
        await saveOpinion(dealId, opinion, model);
    } catch (err) {
        console.error('AI opinion generation error:', err.message);
        const errorMsg = err.status === 400 && err.message?.includes('credit')
            ? 'Сведения от ИИ не запрашивались: недостаточно средств на балансе API'
            : 'Сведения от ИИ не запрашивались: ошибка при обращении к ИИ';
        await saveOpinion(dealId, errorMsg, null);
    }
}

async function saveOpinion(dealId, opinion, model) {
    await pool.query(
        'INSERT INTO ai_opinions (deal_id, opinion, model) VALUES ($1, $2, $3)',
        [dealId, opinion, model]
    );
}

module.exports = { generateOpinion };
