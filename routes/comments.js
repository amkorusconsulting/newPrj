const express = require('express');
const pool = require('../db');
const { authRequired, checkDealAccess } = require('../middleware/auth');

const router = express.Router();

// Добавить комментарий к документу
router.post('/deals/:id/documents/:docId/comments', authRequired, checkDealAccess, async (req, res) => {
    const { id, docId } = req.params;
    const { text } = req.body;

    if (!text || !text.trim()) {
        return res.redirect(`/deals/${id}`);
    }

    try {
        const deal = await pool.query('SELECT status FROM deals WHERE id = $1', [id]);
        if (['closed', 'approved', 'rejected', 'withdrawn'].includes(deal.rows[0].status)) {
            return res.redirect(`/deals/${id}`);
        }

        await pool.query(
            'INSERT INTO comments (document_id, deal_id, user_id, text) VALUES ($1, $2, $3, $4)',
            [docId, id, req.user.id, text.trim()]
        );

        await pool.query(
            'INSERT INTO audit_log (user_id, deal_id, document_id, action, details) VALUES ($1, $2, $3, $4, $5)',
            [req.user.id, id, docId, 'comment_added', JSON.stringify({ text: text.trim().substring(0, 100) })]
        );

        res.redirect(`/deals/${id}`);
    } catch (err) {
        console.error('Add comment error:', err);
        res.status(500).send('Ошибка сервера');
    }
});

// Сводный просмотр всех комментариев по сделке
router.get('/deals/:id/comments', authRequired, checkDealAccess, async (req, res) => {
    const { id } = req.params;

    try {
        const deal = await pool.query('SELECT * FROM deals WHERE id = $1', [id]);
        if (deal.rows.length === 0) return res.status(404).send('Сделка не найдена');

        const comments = await pool.query(
            `SELECT c.*, u.name AS author_name, d.filename AS document_name
             FROM comments c
             JOIN users u ON c.user_id = u.id
             JOIN documents d ON c.document_id = d.id
             WHERE c.deal_id = $1
             ORDER BY c.created_at DESC`,
            [id]
        );

        res.render('comments', {
            user: req.user,
            deal: deal.rows[0],
            comments: comments.rows,
        });
    } catch (err) {
        console.error('Comments view error:', err);
        res.status(500).send('Ошибка сервера');
    }
});

module.exports = router;
