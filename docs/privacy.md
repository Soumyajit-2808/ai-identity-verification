# Privacy & Data Governance Architecture

This document details the data privacy mechanisms, cryptographic protections, and compliance standards designed into the platform for processing Personally Identifiable Information (PII) and biometric data.

---

## 1. Principles of Data Governance

The platform adheres to four foundational data protection principles:

1. **Data Minimization & Masked Persistence**:
   - Only fields directly relevant to eligibility verification (Full Name, Date of Birth, ID Number, ID Type, Institution) are extracted during transient AI analysis.
   - **No Raw ID Persistence**: Raw government ID numbers are utilized strictly in ephemeral memory during verification and salted HMAC generation. Raw ID numbers are never persisted into relational tables or returned by verification history/review APIs; only `id_number_masked` (e.g. `********9012`) is persisted in `verification_results.extracted_identity_json` and `identity_registry`.
   - Address fields, parentage, and unrelated markers are omitted from extraction schemas.
2. **Purpose Limitation**:
   - Applicant verification records are scoped strictly to the specific `event_id` and `organization_id` under which registration was submitted.
3. **Storage Limitation & Automatic Failure Cleanup**:
   - If AI processing fails or the database transaction aborts, uploaded files are immediately deleted from disk to prevent orphaned documents.
   - **Current Implementation Note**: Automated time-based retention scheduling and cron-based cryptographic purging of media files are **NOT** currently implemented. Current retention is maintained indefinitely until explicitly removed via relational database cascades or administrative action.
4. **Integrity & Confidentiality**:
   - Deduplication indexes rely solely on salted cryptographic HMAC hashes (`PII_SALT`).
   - Raw media files reside in private storage directories inaccessible to direct public HTTP requests.

---

## 2. PII Classification & Data Handling Matrix

| Data Element | Storage Location | Encryption / Protection | Masked in Logs/APIs | Current Retention |
| :--- | :--- | :---: | :---: | :--- |
| **Government ID Image** | Local Secure Storage | Storage Isolation | Excluded | Scoped to Event Lifecycle |
| **Selfie Image** | Local Secure Storage | Storage Isolation | Excluded | Scoped to Event Lifecycle |
| **Raw Government ID** | Ephemeral RAM Only | Not stored raw; transient only for hashing | Always Masked | Discarded immediately after hash/mask |
| **Masked ID Number** | `verification_results`, `identity_registry` | Masked (`****1234`) | Masked | Persisted with verification record |
| **ID Number Hash** | `identity_registry.id_number_hash` | Salted HMAC-SHA256 | Full Hash | Permanent (Deduplication Registry) |
| **Date of Birth** | `verification_results` | Standard DB Field | Masked | Persisted with verification record |
| **Face Biometric Vectors** | Ephemeral RAM (DeepFace) | Not stored permanently | Excluded | Discarded after inference |
| **Audit Logs** | `audit_logs` | Append-only DB Table | Sanitized PII | Preserved for Audit Trail |

---

## 3. Biometric Data Protection

Biometric verification (selfie-to-document face comparison) introduces stringent privacy obligations:

- **No Permanent Biometric Vector Databases**:
  - DeepFace embeddings are computed in-memory during request processing and are **never** stored in relational tables or vector databases.
  - Only scalar similarity results (`distance`, `threshold`, `match: bool`) and the `FACE_MATCH` signal are recorded.
- **Presentation Attack Disclaimer**:
  - The platform explicitly discloses that standard 2D selfie matching evaluates geometric facial feature proximity and does not perform active 3D liveness or presentation attack detection.

---

## 4. Deletion & Data Purge Capabilities

- **Automated Failure Cleanup**: Unlinked immediately from disk storage upon processing abort or transaction rollback.
- **Database Cascade**: Relational foreign keys with `ON DELETE CASCADE` ensure that removing an event or registration cascades to verification requests, results, signals, documents, and review cases.
- **Retention Scheduling Limitation**: Automated background retention scheduling (such as automatically expiring files 30 days post-event) is **NOT currently implemented** and must be performed via operational administrative scripts.

