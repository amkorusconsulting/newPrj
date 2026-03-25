const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db');

const router = express.Router();

// Rate limiting: 10 попыток за 15 минут по IP
const loginAttempts = new Map();
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;

function checkLoginRate(ip) {
    const now = Date.now();
    const attempts = (loginAttempts.get(ip) || []).filter(t => now - t < WINDOW_MS);
    if (attempts.length >= MAX_ATTEMPTS) return false;
    attempts.push(now);
    loginAttempts.set(ip, attempts);
    enforceMapLimit();
    return true;
}

// Очистка старых записей каждые 15 минут + лимит на размер Map
const MAX_IPS = 10000;
setInterval(() => {
    const now = Date.now();
    for (const [ip, attempts] of loginAttempts) {
        const recent = attempts.filter(t => now - t < WINDOW_MS);
        if (recent.length === 0) loginAttempts.delete(ip);
        else loginAttempts.set(ip, recent);
    }
}, WINDOW_MS);

function enforceMapLimit() {
    if (loginAttempts.size <= MAX_IPS) return;
    const iter = loginAttempts.keys();
    while (loginAttempts.size > MAX_IPS * 0.8) {
        loginAttempts.delete(iter.next().value);
    }
}

router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;

    if (process.env.NODE_ENV !== 'test' && !checkLoginRate(clientIp)) {
        return res.render('login', {
            error: 'Слишком много попыток входа. Попробуйте через 15 минут.',
            redirect: req.body.redirect || '',
        });
    }

    try {
        const result = await pool.query(
            'SELECT id, email, name, password_hash, is_admin, is_active FROM users WHERE email = $1',
            [email]
        );

        if (result.rows.length === 0) {
            return res.render('login', { error: 'Неверный email или пароль', redirect: req.body.redirect || '' });
        }

        const user = result.rows[0];

        if (!user.is_active) {
            return res.render('login', { error: 'Учётная запись деактивирована', redirect: req.body.redirect || '' });
        }

        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) {
            return res.render('login', { error: 'Неверный email или пароль', redirect: req.body.redirect || '' });
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

        const redirectTo = req.body.redirect && req.body.redirect.startsWith('/') ? req.body.redirect : '/dashboard';
        return res.redirect(redirectTo);
    } catch (err) {
        console.error('Login error:', err);
        return res.render('login', { error: 'Ошибка сервера', redirect: req.body.redirect || '' });
    }
});

router.get('/logout', (req, res) => {
    const token = req.cookies && req.cookies.token;
    if (token) {
        const { revokeToken } = require('../middleware/auth');
        revokeToken(token);
    }
    res.clearCookie('token');
    res.redirect('/');
});

module.exports = router;
