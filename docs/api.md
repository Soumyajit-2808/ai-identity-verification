# REST API Specification & Integration Reference

This document provides complete documentation for the AI Identity Verification Platform REST APIs, including request formats, response schemas, error structures, and authorization headers.

---

## 1. Global Conventions & Standards

- **Base URL**: `http://localhost:3000/api` (Backend Gateway) or `http://localhost:8001` (Direct AI Service)
- **Content Types**:
  - `multipart/form-data` for file upload endpoints (`/api/verify`).
  - `application/json` for standard queries, mutations, and resolutions.
- **Request Tracing**:
  - Clients may provide an `X-Request-Id` header (UUIDv4). If omitted, the gateway generates one automatically and echoes it back in every response header.
- **Error Format**:
  All non-2xx responses adhere to the standard error envelope:
  ```json
  {
    "success": false,
    "error": {
      "code": "VALIDATION_ERROR",
      "message": "A valid identity document file is required.",
      "requestId": "550e8400-e29b-41d4-a716-446655440000",
      "details": []
    }
  }
  ```

---

## 2. Authentication

Protected endpoints require a Bearer token in the `Authorization` header:

```http
Authorization: Bearer <jwt_token>
```

### POST /api/auth/login
Authenticates an administrative or review operator.

**Request Body (`application/json`)**:
```json
{
  "email": "admin@hackathon.org",
  "password": "Password123!"
}
```

**Response (`200 OK`)**:
```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "11111111-1111-1111-1111-111111111111",
    "email": "admin@hackathon.org",
    "name": "System Administrator",
    "role": "admin"
  }
}
```

---

## 3. Public Verification Endpoints

### POST /api/verify
Submits an identity document and optional selfie for automated OCR extraction, tamper risk evaluation, face comparison, and eligibility verification.

**Request (`multipart/form-data`)**:
| Field | Type | Required | Description |
| :--- | :--- | :---: | :--- |
| `document` | File (Binary) | **Yes** | Identity document image (JPEG, PNG, WebP, or PDF, max 10MB). |
| `selfie` | File (Binary) | No | Optional camera selfie for biometric face comparison. |
| `fullName` | String | **Yes** | Applicant's registered full name. |
| `email` | String | **Yes** | Applicant's registered email address. |
| `eventId` | String | No | Target event ID (Defaults to active event `HACK2026`). |
| `dob` | String (YYYY-MM-DD) | No | Registered date of birth for cross-validation. |
| `institution` | String | No | Registered academic institution or company. |

**Response (`200 OK`)**:
```json
{
  "success": true,
  "registrationId": "6c457f5c-dfbd-4aa4-8f7d-a2f00e9cfbc1",
  "status": "APPROVED",
  "decision": "ELIGIBLE",
  "confidence": 0.95,
  "riskScore": 0.05,
  "evidenceScore": 0.94,
  "extractedData": {
    "name": "Jane Doe",
    "dob": "1998-05-14",
    "idNumber": "123456789012",
    "idType": "Aadhaar",
    "institution": "National Tech University"
  },
  "signals": [
    {
      "signal_type": "OCR_EXTRACTION",
      "status": "PASS",
      "confidence": 0.95,
      "details": { "provider": "tesseract", "word_count": 48 }
    },
    {
      "signal_type": "ELIGIBILITY_AGE",
      "status": "PASS",
      "confidence": 1.0,
      "details": { "calculated_age": 28, "minimum_age": 18 }
    },
    {
      "signal_type": "NAME_MATCH",
      "status": "PASS",
      "confidence": 1.0,
      "details": { "method": "exact_token_set", "score": 1.0 }
    },
    {
      "signal_type": "DUPLICATE_FILE",
      "status": "PASS",
      "confidence": 1.0,
      "details": { "duplicate": false }
    },
    {
      "signal_type": "IDENTITY_REUSE",
      "status": "PASS",
      "confidence": 1.0,
      "details": { "reused": false }
    },
    {
      "signal_type": "FACE_MATCH",
      "status": "PASS",
      "confidence": 0.92,
      "details": { "verified": true, "similarity": 0.92 }
    }
  ],
  "reasons": [
    "Identity document OCR extraction successful (Tesseract).",
    "Age eligibility verified: applicant is 28 years old (threshold >= 18).",
    "Name matches registration record with high similarity (100%).",
    "Biometric face match verified against document photo (92% similarity)."
  ]
}
```

---

### GET /api/history
Returns past verification registrations scoped to the current event.

**Query Parameters**:
- `eventId` (optional): Filter registrations by event UUID or code (default: `HACK2026`).
- `limit` (optional): Maximum items to return (default: `50`).

**Response (`200 OK`)**:
```json
{
  "success": true,
  "data": [
    {
      "id": "6c457f5c-dfbd-4aa4-8f7d-a2f00e9cfbc1",
      "full_name": "Jane Doe",
      "email": "jane.doe@example.com",
      "status": "APPROVED",
      "decision": "ELIGIBLE",
      "evidence_score": 0.94,
      "created_at": "2026-09-19T13:20:00.000Z"
    }
  ]
}
```

---

## 4. Operator & Review Queue APIs

### GET /api/reviews
Retrieves pending verification review cases for operator evaluation.

**Headers**:
`Authorization: Bearer <jwt_token>` (`role: reviewer` or `admin`)

**Query Parameters**:
- `status` (optional): `OPEN`, `IN_REVIEW`, `APPROVED`, `REJECTED`, or `ESCALATED`.

**Response (`200 OK`)**:
```json
{
  "success": true,
  "data": [
    {
      "id": "33333333-3333-3333-3333-333333333331",
      "registration_id": "8f309a20-b487-4b11-9a1c-1c5c994ad240",
      "applicant_name": "Alex Johnson",
      "applicant_email": "alex.j@example.com",
      "status": "OPEN",
      "reason": "Name mismatch: Document shows 'Alexander M Johnson' (68% similarity)",
      "evidence_score": 0.62,
      "created_at": "2026-09-19T13:25:00.000Z",
      "signals": []
    }
  ]
}
```

---

### POST /api/reviews/:id/decision
Resolves a manual review case with an authoritative operator decision and audit reason.

**Headers**:
`Authorization: Bearer <jwt_token>`

**Request Body (`application/json`)**:
```json
{
  "action": "APPROVE",
  "notes": "Verified full middle name on government ID matches registration records."
}
```

**Response (`200 OK`)**:
```json
{
  "success": true,
  "message": "Review case resolved as APPROVE",
  "caseId": "33333333-3333-3333-3333-333333333331",
  "status": "RESOLVED"
}
```

---

## 5. Event Configuration APIs

### PUT /api/events/:id/policy
Updates eligibility rules and required document standards for an event.

**Headers**:
`Authorization: Bearer <jwt_token>` (`role: admin`)

**Request Body (`application/json`)**:
```json
{
  "policy": {
    "minAge": 18,
    "maxAge": 30,
    "studentRequired": true,
    "requireSelfie": false,
    "allowedDocTypes": ["Aadhaar", "Passport", "Student ID"]
  }
}
```

**Response (`200 OK`)**:
```json
{
  "success": true,
  "message": "Event eligibility policy updated successfully.",
  "eventId": "22222222-2222-2222-2222-222222222222"
}
```

---

## 6. Observability & Diagnostics

### GET /api/health
Returns system health, database connectivity status, and AI verification service availability.

**Response (`200 OK` or `503 Service Unavailable`)**:
```json
{
  "status": "healthy",
  "timestamp": "2026-09-19T13:30:00.000Z",
  "version": "2.0.0",
  "database": { "status": "connected", "engine": "sqlite" },
  "aiService": { "status": "connected", "latencyMs": 8 }
}
```

### GET /api/metrics
Provides real-time verification processing counters and decision distributions.

**Response (`200 OK`)**:
```json
{
  "totalVerifications": 142,
  "decisions": {
    "ELIGIBLE": 118,
    "REVIEW": 19,
    "INELIGIBLE": 5
  },
  "openReviews": 4,
  "averageProcessingTimeMs": 380
}
```
