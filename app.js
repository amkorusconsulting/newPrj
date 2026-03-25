require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const path = require('path');

const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const usersRoutes = require('./routes/users');
const dealsRoutes = require('./routes/deals');
const documentsRoutes = require('./routes/documents');
const commentsRoutes = require('./routes/comments');
const auditRoutes = require('./routes/audit');
const chatRoutes = require('./routes/chat');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(helmet({
    hsts: false,
    contentSecurityPolicy: {
        directives: {
            ...helmet.contentSecurityPolicy.getDefaultDirectives(),
            'upgrade-insecure-requests': null,
            'script-src': ["'self'", "'unsafe-inline'"],
            'script-src-attr': null,
            'connect-src': ["'self'"],
        },
    },
}));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

const { generateCsrf, verifyCsrf } = require('./middleware/auth');
app.use(generateCsrf);
app.use(verifyCsrf);

app.get('/', (req, res) => {
    res.render('login', { error: null, redirect: req.query.redirect || '' });
});

app.get('/robots.txt', (req, res) => {
    res.type('text/plain');
    res.send('User-agent: *\nDisallow: /');
});

// Инструкция пользователя (только для авторизованных)
const { authRequired } = require('./middleware/auth');
const fs = require('fs');
app.get('/guide', authRequired, (req, res) => {
    const guidePath = path.join(__dirname, 'docs-myPrj', 'korus-spr-user-guide-branded.html');
    if (!fs.existsSync(guidePath)) return res.status(404).send('Инструкция не найдена');
    res.set('Cache-Control', 'no-store');
    res.type('html').send(fs.readFileSync(guidePath, 'utf8'));
});

app.use(authRoutes);
app.use(dashboardRoutes);
app.use(usersRoutes);
app.use(dealsRoutes);
app.use(documentsRoutes);
app.use(commentsRoutes);
app.use(auditRoutes);
app.use(chatRoutes);

// 404
app.use((req, res) => {
    res.status(404).render('error', {
        status: 404,
        title: 'Страница не найдена',
        message: 'Запрошенная страница не существует или была удалена.',
    });
});

// 500
app.use((err, req, res, _next) => {
    console.error('Unhandled error:', err);
    res.status(500).render('error', {
        status: 500,
        title: 'Ошибка сервера',
        message: 'Произошла внутренняя ошибка. Попробуйте позже или обратитесь к администратору.',
    });
});

module.exports = app;
