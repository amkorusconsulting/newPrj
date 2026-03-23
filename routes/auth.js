const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db');

const router = express.Router();

router.post('/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        const result = await pool.query(
            'SELECT id, email, name, password_hash, is_admin, is_active FROM users WHERE email = $1',
            [email]
        );

        if (result.rows.length === 0) {
            return res.render('login', { error: 'Неверный email или пароль' });
        }

        const user = result.rows[0];

        if (!user.is_active) {
            return res.render('login', { error: 'Учётная запись деактивирована' });
        }

        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) {
            return res.render('login', { error: 'Неверный email или пароль' });
        }

        const token = jwt.sign(
            { id: user.id, email: user.email, name: user.name, is_admin: user.is_admin },
            process.env.JWT_SECRET,
            { expiresIn: '8h' }
        );

        res.cookie('token', token, {
            httpOnly: true,
            sameSite: 'lax',
            maxAge: 8 * 60 * 60 * 1000,
        });

        return res.redirect('/dashboard');
    } catch (err) {
        console.error('Login error:', err);
        return res.render('login', { error: 'Ошибка сервера' });
    }
});

router.get('/logout', (req, res) => {
    res.clearCookie('token');
    res.redirect('/');
});

module.exports = router;
