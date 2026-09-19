# Verification Engine & Multi-Signal Specification

The VerifyID AI Verification Engine synthesizes multiple atomic verification signals rather than relying on OCR alone. Each signal evaluates an independent aspect of the identity document and produces structured evidence.

---

## Atomic Verification Signals

### 1. OCR Extraction Signal (`OCR`)
- **Purpose**: Verifies that essential identity fields (Name, Date of Birth, ID Number, ID Type) could be read and parsed.
- **Provider Cascade**:
  1. Primary: AWS Textract (`DetectDocumentText`) when credentials are present.
  2. Secondary: Local Tesseract OCR engine (auto-discovered from system PATH or environment).
- **Extraction Rules**:
  - Multi-format Date of Birth parser validating calendar bounds and reasonable age ranges (1900 to present year).
  - Document-type specific patterns for PAN (`[A-Z]{5}[0-9]{4}[A-Z]`), Aadhaar (`\d{4}\s\d{4}\s\d{4}`), Passport (`[A-Z][1-9]\d{6}`), Voter ID (`[A-Z]{3}\d{7}`), and Student IDs.
- **Outcomes**: `PASSED` (when Name and DOB are extracted), `REVIEW` (when essential fields are missing).

### 2. Document Quality Signal (`QUALITY`)
- **Purpose**: Evaluates image clarity, lighting, resolution, and framing before trusting downstream signals.
- **Metrics & Thresholds**:
  - **Sharpness / Blur**: Computed via Laplacian variance ($\text{var}(\nabla^2 I)$).
    - Threshold: $\text{var} < 30.0 \to \text{FAILED}$ (severe blur).
    - Threshold: $30.0 \le \text{var} < 65.0 \to \text{REVIEW}$ (mild blur).
  - **Brightness**: Mean grayscale intensity ($\mu$).
    - Threshold: $\mu < 35.0 \to \text{REVIEW}$ (underexposed/dark).
    - Threshold: $\mu > 235.0 \to \text{REVIEW}$ (overexposed/blown out).
  - **Contrast**: Standard deviation of pixel values ($\sigma$).
    - Threshold: $\sigma < 25.0 \to \text{REVIEW}$ (flat contrast).
  - **Glare Detection**: Proportion of fully saturated pixels ($> 250$).
    - Threshold: $> 15\% \to \text{REVIEW}$ (flash glare obstruction).
  - **Resolution**: Width $\ge 600\text{px}$, Height $\ge 350\text{px}$.

### 3. Tamper-Risk Signal (`TAMPER`)
- **Purpose**: Conservative heuristic analysis of structural anomalies and digital manipulation indicators.
- **Methods**:
  - **EXIF Metadata Inspection**: Scans for software manipulation tags (e.g. Photoshop, GIMP, Canva, PicsArt, Photopea).
  - **JPEG Error Level Analysis (ELA)**: Recompresses image at 90% quality and computes mean absolute difference between original and recompressed frames. High non-uniform variance ($> 22.0$) flags potential localized edits.
  - **Aspect Ratio Boundaries**: Documents with extreme ratios ($< 0.45$ or $> 3.50$) flag suspicious cropping.
- **Honest Limitations**: Explicitly labeled as anomaly indicators. Does not constitute forensic proof of forgery or issuer authentication.

### 4. Duplicate Document Signal (`DUPLICATE_FILE`)
- **Purpose**: Identifies identical document files submitted across different registrations.
- **Method**: SHA-256 cryptographic hash of image binary checked against the persistent database.
- **Distinction**:
  - Same applicant resubmitting $\to$ Informational update.
  - Different applicant submitting identical document $\to$ Flagged as `REVIEW`.

### 5. Identity Reuse Signal (`IDENTITY_REUSE`)
- **Purpose**: Prevents the same government or student ID number from being reused by multiple registrants.
- **Method**: Salted HMAC-SHA-256 hash of normalized ID number checked across the event's identity registry.
- **Outcomes**:
  - ID previously registered under a different name $\to$ `REVIEW` (High Risk).
  - ID not previously observed $\to$ `PASSED`.

### 6. Eligibility Verification Signal (`ELIGIBILITY`)
- **Purpose**: Enforces event-specific age rules.
- **Method**: Calculates exact age in years from parsed date of birth against the event's `min_age` and `max_age` policy settings.
- **Outcomes**:
  - Age $<$ `min_age` or Age $>$ `max_age` $\to$ `FAILED` (Forces overall `INELIGIBLE` decision).
  - Unparseable date of birth $\to$ `REVIEW`.
  - Ambiguous date of birth crossing eligibility boundaries $\to$ `REVIEW`.
  - Age within range $\to$ `PASSED`.

### 7. Registration Name Matching Signal (`NAME_MATCH`)
- **Purpose**: Compares registrant's entered name with the document's extracted name.
- **Matching Pipeline**:
  1. Exact match after tokenization and honorific stripping.
  2. Token reordering (e.g., "Sharma Rahul" vs "Rahul Sharma").
  3. Initials expansion (e.g., "R. Sharma" vs "Rahul Sharma").
  4. Subset matching (e.g., "Rahul Kumar Sharma" vs "Rahul Sharma").
  5. Jaro-Winkler distance and Levenshtein edit distance for OCR character confusion tolerance.
- **Threshold**: Default $\ge 0.75$; Strict Mode $\ge 0.90$.

### 8. Facial Biometrics Signal (`FACE_MATCH`)
- **Purpose**: Verifies that the participant's live selfie matches the photo on the identity document.
- **Model**: DeepFace with FaceNet512 embeddings.
- **State Differentiation**:
  - `MATCH_CONFIRMED`: Distance $\le 0.30$.
  - `MISMATCH`: Distance $> 0.30$.
  - `NO_FACE_DETECTED`: No face detected in ID or selfie.
  - `MULTIPLE_FACES`: Multiple faces detected in selfie.
  - `NOT_PROVIDED`: Selfie omitted (routes to `REVIEW` if mandatory, `SKIPPED` if optional).
- **Limitation**: 2D geometric comparison. Does not verify active 3D liveness.
