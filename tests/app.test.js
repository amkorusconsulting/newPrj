const request = require('supertest');
const bcrypt = require('bcrypt');
const app = require('../app');
const pool = require('../db');

// Тестовый пользователь
const testEmail = 'test-runner@test.com';
const testPassword = 'TestPass123';
let testUserId;

beforeAll(async () => {
    // Создаём тестового пользователя
    const hash = await bcrypt.hash(testPassword, 10);
    const result = await pool.query(
        'INSERT INTO users (email, name, password_hash, is_admin) VALUES ($1, $2, $3, TRUE) RETURNING id',
        [testEmail, 'Тестовый пользователь', hash]
    );
    testUserId = result.rows[0].id;
});

afterAll(async () => {
    // Удаляем тестовые данные
    await pool.query('DELETE FROM permanent_approvers WHERE user_id = $1', [testUserId]);
    await pool.query('DELETE FROM users WHERE email LIKE $1', ['test-%@test.com']);
    await pool.end();
});

// ===== Страница логина =====

describe('Страница логина', () => {
    test('GET / — отображается форма входа', async () => {
        const res = await request(app).get('/');
        expect(res.status).toBe(200);
        expect(res.text).toContain('Корус СПР');
        expect(res.text).toContain('Email');
        expect(res.text).toContain('Пароль');
    });

    test('GET / — содержит форму с POST /login', async () => {
        const res = await request(app).get('/');
        expect(res.text).toContain('action="/login"');
        expect(res.text).toContain('method="POST"');
    });
});

// ===== Авторизация =====

describe('Авторизация', () => {
    test('POST /login — успешный вход с правильными данными', async () => {
        const res = await request(app)
            .post('/login')
            .type('form')
            .send({ email: testEmail, password: testPassword });

        expect(res.status).toBe(302);
        expect(res.headers.location).toBe('/dashboard');
        expect(res.headers['set-cookie']).toBeDefined();
    });

    test('POST /login — ошибка при неверном пароле', async () => {
        const res = await request(app)
            .post('/login')
            .type('form')
            .send({ email: testEmail, password: 'wrongpassword' });

        expect(res.status).toBe(200);
        expect(res.text).toContain('Неверный email или пароль');
    });

    test('POST /login — ошибка при несуществующем email', async () => {
        const res = await request(app)
            .post('/login')
            .type('form')
            .send({ email: 'nobody@test.com', password: 'whatever' });

        expect(res.status).toBe(200);
        expect(res.text).toContain('Неверный email или пароль');
    });

    test('GET /logout — очищает cookie и редиректит', async () => {
        const res = await request(app).get('/logout');
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe('/');
    });
});

// ===== Защита маршрутов =====

describe('Защита маршрутов', () => {
    test('GET /dashboard — без авторизации редиректит на логин', async () => {
        const res = await request(app).get('/dashboard');
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe('/');
    });

    test('GET /users — без авторизации редиректит на логин', async () => {
        const res = await request(app).get('/users');
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe('/');
    });

    test('GET /dashboard — с авторизацией показывает дашборд', async () => {
        // Логинимся
        const loginRes = await request(app)
            .post('/login')
            .type('form')
            .send({ email: testEmail, password: testPassword });

        const cookie = loginRes.headers['set-cookie'];

        const res = await request(app)
            .get('/dashboard')
            .set('Cookie', cookie);

        expect(res.status).toBe(200);
        expect(res.text).toContain('Сделки');
    });
});

// ===== Управление пользователями =====

describe('Управление пользователями', () => {
    let adminCookie;

    beforeAll(async () => {
        const loginRes = await request(app)
            .post('/login')
            .type('form')
            .send({ email: testEmail, password: testPassword });
        adminCookie = loginRes.headers['set-cookie'];
    });

    test('GET /users — показывает список пользователей', async () => {
        const res = await request(app)
            .get('/users')
            .set('Cookie', adminCookie);

        expect(res.status).toBe(200);
        expect(res.text).toContain('Пользователи');
        expect(res.text).toContain(testEmail);
    });

    test('POST /users — создаёт нового пользователя', async () => {
        const res = await request(app)
            .post('/users')
            .set('Cookie', adminCookie)
            .type('form')
            .send({ email: 'test-new@test.com', name: 'Новый', password: 'pass123' });

        expect(res.status).toBe(200);
        expect(res.text).toContain('Новый');
        expect(res.text).toContain('Пользователь Новый создан');
    });

    test('POST /users — дубликат email выдаёт ошибку', async () => {
        const res = await request(app)
            .post('/users')
            .set('Cookie', adminCookie)
            .type('form')
            .send({ email: 'test-new@test.com', name: 'Дубль', password: 'pass123' });

        expect(res.status).toBe(200);
        expect(res.text).toContain('уже существует');
    });

    test('POST /users/:id/approver/add — добавляет в согласующие', async () => {
        const res = await request(app)
            .post(`/users/${testUserId}/approver/add`)
            .set('Cookie', adminCookie);

        expect(res.status).toBe(302);
        expect(res.headers.location).toBe('/users');

        const check = await pool.query(
            'SELECT 1 FROM permanent_approvers WHERE user_id = $1', [testUserId]
        );
        expect(check.rows.length).toBe(1);
    });

    test('POST /users/:id/approver/remove — убирает из согласующих', async () => {
        const res = await request(app)
            .post(`/users/${testUserId}/approver/remove`)
            .set('Cookie', adminCookie);

        expect(res.status).toBe(302);

        const check = await pool.query(
            'SELECT 1 FROM permanent_approvers WHERE user_id = $1', [testUserId]
        );
        expect(check.rows.length).toBe(0);
    });

    test('POST /users/:id/toggle — деактивирует пользователя', async () => {
        // Создадим пользователя для теста
        const hash = await bcrypt.hash('pass123', 10);
        const created = await pool.query(
            'INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id',
            ['test-toggle@test.com', 'Toggle', hash]
        );
        const toggleId = created.rows[0].id;

        const res = await request(app)
            .post(`/users/${toggleId}/toggle`)
            .set('Cookie', adminCookie);

        expect(res.status).toBe(302);

        const check = await pool.query('SELECT is_active FROM users WHERE id = $1', [toggleId]);
        expect(check.rows[0].is_active).toBe(false);
    });
});

// ===== Безопасность =====

describe('Заголовки безопасности (Helmet)', () => {
    test('Ответ содержит заголовки безопасности', async () => {
        const res = await request(app).get('/');
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
        expect(res.headers['x-powered-by']).toBeUndefined();
    });
});
