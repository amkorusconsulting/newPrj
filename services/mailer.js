const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

// На бесплатном тарифе без домена можно отправлять только с onboarding@resend.dev
const FROM = 'КОРУС Крупные сделки <onboarding@resend.dev>';
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
// Тестовый режим: все письма на один адрес (убрать после привязки домена в Resend)
const TEST_RECIPIENT = 'am.korusconsulting@gmail.com';

function buildSubject(deal) {
    const amount = deal.amount
        ? Number(deal.amount).toLocaleString('ru-RU') + ' руб.'
        : 'сумма не указана';
    const initiator = deal.initiator_name || 'не указан';
    return `КОРУС Крупная сделка: ${deal.client} ${amount} ${initiator}`;
}

function dealUrl(dealId) {
    return `${BASE_URL}/deals/${dealId}`;
}

// Безопасная отправка — ошибки логируются, но не ломают бизнес-процесс
async function safeSend(to, subject, html) {
    // Не отправляем email при тестировании
    if (process.env.NODE_ENV === 'test') return;

    try {
        const recipient = TEST_RECIPIENT || to;
        const result = await resend.emails.send({
            from: FROM, to: recipient, subject, html,
            headers: { 'X-Entity-Ref-ID': Date.now().toString() },
            tags: [{ name: 'click_tracking', value: 'false' }],
        });
        if (result.error) {
            console.error('Resend error:', result.error);
        }
    } catch (err) {
        console.error('Email send error:', err.message);
    }
}

// 1. Запуск согласования → согласующим (с magic-ссылкой для быстрого согласования)
async function notifyApprovalStarted(deal, approvers) {
    const subject = buildSubject(deal);
    const link = dealUrl(deal.id);

    for (const approver of approvers) {
        const approveLink = approver.magic_token
            ? `${BASE_URL}/vote/${approver.magic_token}`
            : null;

        await safeSend(approver.email, subject, `
            <p>Здравствуйте, ${approver.name}!</p>
            <p>Вы назначены согласующим по сделке <b>#${deal.id}</b>.</p>
            <table style="border-collapse:collapse; margin:12px 0;">
                <tr><td style="padding:4px 12px 4px 0; color:#888;">Клиент</td><td><b>${deal.client}</b></td></tr>
                <tr><td style="padding:4px 12px 4px 0; color:#888;">Предмет</td><td>${deal.subject}</td></tr>
                <tr><td style="padding:4px 12px 4px 0; color:#888;">Сумма</td><td>${deal.amount ? Number(deal.amount).toLocaleString('ru-RU') + ' руб.' : '—'}</td></tr>
                <tr><td style="padding:4px 12px 4px 0; color:#888;">Инициатор</td><td>${deal.initiator_name || '—'}</td></tr>
            </table>
            <p>Пожалуйста, ознакомьтесь с документами и проголосуйте:</p>
            <p style="margin:16px 0;">
                <a href="${link}" style="display:inline-block; padding:12px 28px; background:#002FA7; color:#fff; text-decoration:none; border-radius:6px; margin-right:12px;">Перейти к сделке</a>
                ${approveLink ? `<a href="${approveLink}" style="display:inline-block; padding:12px 28px; background:#F9423A; color:#fff; text-decoration:none; border-radius:6px; font-weight:600;">Согласовать</a>` : ''}
            </p>
            <p style="font-size:12px; color:#999; margin-top:16px;">Если вы хотите отклонить сделку или оставить комментарий, перейдите на страницу сделки.</p>
        `);
    }
}

// 2. Итоговый статус (ручной или авто) → всем участникам
async function notifyDealClosed(deal, participants, statusText, comment) {
    const subject = buildSubject(deal);
    const link = dealUrl(deal.id);

    for (const p of participants) {
        await safeSend(p.email, subject, `
            <p>Здравствуйте, ${p.name}!</p>
            <p>Сделка <b>#${deal.id}</b> (${deal.client}) закрыта.</p>
            <p>Итоговый статус: <b>${statusText}</b></p>
            ${comment ? `<p>Комментарий: ${comment}</p>` : ''}
            <p><a href="${link}" style="display:inline-block; padding:10px 24px; background:#002FA7; color:#fff; text-decoration:none; border-radius:6px;">Посмотреть сделку</a></p>
        `);
    }
}

// 3. Отзыв сделки → всем участникам
async function notifyDealWithdrawn(deal, participants, comment) {
    const subject = buildSubject(deal);
    const link = dealUrl(deal.id);

    for (const p of participants) {
        await safeSend(p.email, subject, `
            <p>Здравствуйте, ${p.name}!</p>
            <p>Сделка <b>#${deal.id}</b> (${deal.client}) отозвана инициатором.</p>
            ${comment ? `<p>Причина: ${comment}</p>` : ''}
            <p><a href="${link}" style="display:inline-block; padding:10px 24px; background:#002FA7; color:#fff; text-decoration:none; border-radius:6px;">Посмотреть сделку</a></p>
        `);
    }
}

// 4. Новый документ (при active) → согласующим
async function notifyDocumentUploaded(deal, approvers, filename) {
    const subject = buildSubject(deal);
    const link = dealUrl(deal.id);

    for (const approver of approvers) {
        await safeSend(approver.email, subject, `
            <p>Здравствуйте, ${approver.name}!</p>
            <p>В сделку <b>#${deal.id}</b> (${deal.client}) загружен новый документ:</p>
            <p><b>${filename}</b></p>
            <p><a href="${link}" style="display:inline-block; padding:10px 24px; background:#002FA7; color:#fff; text-decoration:none; border-radius:6px;">Перейти к сделке</a></p>
        `);
    }
}

module.exports = {
    notifyApprovalStarted,
    notifyDealClosed,
    notifyDealWithdrawn,
    notifyDocumentUploaded,
};
