const express = require('express');
const pool = require('../db');
const { authRequired, adminRequired } = require('../middleware/auth');

const router = express.Router();

// Создание сделки — форма
router.get('/deals/new', authRequired, adminRequired, async (req, res) => {
    try {
        const usersResult = await pool.query(
            'SELECT id, name, email FROM users WHERE is_active = TRUE ORDER BY name'
        );
        res.render('deal-form', {
            user: req.user,
            deal: null,
            users: usersResult.rows,
            error: null,
        });
    } catch (err) {
        console.error('New deal form error:', err);
        res.status(500).send('Ошибка сервера');
    }
});

// Создание сделки — сохранение
router.post('/deals', authRequired, adminRequired, async (req, res) => {
    const { client, department, subject, amount, deadline, initiator_id } = req.body;

    const client2 = await pool.connect();
    try {
        await client2.query('BEGIN');

        const result = await client2.query(
            `INSERT INTO deals (client, department, subject, amount, deadline, initiator_id, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [client, department, subject, amount || null, deadline || null, initiator_id, req.user.id]
        );
        const dealId = result.rows[0].id;

        // Добавляем инициатора в участники
        await client2.query(
            'INSERT INTO deal_participants (deal_id, user_id, role) VALUES ($1, $2, $3)',
            [dealId, initiator_id, 'initiator']
        );

        // Добавляем постоянных согласующих
        await client2.query(
            `INSERT INTO deal_participants (deal_id, user_id, role)
             SELECT $1, pa.user_id, 'approver'
             FROM permanent_approvers pa
             WHERE pa.user_id != $2`,
            [dealId, initiator_id]
        );

        // Аудит
        await client2.query(
            'INSERT INTO audit_log (user_id, deal_id, action, details) VALUES ($1, $2, $3, $4)',
            [req.user.id, dealId, 'deal_created', JSON.stringify({ client, subject })]
        );

        await client2.query('COMMIT');
        res.redirect(`/deals/${dealId}`);
    } catch (err) {
        await client2.query('ROLLBACK');
        console.error('Create deal error:', err);
        res.status(500).send('Ошибка сервера');
    } finally {
        client2.release();
    }
});

// Карточка сделки
router.get('/deals/:id', authRequired, async (req, res) => {
    const { id } = req.params;
    try {
        // Проверка доступа
        if (!req.user.is_admin) {
            const access = await pool.query(
                'SELECT 1 FROM deal_participants WHERE deal_id = $1 AND user_id = $2',
                [id, req.user.id]
            );
            if (access.rows.length === 0) {
                return res.status(403).send('Доступ запрещён');
            }
        }

        const dealResult = await pool.query(
            `SELECT d.*, u.name AS initiator_name, u.email AS initiator_email,
                    c.name AS created_by_name
             FROM deals d
             LEFT JOIN users u ON d.initiator_id = u.id
             LEFT JOIN users c ON d.created_by = c.id
             WHERE d.id = $1`,
            [id]
        );

        if (dealResult.rows.length === 0) {
            return res.status(404).send('Сделка не найдена');
        }

        const deal = dealResult.rows[0];

        // Участники
        const participantsResult = await pool.query(
            `SELECT dp.*, u.name, u.email
             FROM deal_participants dp
             JOIN users u ON dp.user_id = u.id
             WHERE dp.deal_id = $1
             ORDER BY dp.role, u.name`,
            [id]
        );

        // Документы
        const docsResult = await pool.query(
            'SELECT * FROM documents WHERE deal_id = $1 ORDER BY uploaded_at DESC',
            [id]
        );

        // Голоса
        const votesResult = await pool.query(
            `SELECT v.*, u.name, u.email
             FROM votes v
             JOIN users u ON v.user_id = u.id
             WHERE v.deal_id = $1
             ORDER BY v.voted_at DESC`,
            [id]
        );

        // Моя роль
        const myRoleResult = await pool.query(
            'SELECT role FROM deal_participants WHERE deal_id = $1 AND user_id = $2',
            [id, req.user.id]
        );
        const myRole = myRoleResult.rows[0]?.role || (req.user.is_admin ? 'admin' : null);

        // Все активные пользователи (для добавления участников)
        const allUsersResult = await pool.query(
            'SELECT id, name, email FROM users WHERE is_active = TRUE ORDER BY name'
        );

        res.render('deal', {
            user: req.user,
            deal,
            participants: participantsResult.rows,
            documents: docsResult.rows,
            votes: votesResult.rows,
            myRole,
            allUsers: allUsersResult.rows,
        });
    } catch (err) {
        console.error('Deal view error:', err);
        res.status(500).send('Ошибка сервера');
    }
});

// Редактирование сделки — форма
router.get('/deals/:id/edit', authRequired, adminRequired, async (req, res) => {
    try {
        const dealResult = await pool.query('SELECT * FROM deals WHERE id = $1', [req.params.id]);
        if (dealResult.rows.length === 0) return res.status(404).send('Сделка не найдена');

        const deal = dealResult.rows[0];
        if (deal.status === 'closed' || deal.status === 'approved' || deal.status === 'rejected' || deal.status === 'withdrawn') {
            return res.redirect(`/deals/${deal.id}`);
        }

        const usersResult = await pool.query(
            'SELECT id, name, email FROM users WHERE is_active = TRUE ORDER BY name'
        );

        res.render('deal-form', {
            user: req.user,
            deal,
            users: usersResult.rows,
            error: null,
        });
    } catch (err) {
        console.error('Edit deal form error:', err);
        res.status(500).send('Ошибка сервера');
    }
});

// Редактирование сделки — сохранение
router.post('/deals/:id/edit', authRequired, adminRequired, async (req, res) => {
    const { id } = req.params;
    const { client, department, subject, amount, deadline, initiator_id } = req.body;

    const client2 = await pool.connect();
    try {
        await client2.query('BEGIN');

        const oldDeal = await client2.query('SELECT * FROM deals WHERE id = $1', [id]);
        if (oldDeal.rows.length === 0) {
            await client2.query('ROLLBACK');
            return res.status(404).send('Сделка не найдена');
        }

        const old = oldDeal.rows[0];

        await client2.query(
            `UPDATE deals SET client = $1, department = $2, subject = $3, amount = $4, deadline = $5, initiator_id = $6
             WHERE id = $7`,
            [client, department, subject, amount || null, deadline || null, initiator_id, id]
        );

        // Если сменился инициатор — обновляем участников
        if (String(old.initiator_id) !== String(initiator_id)) {
            await client2.query(
                'DELETE FROM deal_participants WHERE deal_id = $1 AND role = $2',
                [id, 'initiator']
            );
            await client2.query(
                'INSERT INTO deal_participants (deal_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
                [id, initiator_id, 'initiator']
            );
        }

        // Аудит
        await client2.query(
            'INSERT INTO audit_log (user_id, deal_id, action, details) VALUES ($1, $2, $3, $4)',
            [req.user.id, id, 'deal_updated', JSON.stringify({ client, subject })]
        );

        await client2.query('COMMIT');
        res.redirect(`/deals/${id}`);
    } catch (err) {
        await client2.query('ROLLBACK');
        console.error('Update deal error:', err);
        res.status(500).send('Ошибка сервера');
    } finally {
        client2.release();
    }
});

// Добавить участника
router.post('/deals/:id/participants', authRequired, adminRequired, async (req, res) => {
    const { id } = req.params;
    const { user_id, role } = req.body;

    try {
        await pool.query(
            'INSERT INTO deal_participants (deal_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
            [id, user_id, role]
        );

        await pool.query(
            'INSERT INTO audit_log (user_id, deal_id, action, details) VALUES ($1, $2, $3, $4)',
            [req.user.id, id, 'participant_added', JSON.stringify({ user_id: Number(user_id), role })]
        );

        res.redirect(`/deals/${id}`);
    } catch (err) {
        console.error('Add participant error:', err);
        res.status(500).send('Ошибка сервера');
    }
});

// Удалить участника
router.post('/deals/:id/participants/:pid/remove', authRequired, adminRequired, async (req, res) => {
    const { id, pid } = req.params;

    try {
        await pool.query('DELETE FROM deal_participants WHERE id = $1 AND deal_id = $2', [pid, id]);

        await pool.query(
            'INSERT INTO audit_log (user_id, deal_id, action, details) VALUES ($1, $2, $3, $4)',
            [req.user.id, id, 'participant_removed', JSON.stringify({ participant_id: Number(pid) })]
        );

        res.redirect(`/deals/${id}`);
    } catch (err) {
        console.error('Remove participant error:', err);
        res.status(500).send('Ошибка сервера');
    }
});

module.exports = router;
