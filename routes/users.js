const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../db');
const { authRequired, adminRequired } = require('../middleware/auth');

const router = express.Router();

// Список пользователей
router.get('/users', authRequired, adminRequired, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT u.*,
                    EXISTS(SELECT 1 FROM permanent_approvers pa WHERE pa.user_id = u.id) AS is_permanent_approver
             FROM users u ORDER BY u.created_at DESC`
        );
        res.render('users', { user: req.user, users: result.rows, error: null, success: null });
    } catch (err) {
        console.error('Users list error:', err);
        res.status(500).send('Ошибка сервера');
    }
});

// Создание пользователя
router.post('/users', authRequired, adminRequired, async (req, res) => {
    const { email, name, password, is_admin } = req.body;

    try {
        const hash = await bcrypt.hash(password, 10);
        await pool.query(
            'INSERT INTO users (email, name, password_hash, is_admin) VALUES ($1, $2, $3, $4)',
            [email, name, hash, is_admin === 'on']
        );

        const result = await pool.query(
            `SELECT u.*,
                    EXISTS(SELECT 1 FROM permanent_approvers pa WHERE pa.user_id = u.id) AS is_permanent_approver
             FROM users u ORDER BY u.created_at DESC`
        );
        res.render('users', { user: req.user, users: result.rows, error: null, success: `Пользователь ${name} создан` });
    } catch (err) {
        if (err.code === '23505') {
            const result = await pool.query(
                `SELECT u.*,
                        EXISTS(SELECT 1 FROM permanent_approvers pa WHERE pa.user_id = u.id) AS is_permanent_approver
                 FROM users u ORDER BY u.created_at DESC`
            );
            return res.render('users', { user: req.user, users: result.rows, error: 'Пользователь с таким email уже существует', success: null });
        }
        console.error('Create user error:', err);
        res.status(500).send('Ошибка сервера');
    }
});

// Включение/отключение пользователя
router.post('/users/:id/toggle', authRequired, adminRequired, async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('UPDATE users SET is_active = NOT is_active WHERE id = $1', [id]);
        res.redirect('/users');
    } catch (err) {
        console.error('Toggle user error:', err);
        res.status(500).send('Ошибка сервера');
    }
});

// Добавить в постоянную группу согласующих
router.post('/users/:id/approver/add', authRequired, adminRequired, async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query(
            'INSERT INTO permanent_approvers (user_id) VALUES ($1) ON CONFLICT DO NOTHING',
            [id]
        );
        res.redirect('/users');
    } catch (err) {
        console.error('Add approver error:', err);
        res.status(500).send('Ошибка сервера');
    }
});

// Убрать из постоянной группы согласующих
router.post('/users/:id/approver/remove', authRequired, adminRequired, async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM permanent_approvers WHERE user_id = $1', [id]);
        res.redirect('/users');
    } catch (err) {
        console.error('Remove approver error:', err);
        res.status(500).send('Ошибка сервера');
    }
});

module.exports = router;
