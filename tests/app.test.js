const request = require('supertest');
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');
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
    // Удаляем тестовые данные (порядок важен из-за FK)
    const testDeals = await pool.query("SELECT id FROM deals WHERE client LIKE 'Тест-%'");
    const dealIds = testDeals.rows.map(r => r.id);
    if (dealIds.length > 0) {
        await pool.query('DELETE FROM audit_log WHERE deal_id = ANY($1)', [dealIds]);
        await pool.query('DELETE FROM votes WHERE deal_id = ANY($1)', [dealIds]);
        await pool.query('DELETE FROM comments WHERE deal_id = ANY($1)', [dealIds]);
        await pool.query('DELETE FROM documents WHERE deal_id = ANY($1)', [dealIds]);
        await pool.query('DELETE FROM deal_participants WHERE deal_id = ANY($1)', [dealIds]);
        await pool.query('DELETE FROM deals WHERE id = ANY($1)', [dealIds]);
    }
    await pool.query('DELETE FROM permanent_approvers WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)', ['test-%@test.com']);
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

// ===== Управление сделками =====

describe('Управление сделками', () => {
    let adminCookie;

    beforeAll(async () => {
        const loginRes = await request(app)
            .post('/login')
            .type('form')
            .send({ email: testEmail, password: testPassword });
        adminCookie = loginRes.headers['set-cookie'];
    });

    test('GET /deals/new — форма создания сделки', async () => {
        const res = await request(app)
            .get('/deals/new')
            .set('Cookie', adminCookie);

        expect(res.status).toBe(200);
        expect(res.text).toContain('Новая сделка');
        expect(res.text).toContain('Клиент');
    });

    test('POST /deals — создаёт сделку', async () => {
        const res = await request(app)
            .post('/deals')
            .set('Cookie', adminCookie)
            .type('form')
            .send({
                client: 'Тест-Клиент',
                department: 'Тест-Отдел',
                subject: 'Тестовая сделка',
                amount: '1000000',
                initiator_id: testUserId,
            });

        expect(res.status).toBe(302);
        expect(res.headers.location).toMatch(/\/deals\/\d+/);

        // Проверяем в БД
        const check = await pool.query('SELECT * FROM deals WHERE client = $1', ['Тест-Клиент']);
        expect(check.rows.length).toBe(1);
        expect(check.rows[0].status).toBe('draft');
    });

    test('GET /deals/:id — карточка сделки', async () => {
        const deal = await pool.query('SELECT id FROM deals WHERE client = $1', ['Тест-Клиент']);
        const dealId = deal.rows[0].id;

        const res = await request(app)
            .get(`/deals/${dealId}`)
            .set('Cookie', adminCookie);

        expect(res.status).toBe(200);
        expect(res.text).toContain('Тест-Клиент');
        expect(res.text).toContain('Тестовая сделка');
    });

    test('GET /deals/:id — без авторизации редиректит', async () => {
        const deal = await pool.query('SELECT id FROM deals WHERE client = $1', ['Тест-Клиент']);
        const res = await request(app).get(`/deals/${deal.rows[0].id}`);

        expect(res.status).toBe(302);
        expect(res.headers.location).toBe('/');
    });

    test('POST /deals/:id/edit — редактирование сделки', async () => {
        const deal = await pool.query('SELECT id FROM deals WHERE client = $1', ['Тест-Клиент']);
        const dealId = deal.rows[0].id;

        const res = await request(app)
            .post(`/deals/${dealId}/edit`)
            .set('Cookie', adminCookie)
            .type('form')
            .send({
                client: 'Тест-Клиент-Обновлён',
                department: 'Тест-Отдел',
                subject: 'Обновлённая сделка',
                amount: '2000000',
                initiator_id: testUserId,
            });

        expect(res.status).toBe(302);

        const check = await pool.query('SELECT * FROM deals WHERE id = $1', [dealId]);
        expect(check.rows[0].client).toBe('Тест-Клиент-Обновлён');
        expect(check.rows[0].subject).toBe('Обновлённая сделка');
    });

    test('POST /deals/:id/participants — добавляет участника', async () => {
        // Создадим пользователя-участника
        const bcrypt = require('bcrypt');
        const hash = await bcrypt.hash('pass123', 10);
        const newUser = await pool.query(
            'INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id',
            ['test-participant@test.com', 'Участник', hash]
        );
        const participantId = newUser.rows[0].id;

        const deal = await pool.query('SELECT id FROM deals WHERE client = $1', ['Тест-Клиент-Обновлён']);
        const dealId = deal.rows[0].id;

        const res = await request(app)
            .post(`/deals/${dealId}/participants`)
            .set('Cookie', adminCookie)
            .type('form')
            .send({ user_id: participantId, role: 'observer' });

        expect(res.status).toBe(302);

        const check = await pool.query(
            'SELECT * FROM deal_participants WHERE deal_id = $1 AND user_id = $2',
            [dealId, participantId]
        );
        expect(check.rows.length).toBe(1);
        expect(check.rows[0].role).toBe('observer');
    });

    test('Аудит-лог записывается при создании и редактировании', async () => {
        const deal = await pool.query('SELECT id FROM deals WHERE client = $1', ['Тест-Клиент-Обновлён']);
        const dealId = deal.rows[0].id;

        const logs = await pool.query(
            'SELECT action FROM audit_log WHERE deal_id = $1 ORDER BY created_at',
            [dealId]
        );
        const actions = logs.rows.map(r => r.action);
        expect(actions).toContain('deal_created');
        expect(actions).toContain('deal_updated');
    });
});

// ===== Голосование и жизненный цикл сделки =====

describe('Голосование и жизненный цикл сделки', () => {
    let adminCookie, approverCookie;
    let dealId, approverId;

    beforeAll(async () => {
        // Логин админа
        const loginRes = await request(app)
            .post('/login')
            .type('form')
            .send({ email: testEmail, password: testPassword });
        adminCookie = loginRes.headers['set-cookie'];

        // Создаём согласующего
        const bcrypt = require('bcrypt');
        const hash = await bcrypt.hash('pass123', 10);
        const approverRes = await pool.query(
            'INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id',
            ['test-approver@test.com', 'Согласующий', hash]
        );
        approverId = approverRes.rows[0].id;

        // Создаём сделку
        const dealRes = await pool.query(
            `INSERT INTO deals (client, department, subject, amount, initiator_id, created_by)
             VALUES ($1, $2, $3, $4, $5, $5) RETURNING id`,
            ['Тест-Голосование', 'Отдел', 'Тест голосования', 500000, testUserId]
        );
        dealId = dealRes.rows[0].id;

        // Добавляем участников
        await pool.query(
            'INSERT INTO deal_participants (deal_id, user_id, role) VALUES ($1, $2, $3)',
            [dealId, testUserId, 'initiator']
        );
        await pool.query(
            'INSERT INTO deal_participants (deal_id, user_id, role) VALUES ($1, $2, $3)',
            [dealId, approverId, 'approver']
        );

        // Логин согласующего
        const approverLogin = await request(app)
            .post('/login')
            .type('form')
            .send({ email: 'test-approver@test.com', password: 'pass123' });
        approverCookie = approverLogin.headers['set-cookie'];
    });

    test('POST /deals/:id/start — запуск согласования', async () => {
        const res = await request(app)
            .post(`/deals/${dealId}/start`)
            .set('Cookie', adminCookie);

        expect(res.status).toBe(302);

        const check = await pool.query('SELECT status FROM deals WHERE id = $1', [dealId]);
        expect(check.rows[0].status).toBe('active');
    });

    test('POST /deals/:id/vote — голосование без авторизации редиректит', async () => {
        const res = await request(app)
            .post(`/deals/${dealId}/vote`)
            .type('form')
            .send({ decision: 'approve' });

        expect(res.status).toBe(302);
        expect(res.headers.location).toBe('/');
    });

    test('POST /deals/:id/vote — согласующий голосует approve', async () => {
        const res = await request(app)
            .post(`/deals/${dealId}/vote`)
            .set('Cookie', approverCookie)
            .type('form')
            .send({ decision: 'approve', comment: 'Всё хорошо' });

        expect(res.status).toBe(302);

        const check = await pool.query(
            'SELECT * FROM votes WHERE deal_id = $1 AND user_id = $2',
            [dealId, approverId]
        );
        expect(check.rows.length).toBe(1);
        expect(check.rows[0].decision).toBe('approve');
    });

    test('POST /deals/:id/vote — повторное голосование игнорируется', async () => {
        const res = await request(app)
            .post(`/deals/${dealId}/vote`)
            .set('Cookie', approverCookie)
            .type('form')
            .send({ decision: 'reject', comment: 'Передумал' });

        expect(res.status).toBe(302);

        // Голос не изменился
        const check = await pool.query(
            'SELECT decision FROM votes WHERE deal_id = $1 AND user_id = $2',
            [dealId, approverId]
        );
        expect(check.rows[0].decision).toBe('approve');
    });

    test('POST /deals/:id/reservation — добавление оговорки', async () => {
        const res = await request(app)
            .post(`/deals/${dealId}/reservation`)
            .set('Cookie', approverCookie)
            .type('form')
            .send({ reservation: 'При условии доработки договора' });

        expect(res.status).toBe(302);

        const check = await pool.query(
            'SELECT reservation FROM votes WHERE deal_id = $1 AND user_id = $2',
            [dealId, approverId]
        );
        expect(check.rows[0].reservation).toBe('При условии доработки договора');
    });

    test('POST /deals/:id/close — администратор закрывает сделку', async () => {
        const res = await request(app)
            .post(`/deals/${dealId}/close`)
            .set('Cookie', adminCookie)
            .type('form')
            .send({ final_status: 'approved', comment: 'Сделка одобрена' });

        expect(res.status).toBe(302);

        const check = await pool.query('SELECT status, close_comment, closed_at FROM deals WHERE id = $1', [dealId]);
        expect(check.rows[0].status).toBe('approved');
        expect(check.rows[0].close_comment).toBe('Сделка одобрена');
        expect(check.rows[0].closed_at).not.toBeNull();
    });

    test('Голосование по закрытой сделке невозможно', async () => {
        // Создадим второго согласующего
        const bcrypt = require('bcrypt');
        const hash = await bcrypt.hash('pass123', 10);
        const user2 = await pool.query(
            'INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id',
            ['test-approver2@test.com', 'Согласующий2', hash]
        );
        await pool.query(
            'INSERT INTO deal_participants (deal_id, user_id, role) VALUES ($1, $2, $3)',
            [dealId, user2.rows[0].id, 'approver']
        );

        const login2 = await request(app)
            .post('/login')
            .type('form')
            .send({ email: 'test-approver2@test.com', password: 'pass123' });

        const res = await request(app)
            .post(`/deals/${dealId}/vote`)
            .set('Cookie', login2.headers['set-cookie'])
            .type('form')
            .send({ decision: 'approve' });

        // Редирект без создания голоса (сделка не active)
        expect(res.status).toBe(302);

        const check = await pool.query(
            'SELECT COUNT(*) FROM votes WHERE deal_id = $1',
            [dealId]
        );
        expect(Number(check.rows[0].count)).toBe(1); // только первый голос
    });
});

// ===== Отзыв сделки =====

describe('Отзыв сделки', () => {
    let adminCookie, dealId;

    beforeAll(async () => {
        const loginRes = await request(app)
            .post('/login')
            .type('form')
            .send({ email: testEmail, password: testPassword });
        adminCookie = loginRes.headers['set-cookie'];

        const dealRes = await pool.query(
            `INSERT INTO deals (client, department, subject, status, initiator_id, created_by)
             VALUES ($1, $2, $3, 'active', $4, $4) RETURNING id`,
            ['Тест-Отзыв', 'Отдел', 'Сделка для отзыва', testUserId]
        );
        dealId = dealRes.rows[0].id;
    });

    test('POST /deals/:id/withdraw — отзыв с комментарием', async () => {
        const res = await request(app)
            .post(`/deals/${dealId}/withdraw`)
            .set('Cookie', adminCookie)
            .type('form')
            .send({ comment: 'Клиент отказался' });

        expect(res.status).toBe(302);

        const check = await pool.query('SELECT status, close_comment FROM deals WHERE id = $1', [dealId]);
        expect(check.rows[0].status).toBe('withdrawn');
        expect(check.rows[0].close_comment).toBe('Клиент отказался');
    });
});

// ===== Документы =====

describe('Документы сделки', () => {
    let adminCookie, dealId;

    beforeAll(async () => {
        const loginRes = await request(app)
            .post('/login')
            .type('form')
            .send({ email: testEmail, password: testPassword });
        adminCookie = loginRes.headers['set-cookie'];

        const dealRes = await pool.query(
            `INSERT INTO deals (client, department, subject, initiator_id, created_by)
             VALUES ($1, $2, $3, $4, $4) RETURNING id`,
            ['Тест-Документы', 'Отдел', 'Сделка с документами', testUserId]
        );
        dealId = dealRes.rows[0].id;
        await pool.query(
            'INSERT INTO deal_participants (deal_id, user_id, role) VALUES ($1, $2, $3)',
            [dealId, testUserId, 'initiator']
        );
    });

    test('POST /deals/:id/documents — загрузка файла', async () => {
        // Создаём временный тестовый файл
        const tmpFile = path.join(__dirname, 'test-upload.txt');
        fs.writeFileSync(tmpFile, 'Тестовое содержимое документа');

        const res = await request(app)
            .post(`/deals/${dealId}/documents`)
            .set('Cookie', adminCookie)
            .attach('files', tmpFile);

        expect(res.status).toBe(302);

        const docs = await pool.query('SELECT * FROM documents WHERE deal_id = $1', [dealId]);
        expect(docs.rows.length).toBe(1);
        expect(docs.rows[0].filename).toBe('test-upload.txt');

        fs.unlinkSync(tmpFile);
    });

    test('GET /deals/:id/documents/:docId/download — скачивание', async () => {
        const doc = await pool.query('SELECT id FROM documents WHERE deal_id = $1', [dealId]);
        const docId = doc.rows[0].id;

        const res = await request(app)
            .get(`/deals/${dealId}/documents/${docId}/download`)
            .set('Cookie', adminCookie);

        expect(res.status).toBe(200);
        expect(res.headers['content-disposition']).toContain('test-upload.txt');
    });

    test('GET /deals/:id/documents/:docId/download — без авторизации', async () => {
        const doc = await pool.query('SELECT id FROM documents WHERE deal_id = $1', [dealId]);
        const res = await request(app).get(`/deals/${dealId}/documents/${doc.rows[0].id}/download`);

        expect(res.status).toBe(302);
        expect(res.headers.location).toBe('/');
    });

    test('POST /deals/:id/documents/:docId/delete — удаление файла', async () => {
        const doc = await pool.query('SELECT * FROM documents WHERE deal_id = $1', [dealId]);
        const docId = doc.rows[0].id;

        const res = await request(app)
            .post(`/deals/${dealId}/documents/${docId}/delete`)
            .set('Cookie', adminCookie);

        expect(res.status).toBe(302);

        const check = await pool.query('SELECT * FROM documents WHERE id = $1', [docId]);
        expect(check.rows.length).toBe(0);
    });

    test('Загрузка логируется в аудит', async () => {
        const logs = await pool.query(
            "SELECT action FROM audit_log WHERE deal_id = $1 AND action LIKE 'document_%' ORDER BY created_at",
            [dealId]
        );
        const actions = logs.rows.map(r => r.action);
        expect(actions).toContain('document_uploaded');
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
