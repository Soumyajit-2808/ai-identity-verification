# REST API Specification & Integration Reference

This document provides complete documentation for the AI Identity Verification Platform REST APIs, including exact paths, request payloads, response schemas, error envelopes, and authorization requirements.

---

## 1. Global Conventions & Standards

- **Base URL**: `http://localhost:3000/api` (Backend Gateway) or `http://127.0.0.1:8001` (Internal AI Service)
- **Supported Media Formats**: `JPEG`, `PNG`, `WebP` (Max 12MB). PDF documents are explicitly **not supported**.
- **Request Tracing**: Clients may supply an `X-Request-Id` header (UUIDv4). If omitted, the gateway generates one automatically and echoes it back in every response header.
- **Canonical ID Types**: `['PASSPORT', 'DRIVING_LICENSE', 'STUDENT_ID', 'NATIONAL_ID', 'AADHAAR', 'PAN', 'VOTER_ID']`.
- **Error Format**:
  All non-2xx responses adhere to the standard application error envelope:
  ```json
  {
    "success": false,
    "error": "Detailed human-readable error description.",
    "code": "ERROR_CODE",
    "requestId": "550e8400-e29b-41d4-a716-446655440000"
  }
  ```

---

## 2. Authentication

Protected endpoints require a Bearer token in the `Authorization` header:

```http
Authorization: Bearer <jwt_token>
```

### POST /api/auth/login
Authenticates an administrator or review operator.

**Request Body (`application/json`)**:
```json
{
  "email": "admin@verifyid.local",
  "password": "Admin@12345"
}
```

**Response (`200 OK`)**:
```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "11111111-1111-1111-1111-111111111111",
    "email": "admin@verifyid.local",
    "fullName": "System Administrator",
    "role": "admin",
    "organizationName": "National Hackathon Federation"
  }
}
```

---

## 3. Verification Endpoints

### POST /api/verify
Submits an identity document image and optional selfie for automated OCR extraction, image quality analysis, tamper-risk evaluation, facial geometry comparison, and eligibility verification.

**Request (`multipart/form-data`)**:
| Field | Type | Required | Description |
| :--- | :--- | :---: | :--- |
| `file` (or `document`) | File (Binary) | **Yes** | Identity document image (JPEG, PNG, WebP, max 12MB). |
| `selfie` | File (Binary) | No | Optional camera selfie for facial biometrics comparison. |
| `registration_name` (or `fullName`) | String | **Yes** | Applicant's registered full name (max 150 chars). |
| `event_code` (or `eventId`) | String | No | Target event code (defaults to active event `HACK2026`). |
| `email` | String | No | Applicant's email address. |
| `phone` | String | No | Applicant's contact phone number. |

**Response (`200 OK`)**:
```json
{
  "success": true,
  "decision": "ELIGIBLE",
  "confidence_score": 0.94,
  "evidence_score": 0.95,
  "risk_score": 0.05,
  "summary_reason": "Automated verification passed successfully. Identity document fields were extracted, document quality is acceptable, no tampering anomalies were observed, age eligibility was verified, and registration name matches the identity document.",
  "requestId": "6c457f5c-dfbd-4aa4-8f7d-a2f00e9cfbc1",
  "registrationId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "reviewCaseId": null,
  "identity": {
    "name": "Jane Doe",
    "date_of_birth": "1998-05-14",
    "calculated_age": 28,
    "id_number_masked": "********9012",
    "id_type": "AADHAAR",
    "institution": "National Tech University"
  },
  "extractedData": {
    "name": "Jane Doe",
    "dob": "1998-05-14",
    "idNumber": "********9012",
    "idType": "AADHAAR",
    "institution": "National Tech University"
  },
  "signals": [
    {
      "signal_type": "OCR",
      "status": "PASSED",
      "score": 1.0,
      "reason": "Essential identity fields (name, date of birth) were extracted successfully. Document type identified as AADHAAR.",
      "details": { "has_name": true, "has_dob": true, "has_id_number": true, "id_type": "AADHAAR" }
    },
    {
      "signal_type": "QUALITY",
      "status": "PASSED",
      "score": 1.0,
      "reason": "Image quality is clear and legible for automated identity verification.",
      "details": { "blur_score": 240, "brightness": 128, "contrast": 58, "resolution": "1600x1000" }
    },
    {
      "signal_type": "TAMPER",
      "status": "PASSED",
      "score": 1.0,
      "reason": "No basic digital manipulation or compression anomaly signals detected by automated checks.",
      "details": { "risk_level": "LOW", "editing_tools": [] }
    },
    {
      "signal_type": "ELIGIBILITY",
      "status": "PASSED",
      "score": 1.0,
      "reason": "Applicant age (28) satisfies the configured eligibility requirement (18 to 100 years).",
      "details": { "min_age": 18, "max_age": 100, "calculated_age": 28 }
    },
    {
      "signal_type": "NAME_MATCH",
      "status": "PASSED",
      "score": 1.0,
      "reason": "Registration name 'Jane Doe' matched extracted name 'Jane Doe' (score: 1.0, method: EXACT_MATCH).",
      "details": { "method": "EXACT_MATCH", "score": 1.0 }
    },
    {
      "signal_type": "DUPLICATE_FILE",
      "status": "PASSED",
      "score": 1.0,
      "reason": "No identical document file submission previously detected for this event.",
      "details": { "fileHash": "a1b2c3d4..." }
    },
    {
      "signal_type": "IDENTITY_REUSE",
      "status": "PASSED",
      "score": 1.0,
      "reason": "Extracted ID number has not been seen in any prior registration for this event.",
      "details": {}
    }
  ]
}
```

### GET /api/verifications
Retrieves historical verification records scoped strictly to the authenticated user's organization.

**Headers**:
`Authorization: Bearer <jwt_token>` (`role: reviewer` or `admin`)

**Query Parameters**:
- `eventId` (optional): Filter registrations by event UUID.
- `limit` (optional): Maximum items to return (default: `50`).

**Response (`200 OK`)**:
```json
{
  "success": true,
  "count": 1,
  "verifications": [
    {
      "request_id": "6c457f5c-dfbd-4aa4-8f7d-a2f00e9cfbc1",
      "registration_name": "Jane Doe",
      "email": "jane.doe@example.com",
      "decision": "ELIGIBLE",
      "confidence_score": 0.94,
      "event_name": "AI Build Challenge 2026",
      "created_at": "2026-09-19T13:20:00.000Z"
    }
  ]
}
```

### GET /api/verifications/:id
Retrieves detailed verification records, signals, and sanitized document metadata by verification request UUID.

**Headers**:
`Authorization: Bearer <jwt_token>` (`role: reviewer` or `admin`)

---

## 4. Operator Review Queue APIs

### GET /api/review-cases
Retrieves manual review cases for operator evaluation scoped to the user's organization.

**Headers**:
`Authorization: Bearer <jwt_token>` (`role: reviewer` or `admin`)

**Query Parameters**:
- `status` (optional): Filter by `OPEN`, `IN_REVIEW`, `APPROVED`, `REJECTED`, or `ESCALATED`.
- `eventId` (optional): Filter by event UUID.
- `limit` (optional): Maximum records (default: `50`).

**Response (`200 OK`)**:
```json
{
  "success": true,
  "count": 1,
  "cases": [
    {
      "id": "33333333-3333-3333-3333-333333333331",
      "registration_id": "8f309a20-b487-4b11-9a1c-1c5c994ad240",
      "registration_name": "Alex Johnson",
      "email": "alex.j@example.com",
      "status": "OPEN",
      "priority": "HIGH",
      "summary_reason": "Manual operator review is required due to: registration name discrepancy.",
      "created_at": "2026-09-19T13:25:00.000Z"
    }
  ]
}
```

### GET /api/review-cases/:id
Fetches complete details for a single review case including extracted identity attributes, signals, and associated documents.

**Headers**:
`Authorization: Bearer <jwt_token>` (`role: reviewer` or `admin`)

### PATCH /api/review-cases/:id
Applies an operator decision (`APPROVED`, `REJECTED`, `IN_REVIEW`, `OPEN`, `ESCALATED`).

**Headers**:
`Authorization: Bearer <jwt_token>` (`role: reviewer` or `admin`)

**Request Body (`application/json`)**:
```json
{
  "status": "APPROVED",
  "resolutionReason": "Verified full middle name on government ID matches registration records.",
  "reviewerNotes": "Checked document photo manually; facial features match selfie.",
  "expectedStatus": "OPEN"
}
```

**Response (`200 OK`)**:
```json
{
  "success": true,
  "case": {
    "id": "33333333-3333-3333-3333-333333333331",
    "status": "APPROVED",
    "resolution_reason": "Verified full middle name on government ID matches registration records.",
    "resolved_at": "2026-09-19T13:30:00.000Z"
  }
}
```

---

## 5. Event Configuration APIs

### GET /api/events
Returns active public events with internal organization identifiers sanitized.

### GET /api/events/:code
Returns event details by public event code (e.g. `HACK2026`).

### PATCH /api/events/:id
Updates verification policy for an event. Scoped to the event organizer's organization.

**Headers**:
`Authorization: Bearer <jwt_token>` (`role: admin` or `organizer`)

**Request Body (`application/json`)**:
```json
{
  "minAge": 18,
  "maxAge": 30,
  "allowedIdTypes": ["AADHAAR", "PASSPORT", "STUDENT_ID"],
  "requireSelfie": true,
  "strictNameMatching": false
}
```

**Response (`200 OK`)**:
```json
{
  "success": true,
  "event": {
    "id": "22222222-2222-2222-2222-222222222222",
    "code": "HACK2026",
    "min_age": 18,
    "max_age": 30,
    "allowed_id_types": ["AADHAAR", "PASSPORT", "STUDENT_ID"],
    "require_selfie": true,
    "strict_name_matching": false
  }
}
```

---

## 6. Observability & Diagnostics

### GET /api/health
Returns system health, database engine, and AI verification microservice status.

### GET /api/metrics
Provides real-time verification processing counters and decision distributions scoped to the authenticated operator's organization.

**Headers**:
`Authorization: Bearer <jwt_token>` (`role: reviewer` or `admin`)

**Response (`200 OK`)**:
```json
{
  "success": true,
  "timestamp": "2026-09-19T14:30:00.000Z",
  "organizationId": "11111111-1111-1111-1111-111111111111",
  "metrics": {
    "totalVerifications": 142,
    "decisions": {
      "ELIGIBLE": 118,
      "REVIEW": 19,
      "INELIGIBLE": 5
    },
    "openReviews": 4,
    "uptimeSeconds": 14500,
    "memoryUsageMb": 85
  }
}
```

### GET /api/audit-logs
Returns audit trail logs scoped to the authenticated administrator's organization.

**Headers**:
`Authorization: Bearer <jwt_token>` (`role: admin`)
