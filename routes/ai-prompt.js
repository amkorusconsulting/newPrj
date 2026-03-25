const express = require('express');
const pool = require('../db');
const { authRequired, adminRequired } = require('../middleware/auth');

const router = express.Router();

// Страница редактирования промпта
router.get('/ai-prompt', authRequired, adminRequired, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM ai_prompt ORDER BY id DESC LIMIT 1');
        const prompt = result.rows[0] || null;
        res.render('ai-prompt', { user: req.user, prompt, success: null });
    } catch (err) {
        console.error('AI prompt page error:', err);
        res.status(500).send('Ошибка сервера');
    }
});

// Сохранение промпта
router.post('/ai-prompt', authRequired, adminRequired, async (req, res) => {
    const { prompt } = req.body;

    if (!prompt || !prompt.trim()) {
        const result = await pool.query('SELECT * FROM ai_prompt ORDER BY id DESC LIMIT 1');
        return res.render('ai-prompt', { user: req.user, prompt: result.rows[0] || null, success: null });
    }

    try {
        const existing = await pool.query('SELECT id FROM ai_prompt ORDER BY id DESC LIMIT 1');
        if (existing.rows.length > 0) {
            await pool.query(
                'UPDATE ai_prompt SET prompt = $1, updated_by = $2, updated_at = NOW() WHERE id = $3',
                [prompt.trim(), req.user.id, existing.rows[0].id]
            );
        } else {
            await pool.query(
                'INSERT INTO ai_prompt (prompt, updated_by) VALUES ($1, $2)',
                [prompt.trim(), req.user.id]
            );
        }

        const result = await pool.query('SELECT * FROM ai_prompt ORDER BY id DESC LIMIT 1');
        res.render('ai-prompt', { user: req.user, prompt: result.rows[0], success: 'Промпт сохранён' });
    } catch (err) {
        console.error('AI prompt save error:', err);
        res.status(500).send('Ошибка сервера');
    }
});

module.exports = router;
