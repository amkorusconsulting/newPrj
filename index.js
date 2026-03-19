require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get('/', (req, res) => {
    res.render('login');
});

app.post('/login', (req, res) => {
    const { email, password } = req.body;
    // TODO: реальная авторизация
    res.send('Авторизация в разработке');
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Корус СПР запущен: http://0.0.0.0:${PORT}`);
});
