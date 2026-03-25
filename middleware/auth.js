const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// Blacklist отозванных токенов (в памяти, очищается по TTL)
const revokedTokens = new Set();

function revokeToken(token) {
    revokedTokens.add(token);
    // Автоочистка через 8 часов (время жизни токена)
    setTimeout(() => revokedTokens.delete(token), 8 * 60 * 60 * 1000);
}

function authRequired(req, res, next) {
    const token = req.cookies && req.cookies.token;
    if (!token) {
        const returnTo = req.originalUrl !== '/' ? `/?redirect=${encodeURIComponent(req.originalUrl)}` : '/';
        return res.redirect(returnTo);
    }
    if (revokedTokens.has(token)) {
        res.clearCookie('token');
        return res.redirect('/');
    }
    try {
        const user = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
        req.user = user;
        // Запрещаем браузеру кэшировать защищённые страницы
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
        next();
    } catch (err) {
        res.clearCookie('token');
        return res.redirect('/');
    }
}

function adminRequired(req, res, next) {
    if (!req.user || !req.user.is_admin) {
        return res.status(403).send('Доступ запрещён');
    }
    next();
}

// CSRF-защита: токен = HMAC(JWT-токен, секрет)
function generateCsrf(req, res, next) {
    const token = req.cookies && req.cookies.token;
    if (token) {
        res.locals.csrfToken = crypto.createHmac('sha256', process.env.JWT_SECRET)
            .update(token).digest('hex').slice(0, 32);
    }
    next();
}

function verifyCsrf(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (process.env.NODE_ENV === 'test') return next();

    const token = req.cookies && req.cookies.token;
    if (!token) return next(); // authRequired обработает отсутствие сессии

    const expected = crypto.createHmac('sha256', process.env.JWT_SECRET)
        .update(token).digest('hex').slice(0, 32);
    const provided = (req.body && req.body._csrf) || req.headers['x-csrf-token'];

    if (!provided || provided !== expected) {
        return res.status(403).send('Недействительный CSRF-токен. Обновите страницу и попробуйте снова.');
    }
    next();
}

module.exports = { authRequired, adminRequired, revokeToken, generateCsrf, verifyCsrf };
