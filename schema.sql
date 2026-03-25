-- КОРУС Согласование крупных сделок: Схема базы данных

-- Пользователи
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    is_admin BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Постоянная группа согласующих
CREATE TABLE permanent_approvers (
    id SERIAL PRIMARY KEY,
    user_id INTEGER UNIQUE NOT NULL REFERENCES users(id),
    added_at TIMESTAMP DEFAULT NOW()
);

-- Сделки
CREATE TABLE deals (
    id SERIAL PRIMARY KEY,
    client VARCHAR(255) NOT NULL,
    department VARCHAR(255) NOT NULL,
    subject TEXT NOT NULL,
    amount NUMERIC(15, 2),
    deadline TIMESTAMP,
    status VARCHAR(20) DEFAULT 'draft'
        CHECK (status IN ('draft', 'active', 'closed', 'approved', 'rejected', 'withdrawn')),
    initiator_id INTEGER REFERENCES users(id),
    created_by INTEGER REFERENCES users(id),
    close_comment TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    closed_at TIMESTAMP
);

-- Участники сделки
CREATE TABLE deal_participants (
    id SERIAL PRIMARY KEY,
    deal_id INTEGER NOT NULL REFERENCES deals(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    role VARCHAR(20) NOT NULL
        CHECK (role IN ('initiator', 'approver', 'invited_approver', 'observer')),
    added_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (deal_id, user_id, role)
);

-- Документы сделки (файлы хранятся в БД как BYTEA)
CREATE TABLE documents (
    id SERIAL PRIMARY KEY,
    deal_id INTEGER NOT NULL REFERENCES deals(id),
    filename VARCHAR(255) NOT NULL,
    mimetype VARCHAR(255) DEFAULT 'application/octet-stream',
    filedata BYTEA,
    filesize INTEGER,
    uploaded_by INTEGER REFERENCES users(id),
    uploaded_at TIMESTAMP DEFAULT NOW()
);

-- Голоса (решения согласующих)
CREATE TABLE votes (
    id SERIAL PRIMARY KEY,
    deal_id INTEGER NOT NULL REFERENCES deals(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    decision VARCHAR(10) NOT NULL CHECK (decision IN ('approve', 'reject')),
    comment TEXT,
    reservation TEXT,
    voted_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (deal_id, user_id)
);

-- Комментарии к документам
CREATE TABLE comments (
    id SERIAL PRIMARY KEY,
    document_id INTEGER NOT NULL REFERENCES documents(id),
    deal_id INTEGER NOT NULL REFERENCES deals(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    text TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Magic links для голосования из email
CREATE TABLE magic_links (
    id SERIAL PRIMARY KEY,
    deal_id INTEGER NOT NULL REFERENCES deals(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    token VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    used BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Аудит-лог
CREATE TABLE audit_log (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    deal_id INTEGER REFERENCES deals(id),
    document_id INTEGER REFERENCES documents(id),
    action VARCHAR(50) NOT NULL,
    details JSONB,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Промпт ИИ (редактируется администратором)
CREATE TABLE ai_prompt (
    id SERIAL PRIMARY KEY,
    prompt TEXT NOT NULL,
    updated_by INTEGER REFERENCES users(id),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Мнения ИИ по сделкам
CREATE TABLE ai_opinions (
    id SERIAL PRIMARY KEY,
    deal_id INTEGER NOT NULL REFERENCES deals(id),
    opinion TEXT NOT NULL,
    model VARCHAR(100),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Индексы
CREATE INDEX idx_deal_participants_deal ON deal_participants(deal_id);
CREATE INDEX idx_deal_participants_user ON deal_participants(user_id);
CREATE INDEX idx_documents_deal ON documents(deal_id);
CREATE INDEX idx_votes_deal ON votes(deal_id);
CREATE INDEX idx_comments_document ON comments(document_id);
CREATE INDEX idx_comments_deal ON comments(deal_id);
CREATE INDEX idx_audit_log_deal ON audit_log(deal_id);
CREATE INDEX idx_audit_log_user ON audit_log(user_id);
CREATE INDEX idx_magic_links_token ON magic_links(token);
CREATE INDEX idx_ai_opinions_deal ON ai_opinions(deal_id);
CREATE INDEX idx_deals_initiator ON deals(initiator_id);
CREATE INDEX idx_deals_status ON deals(status);
CREATE INDEX idx_audit_log_created ON audit_log(created_at DESC);
