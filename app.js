require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const path = require('path');

const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const usersRoutes = require('./routes/users');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(helmet({
    hsts: false,
    contentSecurityPolicy: {
        directives: {
            ...helmet.contentSecurityPolicy.getDefaultDirectives(),
            'upgrade-insecure-requests': null,
        },
    },
}));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

app.get('/', (req, res) => {
    res.render('login', { error: null });
});

app.use(authRoutes);
app.use(dashboardRoutes);
app.use(usersRoutes);

module.exports = app;
