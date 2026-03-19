const jwt = require('jsonwebtoken');

function authRequired(req, res, next) {
    const token = req.cookies && req.cookies.token;
    if (!token) {
        return res.redirect('/');
    }
    try {
        const user = jwt.verify(token, process.env.JWT_SECRET);
        req.user = user;
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

module.exports = { authRequired, adminRequired };
