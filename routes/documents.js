const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const pool = require('../db');
const { authRequired, adminRequired, checkDealAccess } = require('../middleware/auth');
const { notifyDocumentUploaded } = require('../services/mailer');

const router = express.Router();

// Разрешённые типы файлов
const ALLOWED_EXTENSIONS = new Set([
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.txt', '.csv', '.rtf', '.odt', '.ods', '.odp',
    '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff',
    '.zip', '.rar', '.7z',
]);

// Multer: хранение в памяти (буфер), затем сохраняем в БД
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 }, // 50 МБ
    fileFilter: (req, file, cb) => {
        const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
        const ext = require('path').extname(originalName).toLowerCase();
        if (ALLOWED_EXTENSIONS.has(ext)) {
            cb(null, true);
        } else {
            cb(new Error(`Тип файла ${ext} не разрешён`));
        }
    },
});

// --- Подписанные ссылки на скачивание ---
const DOWNLOAD_TOKEN_TTL = 5 * 60 * 1000; // 5 минут

function generateDownloadToken(userId, dealId, docId) {
    const expires = Date.now() + DOWNLOAD_TOKEN_TTL;
    const payload = `${userId}:${dealId}:${docId}:${expires}`;
    const hmac = crypto.createHmac('sha256', process.env.JWT_SECRET).update(payload).digest('hex');
    return `${expires}.${hmac}`;
}

function verifyDownloadToken(token, userId, dealId, docId) {
    if (!token) return false;
    const parts = token.split('.');
    if (parts.length !== 2) return false;
    const [expires, hmac] = parts;
    if (Date.now() > Number(expires)) return false;
    const payload = `${userId}:${dealId}:${docId}:${expires}`;
    const expected = crypto.createHmac('sha256', process.env.JWT_SECRET).update(payload).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expected));
}

// Генерация токена для скачивания (AJAX)
router.get('/deals/:id/documents/:docId/token', authRequired, checkDealAccess, async (req, res) => {
    const { id, docId } = req.params;

    try {
        const doc = await pool.query('SELECT id FROM documents WHERE id = $1 AND deal_id = $2', [docId, id]);
        if (doc.rows.length === 0) return res.status(404).json({ error: 'Документ не найден' });

        const token = generateDownloadToken(req.user.id, id, docId);
        res.json({ token });
    } catch (err) {
        console.error('Token error:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Обработка ошибок multer (тип файла, размер)
function handleUpload(req, res, next) {
    upload.array('files', 20)(req, res, (err) => {
        if (err) {
            const msg = err.code === 'LIMIT_FILE_SIZE'
                ? 'Файл превышает 50 МБ'
                : err.message || 'Ошибка загрузки';
            if (req.xhr || (req.headers.accept && req.headers.accept.indexOf('json') > -1)) {
                return res.status(400).json({ ok: false, error: msg });
            }
            return res.status(400).send(msg);
        }
        next();
    });
}

// Загрузка документов (инициатор или админ, сделка не закрыта)
router.post('/deals/:id/documents', authRequired, handleUpload, async (req, res) => {
    const { id } = req.params;

    try {
        const deal = await pool.query('SELECT * FROM deals WHERE id = $1', [id]);
        if (deal.rows.length === 0) return res.status(404).send('Сделка не найдена');

        const d = deal.rows[0];
        if (['closed', 'approved', 'rejected', 'withdrawn'].includes(d.status)) {
            return res.redirect(`/deals/${id}`);
        }

        // Только инициатор или админ
        if (d.initiator_id !== req.user.id && !req.user.is_admin) {
            return res.status(403).send('Только инициатор может загружать документы');
        }

        // Сохраняем каждый файл в БД
        for (const file of req.files) {
            // Декодируем кириллицу из latin1 в utf-8
            const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');

            await pool.query(
                'INSERT INTO documents (deal_id, filename, mimetype, filedata, filesize, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6)',
                [id, originalName, file.mimetype, file.buffer, file.size, req.user.id]
            );

            await pool.query(
                'INSERT INTO audit_log (user_id, deal_id, action, details) VALUES ($1, $2, $3, $4)',
                [req.user.id, id, 'document_uploaded', JSON.stringify({ filename: originalName })]
            );
        }

        // Email согласующим, если сделка на согласовании
        if (d.status === 'active') {
            const filenames = req.files.map(f => Buffer.from(f.originalname, 'latin1').toString('utf8'));
            const initiatorResult = await pool.query('SELECT name FROM users WHERE id = $1', [d.initiator_id]);
            d.initiator_name = initiatorResult.rows[0]?.name || null;
            const approvers = await pool.query(
                `SELECT u.email, u.name FROM deal_participants dp
                 JOIN users u ON dp.user_id = u.id
                 WHERE dp.deal_id = $1 AND dp.role IN ('approver', 'invited_approver')`, [id]
            );
            for (const fname of filenames) {
                notifyDocumentUploaded(d, approvers.rows, fname);
            }
        }

        // XHR-запрос — JSON, обычный — редирект
        if (req.xhr || (req.headers.accept && req.headers.accept.indexOf('json') > -1)) {
            res.json({ ok: true, count: req.files.length });
        } else {
            res.redirect(`/deals/${id}`);
        }
    } catch (err) {
        console.error('Upload error:', err);
        res.status(500).json({ ok: false, error: 'Ошибка сервера' });
    }
});

// Скачивание документа (подписанный токен + участник сделки или админ)
router.get('/deals/:id/documents/:docId/download', authRequired, checkDealAccess, async (req, res) => {
    const { id, docId } = req.params;
    const { t } = req.query;

    if (!verifyDownloadToken(t, req.user.id, id, docId)) {
        return res.status(403).send('Ссылка недействительна или истекла. Вернитесь на страницу сделки.');
    }

    try {
        const doc = await pool.query(
            'SELECT * FROM documents WHERE id = $1 AND deal_id = $2',
            [docId, id]
        );
        if (doc.rows.length === 0) return res.status(404).send('Документ не найден');

        const document = doc.rows[0];

        if (!document.filedata) {
            return res.status(404).send('Файл не найден');
        }

        // Логируем скачивание
        await pool.query(
            'INSERT INTO audit_log (user_id, deal_id, document_id, action) VALUES ($1, $2, $3, $4)',
            [req.user.id, id, docId, 'document_downloaded']
        );

        res.set({
            'Content-Type': document.mimetype || 'application/octet-stream',
            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(document.filename)}`,
            'Content-Length': document.filedata.length,
        });
        res.send(document.filedata);
    } catch (err) {
        console.error('Download error:', err);
        res.status(500).send('Ошибка сервера');
    }
});

// Удаление документа (инициатор или админ, сделка не закрыта)
router.post('/deals/:id/documents/:docId/delete', authRequired, async (req, res) => {
    const { id, docId } = req.params;

    try {
        const deal = await pool.query('SELECT * FROM deals WHERE id = $1', [id]);
        if (deal.rows.length === 0) return res.status(404).send('Сделка не найдена');

        const d = deal.rows[0];
        if (['closed', 'approved', 'rejected', 'withdrawn'].includes(d.status)) {
            return res.redirect(`/deals/${id}`);
        }

        if (d.initiator_id !== req.user.id && !req.user.is_admin) {
            return res.status(403).send('Доступ запрещён');
        }

        const doc = await pool.query('SELECT * FROM documents WHERE id = $1 AND deal_id = $2', [docId, id]);
        if (doc.rows.length === 0) return res.redirect(`/deals/${id}`);

        // Обнуляем ссылки в аудит-логе, удаляем комментарии
        await pool.query('UPDATE audit_log SET document_id = NULL WHERE document_id = $1', [docId]);
        await pool.query('DELETE FROM comments WHERE document_id = $1', [docId]);
        await pool.query('DELETE FROM documents WHERE id = $1', [docId]);

        await pool.query(
            'INSERT INTO audit_log (user_id, deal_id, action, details) VALUES ($1, $2, $3, $4)',
            [req.user.id, id, 'document_deleted', JSON.stringify({ filename: doc.rows[0].filename })]
        );

        res.redirect(`/deals/${id}`);
    } catch (err) {
        console.error('Delete document error:', err);
        res.status(500).send('Ошибка сервера');
    }
});

module.exports = router;
