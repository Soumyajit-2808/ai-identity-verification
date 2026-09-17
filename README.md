# VerifyID AI

AI-powered identity and eligibility verification for hackathon registrations.

## Problem

Hackathon registration systems can extract information such as date of birth from identity documents, but OCR alone cannot determine whether a submission should be automatically accepted.

**VerifyID AI** adds a verification layer around document processing to evaluate identity, eligibility, document quality, duplicate submissions, and registration consistency.

The system provides an automated decision together with a confidence value and a human-readable explanation, while routing suspicious or uncertain cases for manual review.

## Key Features

- Identity document upload
- OCR-based text extraction
- Structured identity field extraction
- Image quality assessment
- Basic document tamper-risk detection
- Exact duplicate document detection
- Identity/ID-number reuse detection
- Age-based eligibility verification
- Registration-name matching
- Automated verification decision
- Confidence score
- Human-readable verification reason
- Verification history for the current demo session
- Browser-based demonstration interface
- FastAPI Swagger API for testing

## Verification Decisions

The system produces one of three decisions:

| Decision | Meaning |
|---|---|
| `ELIGIBLE` | Available automated checks passed |
| `REVIEW` | One or more checks require human verification |
| `INELIGIBLE` | Configured eligibility requirement was not satisfied |

The system is designed to route uncertain cases to **REVIEW** rather than automatically approving them.

## Architecture

```text
                         VERIFYID AI
                              |
                              v
                     ┌─────────────────┐
                     │   Browser UI    │
                     │ HTML/CSS/JS     │
                     └────────┬────────┘
                              |
                              v
                     ┌─────────────────┐
                     │ Node.js         │
                     │ Express Backend │
                     └────────┬────────┘
                              |
                              v
                  ┌────────────────────────┐
                  │ Python FastAPI Service │
                  └────────────┬───────────┘
                               |
              ┌────────────────┼────────────────┐
              |                |                |
              v                v                v
        ┌───────────┐   ┌─────────────┐   ┌──────────────┐
        │    OCR    │   │    Image    │   │ Verification │
        │ Tesseract │   │   Analysis  │   │    Engine    │
        └─────┬─────┘   └──────┬──────┘   └──────┬───────┘
              |                |                 |
              |          ┌─────┴─────┐           |
              |          |           |           |
              |       Quality     Tamper         |
              |        Check       Risk          |
              |          |           |           |
              └──────────┴───────────┴───────────┘
                               |
                               v
                    ┌────────────────────┐
                    │ Verification       │
                    │ Decision Engine    │
                    └─────────┬──────────┘
                              |
                ┌─────────────┼─────────────┐
                |             |             |
                v             v             v
            ELIGIBLE        REVIEW      INELIGIBLE
                |             |             |
                └─────────────┼─────────────┘
                              |
                              v
                 Confidence + Explanation
```

## Verification Pipeline

```text
Document Upload
       |
       v
      OCR
       |
       v
Identity Field Extraction
       |
       +-------------------------+
       |                         |
       v                         v
Image Quality              Tamper-Risk
Assessment                  Analysis
       |                         |
       +------------+------------+
                    |
                    v
             Duplicate Check
                    |
                    v
            Identity Reuse Check
                    |
                    v
             Age Eligibility
                    |
                    v
            Registration Name
                Matching
                    |
                    v
          Verification Engine
                    |
                    v
        Decision + Confidence
                    |
                    v
        Human-readable Reason
```

## Identity Fields

The current prototype attempts to extract:

- Name
- Date of birth
- ID number

The extracted information is then used by the verification engine for eligibility and duplicate/reuse checks.

## Verification Checks

### 1. OCR

The uploaded document is processed using Tesseract OCR.

The OCR output is converted into structured fields where possible.

Example:

```json
{
  "name": "Rahul Sharma",
  "date_of_birth": "15/08/2004",
  "id_number": "STU1234567"
}
```

### 2. Image Quality

The prototype evaluates basic image properties such as:

- Image dimensions
- Blur score
- Brightness

Poor-quality documents can be routed for manual review instead of being blindly accepted.

### 3. Tamper Risk

The prototype performs basic tamper-risk checks.

The result is treated as a **risk signal**, not definitive proof that a document is genuine or fraudulent.

Example:

```text
risk: low
```

Higher-risk results can be routed for manual review.

### 4. Exact Duplicate Detection

The uploaded file is hashed and compared with previously submitted files during the current service session.

```text
First submission
      |
      v
Hash stored
      |
      v
Second identical submission
      |
      v
Duplicate detected
      |
      v
REVIEW
```

### 5. Identity Reuse Detection

The system also checks the extracted ID number separately from the file hash.

This allows the prototype to detect a situation where the same identity information is submitted using a different image file.

```text
Image A
   |
   v
ID: STU1234567
   |
   v
Stored identity

Image B
   |
   v
ID: STU1234567
   |
   v
Identity reuse detected
   |
   v
REVIEW
```

### 6. Age Eligibility

The registration flow provides configurable minimum and maximum ages.

Example:

```text
Minimum Age: 18
Maximum Age: 100
```

The extracted date of birth is used to calculate the applicant's age and determine whether the configured eligibility range is satisfied.

### 7. Registration Name Matching

The name entered during registration is compared with the name extracted from the identity document.

Example:

```text
Registration Name: Rahul Sharma
Document Name:     Rahul Sharma
                         |
                         v
                      MATCHED
```

If the names do not match, the submission can be routed for manual review.

## Example Verification Response

```json
{
  "success": true,
  "verification": {
    "decision": "ELIGIBLE",
    "confidence": 0.99,
    "reason": "Automated verification passed because identity fields were successfully extracted, image quality passed, no identical duplicate was detected, no basic tampering indicators were detected, age eligibility check passed, registration name matches the extracted name.",
    "identity": {
      "name": "Rahul Sharma",
      "date_of_birth": "15/08/2004",
      "id_number": "STU1234567"
    },
    "checks": {
      "ocr": "passed",
      "quality": {
        "status": "passed"
      },
      "tamper_risk": {
        "status": "passed",
        "risk": "low"
      },
      "duplicate": {
        "status": "not_detected"
      },
      "identity_duplicate": {
        "status": "not_detected"
      },
      "eligibility": {
        "status": "passed",
        "age": 22
      },
      "name_match": true
    }
  }
}
```

## Technology Stack

### Frontend

- HTML5
- CSS3
- JavaScript
- Fetch API

### Backend

- Node.js
- Express
- Multer
- CORS

### AI / Computer Vision Service

- Python
- FastAPI
- Uvicorn
- Tesseract OCR
- PyTesseract
- OpenCV
- Pillow

## Project Structure

```text
ai-identity-verification/
│
├── ai-service/
│   ├── main.py
│   ├── ocr/
│   │   └── extractor.py
│   ├── verification/
│   │   ├── __init__.py
│   │   └── engine.py
│   └── venv/
│
├── backend/
│   ├── server.js
│   ├── package.json
│   └── package-lock.json
│
├── frontend/
│   └── index.html
│
├── demo-data/
│   └── README.md
│
├── database/
│
├── .gitignore
└── README.md
```

> `venv/` and `node_modules/` are development dependencies and should not be committed to Git.

## Running Locally

### Prerequisites

Install:

- Python 3.10+
- Node.js
- npm
- Tesseract OCR
- Git

Verify Tesseract:

```powershell
tesseract --version
```

### 1. Start the AI Service

Open a terminal:

```powershell
cd ai-service
.\venv\Scripts\Activate.ps1
python -m uvicorn main:app --host 127.0.0.1 --port 8001
```

AI service:

```text
http://127.0.0.1:8001
```

Swagger API documentation:

```text
http://127.0.0.1:8001/docs
```

Health check:

```text
http://127.0.0.1:8001/health
```

### 2. Start the Backend

Open a second terminal:

```powershell
cd backend
npm install
npm run dev
```

Application:

```text
http://localhost:3000
```

### 3. Open the Application

Open:

```text
http://localhost:3000
```

The browser interface allows a registration name, identity document and eligibility range to be submitted for verification.

## Demo Scenarios

### Scenario 1 — Valid Registration

Use a synthetic or anonymized document containing:

```text
Name: Rahul Sharma
DOB: 15/08/2004
ID: STU1234567
```

Enter:

```text
Registration Name: Rahul Sharma
Minimum Age: 18
Maximum Age: 100
```

Expected result:

```text
ELIGIBLE
```

Expected checks:

```text
OCR              passed
Image Quality    passed
Tamper Risk      low
Duplicate        not detected
Identity Reuse   not detected
Eligibility      passed
Name Match       matched
```

### Scenario 2 — Registration Name Mismatch

Use the same document but enter:

```text
Registration Name: Amit Kumar
```

The extracted document name remains:

```text
Rahul Sharma
```

Expected result:

```text
REVIEW
```

Expected:

```text
Name Match: mismatch
```

This demonstrates that the registration identity is compared against the document identity.

### Scenario 3 — Reused Document

Submit the same document again during the same running service session.

Expected result:

```text
REVIEW
```

The system can report:

```text
Duplicate: detected
Identity Reuse: detected
```

This demonstrates duplicate and identity-reuse handling.

## Design Principle: Review Uncertainty

The system does not attempt to automatically approve every submission.

When important checks fail or suspicious signals are detected, the system routes the case to:

```text
REVIEW
```

This reduces the risk of treating uncertain automated results as definitive identity decisions.

## Current Prototype Scope

The working prototype currently demonstrates:

- Document upload
- OCR
- Identity extraction
- Image-quality analysis
- Basic tamper-risk analysis
- Exact duplicate detection
- Identity-number reuse detection
- Age eligibility
- Registration-name matching
- Decision engine
- Confidence score
- Human-readable reasoning
- Browser-based verification interface
- Verification history

## Integration with Existing OCR Pipeline

The verification layer is designed to extend an existing OCR-based registration workflow.

In a production environment, the current OCR component can be connected to the existing **AWS Textract-based DOB extraction pipeline**, while retaining the downstream verification checks for quality, duplicate detection, identity reuse, eligibility and registration consistency.

The current local Tesseract implementation provides a zero-cost development and demonstration fallback.

## Future Integration

Potential production integrations include:

- AWS Textract-based OCR pipeline
- Persistent database-backed duplicate detection
- Secure document storage
- Audit logging
- Stronger document authenticity analysis
- Face verification when a selfie is provided
- Institution verification
- Document-type-specific validation
- Authentication and role-based access
- Production monitoring
- Human-review workflow

## Production Considerations

This prototype is intended to demonstrate the verification workflow.

For production deployment, identity verification should use stronger controls than the basic prototype checks implemented here.

In particular:

- Tamper-risk detection should not be treated as proof of authenticity.
- Duplicate detection should use persistent, secure storage.
- Identity documents should be encrypted and access-controlled.
- Sensitive information should not be exposed unnecessarily.
- Automated decisions should provide an appropriate manual-review path.
- Confidence scores should be calibrated against representative validation data.
- The existing AWS Textract pipeline can be integrated as the production OCR layer.

## Privacy

Use **synthetic or anonymized identity documents** for development and demonstrations.

Do not commit real identity documents, personally identifiable information, credentials, API keys or secrets to the repository.

## Demo Flow

```text
1. Enter applicant registration name
             |
             v
2. Upload identity document
             |
             v
3. Click Verify Identity
             |
             v
4. OCR extracts identity
             |
             v
5. Quality and tamper-risk checks
             |
             v
6. Duplicate and identity-reuse checks
             |
             v
7. Eligibility calculation
             |
             v
8. Registration-name matching
             |
             v
9. Decision engine
             |
             v
10. ELIGIBLE / REVIEW / INELIGIBLE
             |
             v
11. Confidence + human-readable explanation
```

## Project Status

**Working Prototype**

The current implementation provides an end-to-end browser-to-backend-to-AI-service verification workflow suitable for demonstration and further integration.

## License

This project was developed as a prototype for an AI build/hackathon challenge.