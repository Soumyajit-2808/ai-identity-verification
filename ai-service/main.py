"""
Production AI & Computer Vision Verification Service
FastAPI application providing OCR, quality analysis, tamper risk detection, and biometric matching.
"""

from typing import Optional, List, Dict, Any
from fastapi import FastAPI, File, UploadFile, Form, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from ocr.pipeline import run_ocr, pipeline
from verification.normalizer import normalize_identity_document, ExtractedIdentity
from verification.engine import evaluate_verification, VerificationEngineResult


app = FastAPI(
    title="AI Identity & Eligibility Verification Service",
    description="Production microservice for OCR extraction, image quality analysis, tamper indicators, and facial biometrics.",
    version="2.0.0"
)

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def validate_image_bytes(data: bytes, field_name: str = "file"):
    """Verify binary magic bytes for image formats."""
    if not data or len(data) < 8:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"{field_name}: File buffer is empty or too small."
        )

    is_jpeg = data[0] == 0xFF and data[1] == 0xD8 and data[2] == 0xFF
    is_png = (data[0] == 0x89 and data[1] == 0x50 and data[2] == 0x4E and data[3] == 0x47)
    is_webp = (data[0] == 0x52 and data[1] == 0x49 and data[2] == 0x46 and data[3] == 0x46)
    is_pdf = (data[0] == 0x25 and data[1] == 0x50 and data[2] == 0x44 and data[3] == 0x46)

    if not (is_jpeg or is_png or is_webp or is_pdf):
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


@app.post("/api/verify", response_model=VerificationResponse)
async def verify_identity(
    file: UploadFile = File(...),
    selfie: Optional[UploadFile] = File(None),
    registration_name: str = Form(""),
    min_age: int = Form(18),
    max_age: int = Form(100),
    require_selfie: bool = Form(False),
    strict_name_matching: bool = Form(False),
):
    """
    Complete identity and eligibility verification pipeline.
    """
    doc_contents = await file.read()
    validate_image_bytes(doc_contents, "file")

    selfie_contents = None
    if selfie:
        selfie_contents = await selfie.read()
        if len(selfie_contents) > 0:
            validate_image_bytes(selfie_contents, "selfie")
        else:
            selfie_contents = None

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
    )

    return VerificationResponse(
        success=True,
        filename=file.filename,
        verification=verification_result,
    )