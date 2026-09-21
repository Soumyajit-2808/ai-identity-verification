"""
Production AI & Computer Vision Verification Service
FastAPI application providing OCR, quality analysis, tamper risk detection, and biometric matching.
"""

import sys
import os

# Ensure UTF-8 I/O encoding on Windows to prevent DeepFace UnicodeEncodeError
os.environ["PYTHONIOENCODING"] = "utf-8"
os.environ.setdefault("TF_USE_LEGACY_KERAS", "1")
if sys.platform == "win32":
    import io
    if hasattr(sys.stdout, "buffer"):
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "buffer"):
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

from typing import Optional, List, Dict, Any
from fastapi import FastAPI, File, UploadFile, Form, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from ocr.pipeline import run_ocr, pipeline
from verification.normalizer import normalize_identity_document, ExtractedIdentity
from verification.engine import evaluate_verification, VerificationEngineResult


import os
from verification.normalizer import CANONICAL_ID_TYPES
MAX_FILE_SIZE = 12 * 1024 * 1024  # 12 MB

app = FastAPI(
    title="AI Identity & Eligibility Verification Service",
    description="Microservice for OCR extraction, image quality analysis, tamper indicators, and facial biometrics.",
    version="2.0.0"
)

# Secure internal CORS configuration
raw_cors = os.getenv("AI_CORS_ORIGIN", "http://127.0.0.1:3000,http://localhost:3000,http://127.0.0.1:8001,http://localhost:8001")
ai_cors_origins = [orig.strip() for orig in raw_cors.split(",") if orig.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ai_cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-Request-Id"],
)


def validate_image_bytes(data: bytes, field_name: str = "file"):
    """Verify binary magic bytes and size constraints for image formats."""
    if not data or len(data) < 8:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"{field_name}: File buffer is empty or too small."
        )

    if len(data) > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"{field_name}: File size exceeds maximum limit of 12MB."
        )

    is_jpeg = data[0] == 0xFF and data[1] == 0xD8 and data[2] == 0xFF
    is_png = (data[0] == 0x89 and data[1] == 0x50 and data[2] == 0x4E and data[3] == 0x47)
    is_webp = (data[0] == 0x52 and data[1] == 0x49 and data[2] == 0x46 and data[3] == 0x46)
    is_pdf = (data[0] == 0x25 and data[1] == 0x50 and data[2] == 0x44 and data[3] == 0x46)

    if is_pdf:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"{field_name}: PDF documents are not supported. Only JPEG, PNG, and WebP images are permitted."
        )

    if not (is_jpeg or is_png or is_webp):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"{field_name}: Invalid file format. Only JPEG, PNG, and WebP images are permitted."
        )


@app.get("/health")
@app.get("/api/health")
def health_check():
    return {
        "status": "ok",
        "service": "ai-identity-verification",
        "version": "2.0.0",
        "providers": {
            "aws_textract": pipeline.textract_provider.is_available(),
            "tesseract_ocr": pipeline.tesseract_provider.is_available(),
        }
    }


class OCRResponse(BaseModel):
    success: bool
    filename: Optional[str] = None
    engine: str
    extracted_identity: ExtractedIdentity
    raw_text: str


@app.post("/ocr", response_model=OCRResponse)
@app.post("/api/ocr", response_model=OCRResponse)
async def ocr_document(file: UploadFile = File(...)):
    """
    Ingest an identity document, extract raw text, and normalize key identity attributes.
    """
    contents = await file.read()
    validate_image_bytes(contents, "file")

    ocr_result = run_ocr(contents)
    if not ocr_result.success and not ocr_result.raw_text:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"OCR extraction failed: {ocr_result.error_message}"
        )

    identity = normalize_identity_document(ocr_result.raw_text, ocr_result.lines)

    return OCRResponse(
        success=True,
        filename=file.filename,
        engine=ocr_result.engine,
        extracted_identity=identity,
        raw_text=ocr_result.raw_text,
    )


class VerificationResponse(BaseModel):
    success: bool
    filename: Optional[str] = None
    verification: VerificationEngineResult


@app.post("/verify", response_model=VerificationResponse)
@app.post("/api/verify", response_model=VerificationResponse)
async def verify_identity(
    file: UploadFile = File(...),
    selfie: Optional[UploadFile] = File(None),
    registration_name: str = Form(""),
    min_age: int = Form(18),
    max_age: int = Form(100),
    require_selfie: bool = Form(False),
    strict_name_matching: bool = Form(False),
    allowed_id_types: Optional[str] = Form(None),
):
    """
    Complete identity and eligibility verification pipeline.
    """
    if min_age < 0 or min_age > 120:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="min_age must be an integer between 0 and 120."
        )
    if max_age < 0 or max_age > 120:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="max_age must be an integer between 0 and 120."
        )
    if min_age > max_age:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="min_age cannot exceed max_age."
        )
    if len(registration_name) > 150:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="registration_name cannot exceed 150 characters."
        )
    registration_name = registration_name.replace("\x00", "").strip()

    doc_contents = await file.read()
    validate_image_bytes(doc_contents, "file")

    selfie_contents = None
    if selfie:
        selfie_contents = await selfie.read()
        if len(selfie_contents) > 0:
            validate_image_bytes(selfie_contents, "selfie")
        else:
            selfie_contents = None

    # Parse and validate allowed ID types
    allowed_types_list = None
    if allowed_id_types:
        raw_types = [t.strip().upper() for t in allowed_id_types.split(',') if t.strip()]
        invalid = [t for t in raw_types if t not in CANONICAL_ID_TYPES]
        if invalid:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Unsupported ID type(s): {', '.join(invalid)}. Permitted types: {', '.join(sorted(CANONICAL_ID_TYPES))}"
            )
        allowed_types_list = raw_types

    # 1. OCR Extraction
    ocr_result = run_ocr(doc_contents)
    extracted_identity = normalize_identity_document(
        ocr_result.raw_text,
        ocr_result.lines
    )

    # 2. Complete Multi-Signal Verification
    verification_result = evaluate_verification(
        document_bytes=doc_contents,
        extracted=extracted_identity,
        registration_name=registration_name,
        min_age=min_age,
        max_age=max_age,
        selfie_bytes=selfie_contents,
        require_selfie=require_selfie,
        strict_name_matching=strict_name_matching,
        allowed_id_types=allowed_types_list,
    )

    return VerificationResponse(
        success=True,
        filename=file.filename,
        verification=verification_result,
    )