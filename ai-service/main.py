from fastapi import FastAPI, File, UploadFile, HTTPException
from PIL import Image
from io import BytesIO

from ocr.extractor import process_document
from verification.engine import verify_document


app = FastAPI(
    title="AI Identity Verification Service",
    description="AI and computer vision service for identity verification",
    version="1.0.0"
)


@app.get("/health")
def health_check():
    return {
        "status": "ok",
        "service": "ai-identity-verification",
        "message": "AI service is running"
    }


@app.post("/api/ocr")
async def ocr_document(file: UploadFile = File(...)):
    """
    Upload an identity document image and extract OCR information.
    """

    allowed_types = {
        "image/jpeg",
        "image/png",
        "image/jpg",
        "image/webp",
    }

    if file.content_type not in allowed_types:
        raise HTTPException(
            status_code=400,
            detail="Only JPEG, PNG, JPG and WEBP images are supported."
        )

    try:
        contents = await file.read()

        image = Image.open(BytesIO(contents))

        result = process_document(image)

        return {
            "success": True,
            "filename": file.filename,
            "document": result,
        }

    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=f"OCR processing failed: {str(error)}"
        )
@app.post("/api/verify")
async def verify_identity(
    file: UploadFile = File(...),
    registration_name: str = "",
    min_age: int = 18,
    max_age: int = 100
):
    """
    Complete identity and eligibility verification.
    """

    allowed_types = {
        "image/jpeg",
        "image/png",
        "image/jpg",
        "image/webp",
    }

    if file.content_type not in allowed_types:
        raise HTTPException(
            status_code=400,
            detail="Only JPEG, PNG, JPG and WEBP images are supported."
        )

    try:
        contents = await file.read()

        image = Image.open(BytesIO(contents))

        ocr_result = process_document(image)

        verification_result = verify_document(
            contents=contents,
            ocr_result=ocr_result,
            registration_name=registration_name or None,
            min_age=min_age,
            max_age=max_age
        )

        return {
            "success": True,
            "filename": file.filename,
            "verification": verification_result
        }

    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=f"Verification failed: {str(error)}"
        )