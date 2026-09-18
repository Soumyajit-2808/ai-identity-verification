# AI-Powered Identity & Eligibility Verification

An AI-powered identity and eligibility verification prototype built for the **Hackingly Platform Track (PS-003)** at the AI Build Challenge, Bengaluru.

The system extends an OCR-based identity verification workflow with additional checks for eligibility, identity consistency, duplicate/reused documents, image quality, tamper-risk indicators, and optional face verification.

---

## Problem

Hackathon registration systems often require participants to provide proof of identity or eligibility such as:

- College IDs
- Government IDs
- Aadhaar cards
- PAN cards
- Other identity documents

OCR can extract information such as a participant's date of birth, but extraction alone does not answer important verification questions:

- Does the registration name match the identity document?
- Is the same ID being reused under another name?
- Is the uploaded document suspicious or potentially tampered with?
- Is the document image too poor to verify reliably?
- Does the participant's selfie match the photograph on the ID?
- Is the participant eligible for the event?

This project adds a verification layer on top of the existing OCR workflow.

---

## Solution

The system combines multiple verification signals instead of relying on OCR alone.

```text
                    Identity Document
                           │
                           ▼
                 Existing OCR Pipeline
                  (AWS Textract)
                           │
                           ▼
                  Extracted ID Fields
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
         Eligibility   Identity      Document
           Checks       Checks         Checks
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
          Name Match     Duplicate     Tamper Risk
                         / ID Reuse
              │
              ▼
       Optional Selfie Input
              │
              ▼
          Face Matching
              │
              ▼
       Verification Engine
              │
              ▼
     ┌───────────────────────┐
     │ ELIGIBLE              │
     │ INELIGIBLE            │
     │ REVIEW                │
     └───────────────────────┘
              │
              ▼
       Confidence + Reason
```

The prototype is designed so that the OCR component can be replaced or connected to Hackingly's existing AWS Textract pipeline with minimal changes.

---

## Key Features

### 1. OCR-Based Identity Extraction

The verification workflow works with OCR-extracted identity information including:

- Name
- Date of birth
- ID number
- ID type
- Institution

The current prototype includes a local OCR fallback for standalone demonstration.

In the intended Hackingly integration, the existing **AWS Textract-based OCR pipeline** is treated as the upstream OCR source.

---

### 2. Age Eligibility Verification

The system calculates age from the extracted date of birth and checks it against configurable eligibility limits.

Example:

```text
Minimum age: 18
Maximum age: 100

DOB: 15/08/2004
Result: Eligible
```

The minimum and maximum age can be supplied as part of the verification request.

---

### 3. Registration Name Matching

The participant's registration name is compared with the name extracted from the identity document.

Example:

```text
Registration:
Rahul Sharma

ID:
Rahul Sharma

Result:
Name Match
```

A significant mismatch results in a `REVIEW` decision rather than automatic approval.

---

### 4. Duplicate Document Detection

The system generates a SHA-256 hash of the uploaded document.

This allows the prototype to identify an identical document being submitted more than once during the running session.

```text
Document A
    │
    ▼
SHA-256 Hash
    │
    ▼
Previously Seen?
   / \
 Yes  No
  │    │
REVIEW Continue
```

---

### 5. Identity Reuse Detection

The system also tracks extracted identity information such as the ID number.

This helps identify scenarios where the same identity document is submitted using different registration names.

Example:

```text
Registration 1
ID: STU1234567
Name: Rahul Sharma

Registration 2
ID: STU1234567
Name: Amit Kumar

Result:
Identity Reuse → REVIEW
```

The current prototype stores this registry in memory for demonstration purposes.

For production deployment, the identity registry would be persisted in the registration database.

---

### 6. Image Quality Analysis

Uploaded documents are checked for basic image-quality issues such as:

- Resolution
- Brightness
- Blur

Low-quality images can be routed to manual review instead of being automatically accepted.

---

### 7. Tamper-Risk Analysis

The prototype performs conservative checks for potential tampering indicators, including:

- Suspicious metadata
- JPEG recompression characteristics
- ELA-style image analysis
- Low resolution
- Unusual image characteristics

The result is treated as a **tamper-risk indicator**, not as definitive forensic proof that a document is fake.

Suspicious cases are routed to manual review.

---

### 8. Face Verification

When a selfie is provided, the system compares the face detected in the identity document with the selfie.

The prototype uses:

- DeepFace
- FaceNet512
- OpenCV face detection

Example:

```text
Identity Document Face
          │
          ▼
      Face Embedding
          │
          │ Compare
          ▼
      Selfie Face
          │
          ▼
      Face Match
```

Possible outcomes include:

```text
PASSED
REVIEW
NOT_PROVIDED
```

If no selfie is supplied, face verification is skipped.

---

## Verification Decision Model

The verification engine combines the available signals into a final result.

### ELIGIBLE

Returned when the available checks support automatic approval.

Example:

```json
{
	"decision": "ELIGIBLE",
	"confidence": 0.99,
	"reason": "Automated verification passed..."
}
```

### INELIGIBLE

Returned when the participant fails the configured eligibility requirement, such as the minimum age.

### REVIEW

Used when the system detects uncertainty or a suspicious condition.

Examples include:

- Name mismatch
- Face mismatch
- Duplicate document
- Identity reuse
- Poor image quality
- Tamper-risk indicators
- Missing critical identity information

This review pathway is intentionally conservative so that uncertain cases are not automatically treated as legitimate.

---

## Confidence Score

The system returns a confidence score alongside the decision.

Example:

```json
{
	"decision": "ELIGIBLE",
	"confidence": 0.99
}
```

The current confidence score is a **rule-based heuristic**, not a statistically calibrated probability.

It combines the outcomes of the individual verification signals.

---

## Human-Readable Explanation

Every verification result includes a human-readable reason.

Example:

```text
Automated verification passed because identity fields were
successfully extracted, image quality passed, no identical
duplicate was detected, no identity reuse was detected,
age eligibility check passed, registration name matches
the extracted name, and the selfie face matches the
identity document.
```

For suspicious cases, the system explains why manual review was triggered.

---

## Architecture

```text
┌──────────────────────────┐
│        Frontend          │
│      HTML / JavaScript   │
└────────────┬─────────────┘
             │
             ▼
┌──────────────────────────┐
│     Node.js / Express    │
│       Backend API        │
└────────────┬─────────────┘
             │
             ▼
┌──────────────────────────┐
│      Python / FastAPI    │
│       AI Service         │
└────────────┬─────────────┘
             │
      ┌──────┴───────────┐
      │                  │
      ▼                  ▼
┌──────────────┐   ┌───────────────┐
│ OCR Adapter  │   │ Verification  │
│              │   │ Engine        │
│ AWS Textract │   │               │
│ / Tesseract  │   │ Eligibility   │
└──────────────┘   │ Name Match    │
                   │ Duplicate     │
                   │ ID Reuse      │
                   │ Quality       │
                   │ Tamper Risk   │
                   │ Face Match    │
                   └───────────────┘
                            │
                            ▼
                  Decision + Confidence
                         + Reason
```

---

## Hackingly OCR Integration

The challenge requires the solution to build on top of the existing **AWS Textract-based DOB extraction pipeline**.

The project therefore separates OCR from verification.

```text
Hackingly Existing OCR
          │
          ▼
      OCR Output
          │
          ▼
    Verification Layer
          │
          ▼
Final Verification Result
```

The current prototype contains an OCR adapter and local fallback so that the complete system can be demonstrated independently.

When the Hackingly OCR implementation is provided, the integration point is the OCR output rather than the verification engine.

The expected integration flow is:

```text
Uploaded ID
     │
     ▼
Hackingly AWS Textract Pipeline
     │
     ▼
Extracted Identity Fields
     │
     ▼
AI Verification Engine
     │
     ├── Eligibility
     ├── Name Match
     ├── Duplicate
     ├── ID Reuse
     ├── Quality
     ├── Tamper Risk
     └── Face Match
     │
     ▼
Decision
```

This keeps the existing OCR pipeline as the foundation while adding the missing verification capabilities.

---

## API

### Health Check

```http
GET /api/health
```

### Verify Identity

```http
POST /api/verify
```

Multipart form fields:

| Field               | Description                      |
| ------------------- | -------------------------------- |
| `file`              | Identity document image          |
| `selfie`            | Optional selfie image            |
| `registration_name` | Name entered during registration |
| `min_age`           | Minimum permitted age            |
| `max_age`           | Maximum permitted age            |

Example response:

```json
{
	"success": true,
	"decision": "ELIGIBLE",
	"confidence": 0.99,
	"reason": "Automated verification passed...",
	"checks": {
		"ocr": {},
		"quality": {},
		"tamper": {},
		"duplicate": {},
		"identity_duplicate": {},
		"eligibility": {},
		"name_match": true,
		"face_match": {}
	}
}
```

---

## Project Structure

```text
ai-identity-verification/
│
├── backend/
│   ├── server.js
│   ├── package.json
│   └── package-lock.json
│
├── ai-service/
│   ├── main.py
│   ├── ocr/
│   │   ├── extractor.py
│   │   └── textract.py
│   │
│   ├── verification/
│   │   ├── __init__.py
│   │   ├── engine.py
│   │   └── face.py
│   │
│   └── venv/
│
├── frontend/
│   └── index.html
│
├── demo-data/
│
└── README.md
```

---

## Technology Stack

### Frontend

- HTML
- CSS
- JavaScript

### Backend

- Node.js
- Express
- Multer
- CORS

### AI Service

- Python
- FastAPI
- Uvicorn
- OpenCV
- Pillow
- Tesseract
- DeepFace
- FaceNet512

### OCR Integration

- AWS Textract

### Verification

- Rule-based verification engine
- SHA-256 document hashing
- Image quality analysis
- Tamper-risk analysis
- Face verification

---

## Running Locally

### Requirements

- Node.js
- Python 3.10+
- Tesseract OCR
- AWS credentials if using the Textract integration

---

### Start the AI Service

```powershell
cd ai-service
.\venv\Scripts\activate
python -m uvicorn main:app --host 127.0.0.1 --port 8001
```

The AI service runs at:

```text
http://127.0.0.1:8001
```

---

### Start the Backend

Open another terminal:

```powershell
cd backend
node server.js
```

The backend runs at:

```text
http://localhost:3000
```

Open the application in a browser:

```text
http://localhost:3000
```

---

## Demo Scenarios

### Scenario 1 — Valid Registration

```text
Registration Name: Rahul Sharma
ID: Valid identity document
Selfie: Matching selfie
```

Expected:

```text
ELIGIBLE
```

The result displays the extracted identity, verification checks, confidence, and explanation.

---

### Scenario 2 — Face Mismatch

```text
Registration Name: Rahul Sharma
ID: Rahul Sharma's identity document
Selfie: Different person's selfie
```

Expected:

```text
REVIEW
```

Reason:

```text
The selfie face does not sufficiently match the
identity document face.
```

---

### Scenario 3 — Registration Name Mismatch

```text
Registration Name: Different Name
ID Name: Rahul Sharma
```

Expected:

```text
REVIEW
```

The system explains that the registration name does not sufficiently match the extracted identity name.

---

## Current Prototype Limitations

This is a hackathon prototype rather than a production identity-verification platform.

### Document Authenticity

Tamper analysis identifies potential risk indicators. It does not provide forensic proof that an identity document is genuine or issued by the claimed authority.

### Duplicate Persistence

Duplicate and identity-reuse registries are currently held in memory.

Restarting the AI service clears the prototype's previously observed registrations.

A production implementation should persist these identifiers in a database.

### Confidence Calibration

The confidence score is currently heuristic and should be calibrated against a representative validation dataset before being used as a production probability.

### OCR

The current standalone prototype includes a local OCR fallback. The intended deployment integration uses Hackingly's existing AWS Textract OCR pipeline as the upstream OCR source.

---

## Future Production Extensions

Potential production improvements include:

- Persistent identity/duplicate database
- Event-specific eligibility rules
- Better document-type-specific validation
- Stronger document authenticity verification
- Structured AWS Textract integration
- Calibrated confidence scores
- Audit logs
- Human-review dashboard
- Rate limiting and abuse prevention
- Secure document storage and retention policies
- Privacy-aware handling of identity images
- Integration directly into the registration workflow

---

## Project Goal

The goal is not simply to extract information from an identity document.

The goal is to transform OCR output into an actionable verification decision:

```text
          OCR
           │
           ▼
     Identity Data
           │
           ▼
   Multiple Verification
        Signals
           │
           ▼
   ┌───────┼────────┐
   ▼       ▼        ▼
ELIGIBLE  REVIEW  INELIGIBLE
   │       │        │
   └───────┼────────┘
           ▼
 Confidence + Reason
```

The architecture allows the verification layer to extend an existing OCR pipeline without requiring major changes to the registration workflow.
