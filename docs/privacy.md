# Privacy & Data Governance Architecture

This document details the data privacy mechanisms, cryptographic protections, and compliance standards designed into the platform for processing Personally Identifiable Information (PII) and biometric data.

---

## 1. Principles of Data Governance

The platform adheres to four foundational data protection principles:

1. **Data Minimization**:
   - Only fields directly relevant to eligibility verification (Full Name, Date of Birth, ID Number, ID Type, Institution) are extracted and persisted.
   - Address fields, parentage, and unrelated markers are omitted from extraction schemas.
2. **Purpose Limitation**:
   - Applicant verification records are scoped strictly to the specific `event_id` and `organization_id` under which registration was submitted.
3. **Storage Limitation & Automatic Failure Cleanup**:
   - If AI processing fails or the database transaction aborts, temporary files are immediately deleted from disk to prevent orphaned documents.
   - *Planned Future Capability*: Configurable retention schedules (e.g. 30 days post-event) and automated cryptographic purging of media files are planned for production enterprise deployment.
4. **Integrity & Confidentiality**:
   - Sensitive ID numbers are indexed using salted cryptographic hashes (`PII_SALT`).
   - Raw media files reside in private storage directories inaccessible to direct HTTP requests.

---

## 2. PII Classification & Data Handling Matrix

| Data Element | Storage Location | Encryption / Protection | Masked in Logs | Current Retention |
| :--- | :--- | :---: | :---: | :--- |
| **Government ID Image** | Local Secure Storage | Storage Isolation | Excluded | Scoped to Event Lifecycle |
| **Selfie Image** | Local Secure Storage | Storage Isolation | Excluded | Scoped to Event Lifecycle |
| **ID Number** | `identity_results` | Masked (`****1234`) | Masked | Scoped to Event Lifecycle |
| **ID Number Hash** | `identity_registry.id_number_hash` | Salted HMAC-SHA256 | Full Hash | Permanent (Deduplication) |
| **Date of Birth** | `verification_results` | Standard DB Field | Masked | Scoped to Event Lifecycle |
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

- **Automated Failure Cleanup**: Unlinked immediately upon processing abort or transaction rollback.
- **Database Cascade**: Relational foreign keys with `ON DELETE CASCADE` ensure that removing an event or registration cascades to verification requests, results, signals, documents, and review cases.
- **Planned Enterprise Feature**: An automated retention manager scheduled to purge media files older than a configurable retention window (e.g., 30 days) is planned for future enterprise compliance releases.
