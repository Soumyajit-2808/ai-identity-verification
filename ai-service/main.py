from fastapi import FastAPI, File, UploadFile, HTTPException
from PIL import Image
from io import BytesIO

from ocr.extractor import process_document
from verification.engine import verify_document
from verification.face import compare_faces


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

        result = process_document(
            image,
            contents=contents
        )

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
    selfie: UploadFile = File(None),
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
        # Read identity document
        contents = await file.read()

        image = Image.open(BytesIO(contents))

        # OCR
        ocr_result = process_document(
            image,
            contents=contents
        )

        # Face verification MUST happen before the verification engine
        # calculates the final decision and confidence.
        if selfie:
            selfie_contents = await selfie.read()

            face_result = compare_faces(
                contents,
                selfie_contents
            )
        else:
            face_result = {
                "status": "not_provided",
                "match": None,
                "similarity": None,
                "reason": "Selfie was not provided; face verification was skipped."
            }

        # Complete verification
        verification_result = verify_document(
            contents,
            ocr_result,
            registration_name,
            min_age,
            max_age,
            face_match_result=face_result
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