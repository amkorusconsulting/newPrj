const express = require('express');
const pool = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

router.get('/dashboard', authRequired, async (req, res) => {
    try {
        let deals;

        if (req.user.is_admin) {
            // Администратор видит все сделки
            const result = await pool.query(
                'SELECT d.*, u.name AS initiator_name FROM deals d LEFT JOIN users u ON d.initiator_id = u.id ORDER BY d.created_at DESC'
            );
            deals = result.rows;
        } else {
            // Остальные видят только сделки, где они участники
            const result = await pool.query(
                `SELECT d.*, u.name AS initiator_name, dp.role AS my_role
                 FROM deals d
                 JOIN deal_participants dp ON dp.deal_id = d.id
                 LEFT JOIN users u ON d.initiator_id = u.id
                 WHERE dp.user_id = $1
                 ORDER BY d.created_at DESC`,
                [req.user.id]
            );
            deals = result.rows;
        }

        res.render('dashboard', { user: req.user, deals });
    } catch (err) {
        console.error('Dashboard error:', err);
        res.status(500).send('Ошибка сервера');
    }
});

module.exports = router;
