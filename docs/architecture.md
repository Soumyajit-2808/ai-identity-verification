# Architecture Design Document — VerifyID AI

## Overview & System Topology

VerifyID AI is a production-oriented, multi-tenant identity and eligibility verification platform. The system ingests identity documents and optional facial selfies, orchestrates multi-signal verification, enforces persistent deduplication, and coordinates manual operator reviews.

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        PRESENTATION TIER (UI)                          │
│  • Responsive Web Application (320px to 1920px fluid layout)           │
│  • Participant Verification Portal with live drag-and-drop preview     │
│  • Operator Review Queue with side-by-side inspection & resolution     │
│  • Historical Audit Explorer & Event Policy Configuration              │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ HTTPS REST / Multipart
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│               API GATEWAY & APPLICATION SERVER (Node.js)               │
│  • Security Layer: Helmet headers, rate limiters, CORS allowlisting    │
│  • Magic-Byte Inspector: Validates binary signatures (JPEG, PNG, WebP) │
│  • Secure Object Store Abstraction: SHA-256 hashed filenames           │
│  • RBAC & JWT Auth: Admin, Organizer, Reviewer operator roles          │
│  • Verification Orchestrator: Multi-step atomic transaction pipeline   │
│  • Structured Logging & Correlation IDs: X-Request-Id tracing          │
└───────────────────┬────────────────────────────────┬───────────────────┘
                    │                                │
                    ▼                                ▼
┌──────────────────────────────────────┐ ┌───────────────────────────────┐
│     PERSISTENCE TIER (PostgreSQL)    │ │   AI & COMPUTER VISION ENGINE │
│  • Organizations & Events            │ │            (FastAPI)          │
│  • Registrations & Stored Documents  │ │  • OCR Pipeline & Providers:  │
│  • Immutable Verification Requests   │ │    - AWS Textract (Cloud)     │
│  • Verification Results & Signals    │ │    - Tesseract (Local Fallback│
│  • Persistent Identity Deduplication │ │  • Identity Normalizer:       │
│    Registry (Unique Salted Hashes)   │ │    - Multi-format DOB parser  │
│  • Review Cases & Resolution States  │ │    - RegEx ID Format Cleaners │
│  • Append-Only Audit Trail           │ │  • Advanced Name Matcher:     │
└──────────────────────────────────────┘ │    - Token order, Initials,   │
                                         │      Jaro-Winkler, Levenshtein│
                                         │  • Image Quality Analyzer     │
                                         │  • Tamper-Risk Analyzer       │
                                         │  • Face Biometrics Engine     │
                                         └───────────────────────────────┘
```

---

## Architectural Principles & Trade-Offs

### 1. Separation of Gateway and Inference
- **Decision**: Retain Node.js Express as the API gateway and use Python FastAPI for computer vision and OCR.
- **Rationale**: Node.js excels at high-concurrency I/O, streaming multipart file uploads, rate limiting, and relational database coordination. Python is the industry-standard runtime for computer vision libraries (OpenCV, DeepFace, PyTorch, Pillow, Tesseract).
- **Hardening**: File uploads are inspected for binary signatures before any downstream forwarding. If the AI service is degraded or offline, the gateway returns structured 502/503 errors without crashing.

### 2. Relational Database with Transactional Boundaries
- **Decision**: PostgreSQL as the production database, with an automated SQLite abstraction for development and testing.
- **Rationale**: Verification events must be auditable and race-condition resistant. When an applicant submits an ID, the registration record, document metadata, verification decision, atomic signals, deduplication registry entry, and optional review case are wrapped inside a single atomic database transaction (`BEGIN ... COMMIT`).
- **Concurrency Protection**: Simultaneous requests with the exact same ID number are protected by unique database constraints (`UNIQUE(event_id, id_number_hash)`), preventing race conditions.

### 3. Separation of Confidence, Risk, and Evidence
- **Decision**: Eliminate naive `confidence = 0.99` heuristics.
- **Rationale**: An automated check can have high evidence corroboration while simultaneously detecting anomaly risks. The platform explicitly decomposes verification into:
  - **Evidence Score** ($0.0 \dots 1.0$): Degree to which positive identity claims were corroborated.
  - **Anomaly Risk Score** ($0.0 \dots 1.0$): Degree to which quality defects, tampering indicators, or discrepancies were observed.
  - **Calibrated Confidence** ($0.10 \dots 0.98$): Calibrated representation computed as $\text{Evidence} \times (1.0 - 0.7 \times \text{Risk})$.

### 4. Conservative Decision Policy
- **Decision**: Three distinct decision states: `ELIGIBLE`, `INELIGIBLE`, and `REVIEW`.
- **Policy**:
  - `INELIGIBLE`: Only returned when applicant definitively violates hard eligibility bounds (e.g. age below event minimum).
  - `REVIEW`: Returned whenever automated certainty is compromised (e.g. name discrepancy, duplicate document, identity reuse, image blur, tamper indicator, face mismatch).
  - `ELIGIBLE`: Returned only when all checks pass with high corroboration.
