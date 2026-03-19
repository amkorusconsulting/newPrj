require('dotenv').config();
const bcrypt = require('bcrypt');
const pool = require('./db');

async function createAdmin() {
    const email = process.argv[2];
    const name = process.argv[3];
    const password = process.argv[4];

    if (!email || !name || !password) {
        console.log('Использование: node create-admin.js <email> <имя> <пароль>');
        process.exit(1);
    }

    const hash = await bcrypt.hash(password, 10);

    try {
        const result = await pool.query(
            'INSERT INTO users (email, name, password_hash, is_admin) VALUES ($1, $2, $3, TRUE) RETURNING id, email, name',
            [email, name, hash]
        );
        console.log('Администратор создан:', result.rows[0]);
    } catch (err) {
        if (err.code === '23505') {
            console.log('Пользователь с таким email уже существует');
        } else {
            console.error('Ошибка:', err.message);
        }
    }
    process.exit(0);
}

createAdmin();
