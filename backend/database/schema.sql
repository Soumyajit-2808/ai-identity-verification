-- Identity & Eligibility Verification Platform Database Schema
-- Compatible with PostgreSQL and SQLite

-- 1. Organizations (Multi-tenant)
CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Users / Operators (RBAC)
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'organizer', 'reviewer', 'operator')),
    is_active INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. Events (Configurable Verification Policies)
CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    description TEXT,
    min_age INTEGER NOT NULL DEFAULT 18,
    max_age INTEGER NOT NULL DEFAULT 100,
    allowed_id_types TEXT NOT NULL DEFAULT '["AADHAAR","PAN","PASSPORT","DRIVING_LICENSE","VOTER_ID","STUDENT_ID"]',
    require_selfie INTEGER NOT NULL DEFAULT 0,
    strict_name_matching INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 4. Registrations
CREATE TABLE IF NOT EXISTS registrations (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    registration_name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'VERIFIED', 'REVIEW_REQUIRED', 'REJECTED')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 5. Stored Documents (Identity documents & selfies)
CREATE TABLE IF NOT EXISTS identity_documents (
    id TEXT PRIMARY KEY,
    registration_id TEXT REFERENCES registrations(id) ON DELETE CASCADE,
    document_type TEXT NOT NULL CHECK (document_type IN ('IDENTITY_DOCUMENT', 'SELFIE')),
    file_hash TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    file_size_bytes INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 6. Identity Deduplication Registry (Persists across restarts; prevents duplicate submissions & identity reuse)
CREATE TABLE IF NOT EXISTS identity_registry (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    registration_id TEXT NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
    id_number_hash TEXT NOT NULL,
    id_number_masked TEXT NOT NULL,
    id_type TEXT NOT NULL,
    registered_name TEXT NOT NULL,
    document_file_hash TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_event_id_number UNIQUE (event_id, id_number_hash)
);

-- 7. Verification Requests (Immutable verification attempts)
CREATE TABLE IF NOT EXISTS verification_requests (
    id TEXT PRIMARY KEY,
    registration_id TEXT NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'PROCESSING' CHECK (status IN ('PROCESSING', 'COMPLETED', 'FAILED')),
    request_ip TEXT,
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP
);

-- 8. Verification Results (Final decisions and summary)
CREATE TABLE IF NOT EXISTS verification_results (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE REFERENCES verification_requests(id) ON DELETE CASCADE,
    registration_id TEXT NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
    decision TEXT NOT NULL CHECK (decision IN ('ELIGIBLE', 'INELIGIBLE', 'REVIEW')),
    confidence_score REAL NOT NULL,
    risk_score REAL NOT NULL DEFAULT 0.0,
    evidence_score REAL NOT NULL DEFAULT 0.0,
    summary_reason TEXT NOT NULL,
    extracted_identity_json TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 9. Verification Signals (Granular evidence for each check)
CREATE TABLE IF NOT EXISTS verification_signals (
    id TEXT PRIMARY KEY,
    result_id TEXT NOT NULL REFERENCES verification_results(id) ON DELETE CASCADE,
    signal_type TEXT NOT NULL CHECK (signal_type IN (
        'OCR', 'QUALITY', 'TAMPER', 'DUPLICATE_FILE', 'IDENTITY_REUSE',
        'NAME_MATCH', 'ELIGIBILITY', 'FACE_MATCH', 'DOCUMENT_TYPE'
    )),
    status TEXT NOT NULL CHECK (status IN ('PASSED', 'REVIEW', 'FAILED', 'SKIPPED')),
    score REAL,
    raw_details_json TEXT,
    reason TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 10. Manual Review Cases (Operator workflow)
CREATE TABLE IF NOT EXISTS review_cases (
    id TEXT PRIMARY KEY,
    result_id TEXT NOT NULL REFERENCES verification_results(id) ON DELETE CASCADE,
    registration_id TEXT NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'ESCALATED')),
    priority TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH', 'URGENT')),
    assigned_to TEXT REFERENCES users(id) ON DELETE SET NULL,
    reviewer_notes TEXT,
    resolution_reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP
);

-- 11. Immutable Audit Trail
CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    actor_id TEXT,
    actor_role TEXT,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    event_id TEXT,
    details_json TEXT,
    ip_address TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for high-frequency queries and deduplication lookups
CREATE INDEX IF NOT EXISTS idx_reg_event ON registrations(event_id);
CREATE INDEX IF NOT EXISTS idx_doc_hash ON identity_documents(file_hash);
CREATE INDEX IF NOT EXISTS idx_registry_event_hash ON identity_registry(event_id, id_number_hash);
CREATE INDEX IF NOT EXISTS idx_registry_file_hash ON identity_registry(document_file_hash);
CREATE INDEX IF NOT EXISTS idx_verif_reg ON verification_requests(registration_id);
CREATE INDEX IF NOT EXISTS idx_signals_result ON verification_signals(result_id);
CREATE INDEX IF NOT EXISTS idx_cases_status ON review_cases(status);
CREATE INDEX IF NOT EXISTS idx_cases_event ON review_cases(event_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
