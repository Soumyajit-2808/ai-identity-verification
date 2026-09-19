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

## 3. Public Verification Endpoints

### POST /api/verify
Submits an identity document and optional selfie for automated OCR extraction, tamper risk evaluation, face comparison, and eligibility verification.

**Request (`multipart/form-data`)**:
| Field | Type | Required | Description |
| :--- | :--- | :---: | :--- |
| `file` (or `document`) | File (Binary) | **Yes** | Identity document image (JPEG, PNG, WebP, max 12MB). |
| `selfie` | File (Binary) | No | Optional camera selfie for biometric face comparison. |
| `registration_name` (or `fullName`) | String | **Yes** | Applicant's registered full name. |
| `event_code` (or `eventId`) | String | No | Target event code (Defaults to active event `HACK2026`). |
| `email` | String | No | Applicant's registered email address for notification. |
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
      "reason": "Document shows natural compression characteristics and no detected manipulation anomalies.",
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
      "reason": "Registration name 'Jane Doe' matched extracted name 'Jane Doe' (score: 1.0, method: exact_token_set).",
      "details": { "method": "exact_token_set", "score": 1.0 }
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
