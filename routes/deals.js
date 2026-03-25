const express = require('express');
const crypto = require('crypto');
const pool = require('../db');
const { authRequired, adminRequired, checkDealAccess } = require('../middleware/auth');
const { notifyApprovalStarted, notifyDealClosed, notifyDealWithdrawn } = require('../services/mailer');
const { generateOpinion } = require('../services/ai-opinion');

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

// Собрать deadline из даты и времени
function buildDeadline(date, time) {
    if (!date) return null;
    const t = time || '23:59';
    return `${date}T${t}`;
}

// Создание сделки — сохранение
router.post('/deals', authRequired, adminRequired, async (req, res) => {
    const { client, department, subject, amount, deadline_date, deadline_time, initiator_id } = req.body;
    const deadline = buildDeadline(deadline_date, deadline_time);

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
router.get('/deals/:id', authRequired, checkDealAccess, async (req, res) => {
    const { id } = req.params;
    try {
        const [dealResult, participantsResult, docsResult, commentsResult, votesResult, myRoleResult, allUsersResult, aiOpinionResult] = await Promise.all([
            pool.query(
                `SELECT d.*, u.name AS initiator_name, u.email AS initiator_email,
                        c.name AS created_by_name
                 FROM deals d
                 LEFT JOIN users u ON d.initiator_id = u.id
                 LEFT JOIN users c ON d.created_by = c.id
                 WHERE d.id = $1`, [id]
            ),
            pool.query(
                `SELECT dp.*, u.name, u.email
                 FROM deal_participants dp
                 JOIN users u ON dp.user_id = u.id
                 WHERE dp.deal_id = $1
                 ORDER BY dp.role, u.name`, [id]
            ),
            pool.query('SELECT * FROM documents WHERE deal_id = $1 ORDER BY uploaded_at DESC', [id]),
            pool.query(
                `SELECT c.*, u.name AS author_name
                 FROM comments c
                 JOIN users u ON c.user_id = u.id
                 WHERE c.deal_id = $1
                 ORDER BY c.created_at ASC`, [id]
            ),
            pool.query(
                `SELECT v.*, u.name, u.email
                 FROM votes v
                 JOIN users u ON v.user_id = u.id
                 WHERE v.deal_id = $1
                 ORDER BY v.voted_at DESC`, [id]
            ),
            pool.query('SELECT role FROM deal_participants WHERE deal_id = $1 AND user_id = $2', [id, req.user.id]),
            pool.query('SELECT id, name, email FROM users WHERE is_active = TRUE ORDER BY name'),
            pool.query('SELECT * FROM ai_opinions WHERE deal_id = $1 ORDER BY created_at DESC LIMIT 1', [id]),
        ]);

        if (dealResult.rows.length === 0) {
            return res.status(404).send('Сделка не найдена');
        }

        const commentsByDoc = {};
        commentsResult.rows.forEach(c => {
            if (!commentsByDoc[c.document_id]) commentsByDoc[c.document_id] = [];
            commentsByDoc[c.document_id].push(c);
        });

        res.render('deal', {
            user: req.user,
            deal: dealResult.rows[0],
            participants: participantsResult.rows,
            documents: docsResult.rows,
            votes: votesResult.rows,
            myRole: myRoleResult.rows[0]?.role || (req.user.is_admin ? 'admin' : null),
            allUsers: allUsersResult.rows,
            commentsByDoc,
            aiOpinion: aiOpinionResult.rows[0] || null,
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
    const { client, department, subject, amount, deadline_date, deadline_time, initiator_id } = req.body;
    const deadline = buildDeadline(deadline_date, deadline_time);

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
        // Если назначаем нового инициатора — убираем старого
        if (role === 'initiator') {
            await pool.query(
                "DELETE FROM deal_participants WHERE deal_id = $1 AND role = 'initiator'",
                [id]
            );
            await pool.query(
                'UPDATE deals SET initiator_id = $1 WHERE id = $2',
                [user_id, id]
            );
        }

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
        // Проверяем, удаляем ли инициатора
        const part = await pool.query('SELECT role, user_id FROM deal_participants WHERE id = $1 AND deal_id = $2', [pid, id]);
        if (part.rows.length > 0 && part.rows[0].role === 'initiator') {
            await pool.query('UPDATE deals SET initiator_id = NULL WHERE id = $1', [id]);
        }

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

// Повторная отправка письма участнику
router.post('/deals/:id/participants/:userId/resend', authRequired, adminRequired, async (req, res) => {
    const { id, userId } = req.params;

    try {
        const dealResult = await pool.query(
            `SELECT d.*, u.name AS initiator_name FROM deals d
             LEFT JOIN users u ON d.initiator_id = u.id WHERE d.id = $1`,
            [id]
        );
        if (dealResult.rows.length === 0) return res.status(404).send('Сделка не найдена');
        const deal = dealResult.rows[0];
        if (deal.status !== 'active') return res.redirect(`/deals/${id}`);

        const userResult = await pool.query(
            'SELECT u.id AS user_id, u.email, u.name FROM users u WHERE u.id = $1',
            [userId]
        );
        if (userResult.rows.length === 0) return res.status(404).send('Пользователь не найден');
        const recipient = userResult.rows[0];

        // Проверяем роль — не отправляем инициатору
        const partResult = await pool.query(
            'SELECT role FROM deal_participants WHERE deal_id = $1 AND user_id = $2',
            [id, userId]
        );
        if (partResult.rows.length === 0 || partResult.rows[0].role === 'initiator') {
            return res.redirect(`/deals/${id}`);
        }

        const role = partResult.rows[0].role;
        const isApprover = ['approver', 'invited_approver'].includes(role);

        // Для согласующих — генерируем новую magic-ссылку
        if (isApprover) {
            const token = crypto.randomBytes(32).toString('hex');
            const defaultExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
            const expiresAt = deal.deadline && new Date(deal.deadline) < defaultExpiry
                ? new Date(deal.deadline)
                : defaultExpiry;
            await pool.query(
                'INSERT INTO magic_links (deal_id, user_id, token, expires_at) VALUES ($1, $2, $3, $4)',
                [id, userId, token, expiresAt]
            );
            recipient.magic_token = token;
        }

        notifyApprovalStarted(deal, [recipient]);

        res.redirect(`/deals/${id}`);
    } catch (err) {
        console.error('Resend email error:', err);
        res.status(500).send('Ошибка сервера');
    }
});

// Общая логика: проверка авто-согласования внутри транзакции
async function checkAutoApproval(client, dealId) {
    const counts = await client.query(
        `SELECT
            (SELECT COUNT(*) FROM deal_participants WHERE deal_id = $1 AND role IN ('approver', 'invited_approver')) AS approvers,
            (SELECT COUNT(*) FROM votes WHERE deal_id = $1) AS votes,
            (SELECT COUNT(*) FROM votes WHERE deal_id = $1 AND decision = 'reject') AS rejects`,
        [dealId]
    );
    const { approvers, votes, rejects } = counts.rows[0];
    if (Number(votes) < Number(approvers)) return;

    await client.query(
        'INSERT INTO audit_log (deal_id, action, details) VALUES ($1, $2, $3)',
        [dealId, 'all_voted', JSON.stringify({ total: Number(votes) })]
    );

    if (Number(rejects) === 0) {
        await client.query(
            "UPDATE deals SET status = 'approved', close_comment = 'Автоматическое согласование: все участники проголосовали «за»', closed_at = NOW() WHERE id = $1",
            [dealId]
        );
        await client.query(
            'INSERT INTO audit_log (deal_id, action, details) VALUES ($1, $2, $3)',
            [dealId, 'deal_auto_approved', JSON.stringify({ total_approvals: Number(votes) })]
        );

        // Email всем участникам (вне транзакции — не критично)
        const dealFull = await client.query(
            `SELECT d.*, u.name AS initiator_name FROM deals d
             LEFT JOIN users u ON d.initiator_id = u.id WHERE d.id = $1`, [dealId]
        );
        const allParticipants = await client.query(
            `SELECT u.email, u.name FROM deal_participants dp
             JOIN users u ON dp.user_id = u.id WHERE dp.deal_id = $1`, [dealId]
        );
        notifyDealClosed(dealFull.rows[0], allParticipants.rows, 'Согласовано',
            'Автоматическое согласование: все участники проголосовали «за»');
    }
}

// Голосование
router.post('/deals/:id/vote', authRequired, async (req, res) => {
    const { id } = req.params;
    const { decision, comment, reservation } = req.body;

    if (!['approve', 'reject'].includes(decision)) {
        return res.status(400).send('Некорректное значение решения');
    }

    if (decision === 'reject' && (!comment || !comment.trim())) {
        return res.redirect(`/deals/${id}?error=reject_needs_comment`);
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const dealResult = await client.query('SELECT status FROM deals WHERE id = $1 FOR UPDATE', [id]);
        if (dealResult.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).send('Сделка не найдена'); }
        if (dealResult.rows[0].status !== 'active') { await client.query('ROLLBACK'); return res.redirect(`/deals/${id}`); }

        const partResult = await client.query(
            "SELECT 1 FROM deal_participants WHERE deal_id = $1 AND user_id = $2 AND role IN ('approver', 'invited_approver')",
            [id, req.user.id]
        );
        if (partResult.rows.length === 0) { await client.query('ROLLBACK'); return res.status(403).send('Вы не являетесь согласующим по этой сделке'); }

        const existingVote = await client.query('SELECT 1 FROM votes WHERE deal_id = $1 AND user_id = $2', [id, req.user.id]);
        if (existingVote.rows.length > 0) { await client.query('ROLLBACK'); return res.redirect(`/deals/${id}`); }

        await client.query(
            'INSERT INTO votes (deal_id, user_id, decision, comment, reservation) VALUES ($1, $2, $3, $4, $5)',
            [id, req.user.id, decision, comment || null, reservation || null]
        );
        await client.query(
            'INSERT INTO audit_log (user_id, deal_id, action, details) VALUES ($1, $2, $3, $4)',
            [req.user.id, id, 'voted', JSON.stringify({ decision })]
        );

        await checkAutoApproval(client, id);
        await client.query('COMMIT');

        res.redirect(`/deals/${id}`);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Vote error:', err);
        res.status(500).send('Ошибка сервера');
    } finally {
        client.release();
    }
});

// Добавить/изменить оговорку к решению
router.post('/deals/:id/reservation', authRequired, async (req, res) => {
    const { id } = req.params;
    const { reservation } = req.body;

    try {
        const result = await pool.query(
            'UPDATE votes SET reservation = $1 WHERE deal_id = $2 AND user_id = $3 RETURNING id',
            [reservation || null, id, req.user.id]
        );

        if (result.rows.length > 0) {
            await pool.query(
                'INSERT INTO audit_log (user_id, deal_id, action, details) VALUES ($1, $2, $3, $4)',
                [req.user.id, id, 'reservation_updated', JSON.stringify({ reservation })]
            );
        }

        res.redirect(`/deals/${id}`);
    } catch (err) {
        console.error('Reservation error:', err);
        res.status(500).send('Ошибка сервера');
    }
});

// Запуск согласования (инициатор)
router.post('/deals/:id/start', authRequired, async (req, res) => {
    const { id } = req.params;

    try {
        const dealResult = await pool.query('SELECT * FROM deals WHERE id = $1', [id]);
        if (dealResult.rows.length === 0) return res.status(404).send('Сделка не найдена');

        const deal = dealResult.rows[0];
        if (deal.status !== 'draft') return res.redirect(`/deals/${id}`);

        // Только инициатор или админ
        if (String(deal.initiator_id) !== String(req.user.id) && !req.user.is_admin) {
            return res.status(403).send('Только инициатор может запустить согласование');
        }

        await pool.query("UPDATE deals SET status = 'active' WHERE id = $1", [id]);

        await pool.query(
            'INSERT INTO audit_log (user_id, deal_id, action) VALUES ($1, $2, $3)',
            [req.user.id, id, 'deal_started']
        );

        // Генерация мнения ИИ (асинхронно, не блокирует ответ)
        generateOpinion(id);

        // Email согласующим с magic-ссылками
        const approversResult = await pool.query(
            `SELECT u.id AS user_id, u.email, u.name FROM deal_participants dp
             JOIN users u ON dp.user_id = u.id
             WHERE dp.deal_id = $1 AND dp.role IN ('approver', 'invited_approver')`,
            [id]
        );
        const initiatorResult = await pool.query('SELECT name FROM users WHERE id = $1', [deal.initiator_id]);
        deal.initiator_name = initiatorResult.rows[0]?.name || null;

        // Генерируем magic links для каждого согласующего
        const approversWithLinks = [];
        for (const approver of approversResult.rows) {
            const token = crypto.randomBytes(32).toString('hex');
            const defaultExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
            const expiresAt = deal.deadline && new Date(deal.deadline) < defaultExpiry
                ? new Date(deal.deadline)
                : defaultExpiry;
            await pool.query(
                'INSERT INTO magic_links (deal_id, user_id, token, expires_at) VALUES ($1, $2, $3, $4)',
                [id, approver.user_id, token, expiresAt]
            );
            approversWithLinks.push({ ...approver, magic_token: token });
        }
        notifyApprovalStarted(deal, approversWithLinks);

        res.redirect(`/deals/${id}`);
    } catch (err) {
        console.error('Start deal error:', err);
        res.status(500).send('Ошибка сервера');
    }
});

// Отзыв сделки (инициатор)
router.post('/deals/:id/withdraw', authRequired, async (req, res) => {
    const { id } = req.params;
    const { comment } = req.body;

    try {
        const dealResult = await pool.query('SELECT * FROM deals WHERE id = $1', [id]);
        if (dealResult.rows.length === 0) return res.status(404).send('Сделка не найдена');

        const deal = dealResult.rows[0];
        if (['closed', 'approved', 'rejected', 'withdrawn'].includes(deal.status)) {
            return res.redirect(`/deals/${id}`);
        }

        if (String(deal.initiator_id) !== String(req.user.id) && !req.user.is_admin) {
            return res.status(403).send('Доступ запрещён');
        }

        if (!comment || !comment.trim()) {
            return res.redirect(`/deals/${id}?error=withdraw_needs_comment`);
        }

        await pool.query(
            "UPDATE deals SET status = 'withdrawn', close_comment = $1, closed_at = NOW() WHERE id = $2",
            [comment, id]
        );

        await pool.query(
            'INSERT INTO audit_log (user_id, deal_id, action, details) VALUES ($1, $2, $3, $4)',
            [req.user.id, id, 'deal_withdrawn', JSON.stringify({ comment })]
        );

        // Email всем участникам
        const initiatorResult = await pool.query('SELECT name FROM users WHERE id = $1', [deal.initiator_id]);
        deal.initiator_name = initiatorResult.rows[0]?.name || null;
        const participants = await pool.query(
            `SELECT u.email, u.name FROM deal_participants dp
             JOIN users u ON dp.user_id = u.id WHERE dp.deal_id = $1`, [id]
        );
        notifyDealWithdrawn(deal, participants.rows, comment);

        res.redirect(`/deals/${id}`);
    } catch (err) {
        console.error('Withdraw error:', err);
        res.status(500).send('Ошибка сервера');
    }
});

// Итоговый статус (администратор)
router.post('/deals/:id/close', authRequired, adminRequired, async (req, res) => {
    const { id } = req.params;
    const { final_status, comment } = req.body;

    try {
        if (!['approved', 'rejected'].includes(final_status)) {
            return res.status(400).send('Некорректный статус');
        }

        const dealCheck = await pool.query('SELECT status FROM deals WHERE id = $1', [id]);
        if (dealCheck.rows.length === 0) return res.status(404).send('Сделка не найдена');
        if (['closed', 'approved', 'rejected', 'withdrawn'].includes(dealCheck.rows[0].status)) {
            return res.redirect(`/deals/${id}`);
        }

        await pool.query(
            'UPDATE deals SET status = $1, close_comment = $2, closed_at = NOW() WHERE id = $3',
            [final_status, comment || null, id]
        );

        await pool.query(
            'INSERT INTO audit_log (user_id, deal_id, action, details) VALUES ($1, $2, $3, $4)',
            [req.user.id, id, 'deal_closed', JSON.stringify({ final_status, comment })]
        );

        // Email всем участникам
        const dealFull = await pool.query(
            `SELECT d.*, u.name AS initiator_name FROM deals d
             LEFT JOIN users u ON d.initiator_id = u.id WHERE d.id = $1`, [id]
        );
        const participants = await pool.query(
            `SELECT u.email, u.name FROM deal_participants dp
             JOIN users u ON dp.user_id = u.id WHERE dp.deal_id = $1`, [id]
        );
        const statusText = final_status === 'approved' ? 'Согласовано' : 'Не согласовано';
        notifyDealClosed(dealFull.rows[0], participants.rows, statusText, comment);

        res.redirect(`/deals/${id}`);
    } catch (err) {
        console.error('Close deal error:', err);
        res.status(500).send('Ошибка сервера');
    }
});

// Голосование по magic-ссылке из email (approve без логина)
router.get('/vote/:token', async (req, res) => {
    const { token } = req.params;

    try {
        const linkResult = await pool.query('SELECT * FROM magic_links WHERE token = $1', [token]);
        if (linkResult.rows.length === 0) return res.status(404).send('Ссылка не найдена');

        const link = linkResult.rows[0];
        if (link.used) return res.redirect(`/deals/${link.deal_id}`);
        if (new Date(link.expires_at) < new Date()) {
            return res.status(410).send('Ссылка истекла. Войдите в систему для голосования.');
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const dealResult = await client.query('SELECT status FROM deals WHERE id = $1 FOR UPDATE', [link.deal_id]);
            if (dealResult.rows.length === 0 || dealResult.rows[0].status !== 'active') {
                await client.query('ROLLBACK');
                return res.redirect(`/deals/${link.deal_id}`);
            }

            const existingVote = await client.query('SELECT 1 FROM votes WHERE deal_id = $1 AND user_id = $2', [link.deal_id, link.user_id]);
            if (existingVote.rows.length > 0) {
                await client.query('UPDATE magic_links SET used = TRUE WHERE id = $1', [link.id]);
                await client.query('COMMIT');
                return res.redirect(`/deals/${link.deal_id}`);
            }

            await client.query(
                'INSERT INTO votes (deal_id, user_id, decision, comment) VALUES ($1, $2, $3, $4)',
                [link.deal_id, link.user_id, 'approve', 'Согласовано по ссылке из email']
            );
            await client.query('UPDATE magic_links SET used = TRUE WHERE id = $1', [link.id]);
            await client.query(
                'INSERT INTO audit_log (user_id, deal_id, action, details) VALUES ($1, $2, $3, $4)',
                [link.user_id, link.deal_id, 'voted', JSON.stringify({ decision: 'approve', via: 'magic_link' })]
            );

            await checkAutoApproval(client, link.deal_id);
            await client.query('COMMIT');

            res.redirect(`/deals/${link.deal_id}`);
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('Magic link vote error:', err);
        res.status(500).send('Ошибка сервера');
    }
});

module.exports = router;
