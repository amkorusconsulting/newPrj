const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pool = require('../db');
const { authRequired, adminRequired } = require('../middleware/auth');

const router = express.Router();

// Настройка multer — хранение файлов в /root/uploads/deals/{deal_id}/
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, '..', 'uploads', 'deals', req.params.id);
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        // Уникальное имя: timestamp + оригинальное имя
        const uniqueName = Date.now() + '-' + file.originalname;
        cb(null, uniqueName);
    },
});

const upload = multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50 МБ
});

// Загрузка документов (инициатор или админ, сделка не закрыта)
router.post('/deals/:id/documents', authRequired, upload.array('files', 20), async (req, res) => {
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
            await pool.query(
                'INSERT INTO documents (deal_id, filename, filepath, filesize, uploaded_by) VALUES ($1, $2, $3, $4, $5)',
                [id, file.originalname, file.path, file.size, req.user.id]
            );

            await pool.query(
                'INSERT INTO audit_log (user_id, deal_id, action, details) VALUES ($1, $2, $3, $4)',
                [req.user.id, id, 'document_uploaded', JSON.stringify({ filename: file.originalname })]
            );
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

// Скачивание документа (все участники сделки + админ)
router.get('/deals/:id/documents/:docId/download', authRequired, async (req, res) => {
    const { id, docId } = req.params;

    try {
        // Проверка доступа
        if (!req.user.is_admin) {
            const access = await pool.query(
                'SELECT 1 FROM deal_participants WHERE deal_id = $1 AND user_id = $2',
                [id, req.user.id]
            );
            if (access.rows.length === 0) {
                return res.status(403).send('Доступ запрещён');
            }
        }

        const doc = await pool.query(
            'SELECT * FROM documents WHERE id = $1 AND deal_id = $2',
            [docId, id]
        );
        if (doc.rows.length === 0) return res.status(404).send('Документ не найден');

        const document = doc.rows[0];

        // Проверяем, что файл существует
        if (!fs.existsSync(document.filepath)) {
            return res.status(404).send('Файл не найден на сервере');
        }

        // Логируем скачивание
        await pool.query(
            'INSERT INTO audit_log (user_id, deal_id, document_id, action) VALUES ($1, $2, $3, $4)',
            [req.user.id, id, docId, 'document_downloaded']
        );

        res.download(document.filepath, document.filename);
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

        // Удаляем файл с диска
        if (fs.existsSync(doc.rows[0].filepath)) {
            fs.unlinkSync(doc.rows[0].filepath);
        }

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
