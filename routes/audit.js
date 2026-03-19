const express = require('express');
const pool = require('../db');
const { authRequired, adminRequired } = require('../middleware/auth');

const router = express.Router();

const ACTION_LABELS = {
    deal_created: 'Создание сделки',
    deal_updated: 'Редактирование сделки',
    deal_started: 'Запуск согласования',
    deal_closed: 'Закрытие сделки',
    deal_withdrawn: 'Отзыв сделки',
    participant_added: 'Добавление участника',
    participant_removed: 'Удаление участника',
    voted: 'Голосование',
    reservation_updated: 'Изменение оговорки',
    all_voted: 'Все проголосовали',
    document_uploaded: 'Загрузка документа',
    document_downloaded: 'Скачивание документа',
    document_deleted: 'Удаление документа',
    comment_added: 'Комментарий',
};

router.get('/audit', authRequired, adminRequired, async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 50;
    const offset = (page - 1) * limit;

    try {
        const countResult = await pool.query('SELECT COUNT(*) FROM audit_log');
        const total = Number(countResult.rows[0].count);
        const totalPages = Math.ceil(total / limit);

        const result = await pool.query(
            `SELECT a.*, u.name AS user_name, d.client AS deal_client
             FROM audit_log a
             LEFT JOIN users u ON a.user_id = u.id
             LEFT JOIN deals d ON a.deal_id = d.id
             ORDER BY a.created_at DESC
             LIMIT $1 OFFSET $2`,
            [limit, offset]
        );

        res.render('audit', {
            user: req.user,
            logs: result.rows,
            actionLabels: ACTION_LABELS,
            page,
            totalPages,
            total,
        });
    } catch (err) {
        console.error('Audit error:', err);
        res.status(500).send('Ошибка сервера');
    }
});

module.exports = router;
