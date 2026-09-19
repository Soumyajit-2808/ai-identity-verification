# Database Architecture & Persistence Specification

VerifyID AI uses an ANSI SQL relational data model supporting PostgreSQL (production) and SQLite (development/testing).

---

## Entity Relationship Summary

```text
organizations (1) ───< events (M) ───< registrations (M) ───< verification_requests (M)
      │                                       │                          │ (1)
      │                                       │                          ▼
      └───< users (M)                         └───< identity_documents   verification_results (1)
                                                                         ├───< verification_signals (M)
                                                                         └───< review_cases (1)
```

---

## Relational Tables

### 1. `organizations`
Multi-tenant organizational entities.
- `id` (TEXT, PK)
- `name` (TEXT)
- `slug` (TEXT, UNIQUE)
- `created_at`, `updated_at` (TIMESTAMP)

### 2. `events`
Configurable verification rules per hackathon or event.
- `id` (TEXT, PK)
- `organization_id` (TEXT, FK $\to$ `organizations.id`)
- `name` (TEXT), `code` (TEXT, UNIQUE)
- `min_age` (INT), `max_age` (INT)
- `allowed_id_types` (JSON/TEXT)
- `require_selfie` (INT, 0 or 1)
- `strict_name_matching` (INT, 0 or 1)

### 3. `registrations`
Participant registration records.
- `id` (TEXT, PK)
- `event_id` (TEXT, FK $\to$ `events.id`)
- `registration_name` (TEXT)
- `email` (TEXT), `phone` (TEXT)
- `status` (TEXT: `PENDING`, `VERIFIED`, `REVIEW_REQUIRED`, `REJECTED`)

### 4. `identity_documents`
Metadata for securely stored documents.
- `id` (TEXT, PK)
- `registration_id` (TEXT, FK $\to$ `registrations.id`)
- `document_type` (`IDENTITY_DOCUMENT`, `SELFIE`)
- `file_hash` (TEXT, SHA-256)
- `storage_path` (TEXT)
- `original_filename` (TEXT), `mime_type` (TEXT), `file_size_bytes` (INT)

### 5. `identity_registry` (Deduplication & Reuse Store)
Enforces uniqueness across application restarts and concurrent requests.
- `id` (TEXT, PK)
- `event_id` (TEXT, FK $\to$ `events.id`)
- `registration_id` (TEXT, FK $\to$ `registrations.id`)
- `id_number_hash` (TEXT, Salted HMAC-SHA-256)
- `id_number_masked` (TEXT)
- `id_type` (TEXT), `registered_name` (TEXT), `document_file_hash` (TEXT)
- **Constraints**:
  - `UNIQUE (event_id, id_number_hash)` — prevents concurrent identity reuse across different participants.
  - `UNIQUE (event_id, document_file_hash)` — enforces database-level concurrency safety against exact duplicate document uploads.

### 6. `verification_requests`
Immutable audit log of verification invocations.
- `id` (TEXT, PK)
- `registration_id` (TEXT, FK $\to$ `registrations.id`)
- `event_id` (TEXT, FK $\to$ `events.id`)
- `status` (`PROCESSING`, `COMPLETED`, `FAILED`)
- `request_ip` (TEXT), `user_agent` (TEXT), `created_at`, `completed_at`

### 7. `verification_results`
Final verification outcome.
- `id` (TEXT, PK)
- `request_id` (TEXT, UNIQUE, FK $\to$ `verification_requests.id`)
- `registration_id` (TEXT, FK $\to$ `registrations.id`)
- `decision` (`ELIGIBLE`, `INELIGIBLE`, `REVIEW`)
- `confidence_score` (REAL), `risk_score` (REAL), `evidence_score` (REAL)
- `summary_reason` (TEXT), `extracted_identity_json` (TEXT)

### 8. `verification_signals`
Normalized atomic evidence signals.
- `id` (TEXT, PK)
- `result_id` (TEXT, FK $\to$ `verification_results.id`)
- `signal_type` (`OCR`, `QUALITY`, `TAMPER`, `DUPLICATE_FILE`, `IDENTITY_REUSE`, `NAME_MATCH`, `ELIGIBILITY`, `FACE_MATCH`)
- `status` (`PASSED`, `REVIEW`, `FAILED`, `SKIPPED`)
- `score` (REAL), `raw_details_json` (TEXT), `reason` (TEXT)

### 9. `review_cases`
Operator review workflow tracking.
- `id` (TEXT, PK)
- `result_id` (TEXT, FK $\to$ `verification_results.id`)
- `registration_id` (TEXT, FK $\to$ `registrations.id`)
- `event_id` (TEXT, FK $\to$ `events.id`)
- `status` (`OPEN`, `IN_REVIEW`, `APPROVED`, `REJECTED`, `ESCALATED`)
- `priority` (`LOW`, `MEDIUM`, `HIGH`, `URGENT`)
- `assigned_to` (TEXT, FK $\to$ `users.id`)
- `reviewer_notes` (TEXT), `resolution_reason` (TEXT), `resolved_at` (TIMESTAMP)

### 10. `audit_logs`
Append-only log of security and administrative operations.
- `id` (TEXT, PK)
- `actor_id` (TEXT), `actor_role` (TEXT), `action` (TEXT)
- `entity_type` (TEXT), `entity_id` (TEXT), `details_json` (TEXT), `created_at` (TIMESTAMP)

---

## Transaction Boundaries

During a verification execution, all database writes occur within a single ACID transaction:
```sql
BEGIN TRANSACTION;
  -- 1. Insert registration
  -- 2. Insert document records
  -- 3. Insert verification request
  -- 4. Insert verification result
  -- 5. Insert verification signals
  -- 6. Insert identity registry record (fails atomically if unique constraint is violated)
  -- 7. Update registration status
  -- 8. Insert review case (if decision == 'REVIEW')
  -- 9. Insert audit log entry
COMMIT;
```
If any check or foreign key fails, the entire transaction is rolled back, leaving zero orphaned records.
