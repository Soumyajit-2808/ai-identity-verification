"""
Biometric Face Verification Module
Performs 2D facial embedding comparison with multi-state face presence checks.
Explicitly identifies spoofing and presentation attack limitations.
"""

from typing import Optional, Dict, Any, Tuple
import cv2
import numpy as np
from pydantic import BaseModel


class FaceVerificationResult(BaseModel):
    status: str       # "PASSED", "REVIEW", "FAILED", "NOT_PROVIDED", "UNAVAILABLE"
    match: Optional[bool] = None
    state: str        # "MATCH_CONFIRMED", "MISMATCH", "NO_FACE_IN_DOCUMENT", "NO_FACE_IN_SELFIE", etc.
    distance: Optional[float] = None
    threshold: float = 0.30
    similarity_score: Optional[float] = None
    liveness_verified: bool = False
    liveness_performed: bool = False
    liveness_status: str = "UNSUPPORTED_NOT_PERFORMED"
    liveness_note: str = "Active 3D liveness detection is unsupported and was not performed. Only 2D biometric facial vector comparison is executed."
    reason: str
    disclaimer: str = (
        "2D facial verification compares facial geometric features between the document photo and selfie. "
        "It does not perform active 3D liveness or presentation attack detection."
    )


def count_faces_opencv(image_bgr: np.ndarray) -> int:
    """Use OpenCV Haar Cascade as a lightweight pre-check for face count."""
    try:
        cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        face_cascade = cv2.CascadeClassifier(cascade_path)
        gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
        faces = face_cascade.detectMultiScale(
            gray,
            scaleFactor=1.1,
            minNeighbors=5,
            minSize=(40, 40)
        )
        if len(faces) <= 1:
            return len(faces)
        # Filter out minor false-positive boxes (e.g. shirt buttons/shadows) that are much smaller than the primary face
        max_area = max(w * h for (x, y, w, h) in faces)
        significant_faces = [f for f in faces if (f[2] * f[3]) >= 0.25 * max_area]
        return len(significant_faces)
    except Exception:
        return 1  # Fallback to letting DeepFace handle detection


def verify_faces(
    document_bytes: bytes,
    selfie_bytes: Optional[bytes] = None,
    enforce_biometrics: bool = False
) -> FaceVerificationResult:
    """
    Compare document identity photo against selfie.
    Handles no-face, multiple-face, and distance thresholds.
    """
    if not selfie_bytes:
        return FaceVerificationResult(
            status="NOT_PROVIDED",
            match=None,
            state="NOT_PROVIDED",
            reason="Selfie was not provided; biometric face verification was skipped."
        )

    try:
        doc_arr = np.frombuffer(document_bytes, dtype=np.uint8)
        selfie_arr = np.frombuffer(selfie_bytes, dtype=np.uint8)

        doc_img = cv2.imdecode(doc_arr, cv2.IMREAD_COLOR)
        selfie_img = cv2.imdecode(selfie_arr, cv2.IMREAD_COLOR)

        if doc_img is None:
            return FaceVerificationResult(
                status="FAILED",
                match=None,
                state="CORRUPT_DOCUMENT_IMAGE",
                reason="The document image could not be decoded for face verification."
            )

        if selfie_img is None:
            return FaceVerificationResult(
                status="FAILED",
                match=None,
                state="CORRUPT_SELFIE_IMAGE",
                reason="The selfie image could not be decoded for face verification."
            )

        # Pre-check face counts
        doc_face_count = count_faces_opencv(doc_img)
        selfie_face_count = count_faces_opencv(selfie_img)

        if doc_face_count > 1:
            return FaceVerificationResult(
                status="REVIEW",
                match=False,
                state="MULTIPLE_FACES_IN_DOCUMENT",
                reason=f"Multiple faces ({doc_face_count}) were detected in the identity document image. A clear single photo is required."
            )

        if selfie_face_count > 1:
            return FaceVerificationResult(
                status="REVIEW",
                match=False,
                state="MULTIPLE_FACES_IN_SELFIE",
                reason=f"Multiple faces ({selfie_face_count}) were detected in the selfie. Only one person must be present."
            )

        # Run DeepFace verification
        try:
            from deepface import DeepFace
            result = DeepFace.verify(
                img1_path=doc_img,
                img2_path=selfie_img,
                model_name="Facenet512",
                detector_backend="opencv",
                enforce_detection=True
            )

            distance = float(result.get("distance", 1.0))
            threshold = float(result.get("threshold", 0.30))
            verified = bool(result.get("verified", False))

            # Calibrate similarity representation (bounded 0.0 to 1.0)
            similarity = max(0.0, min(1.0, 1.0 - (distance / max(threshold * 2.0, 0.01))))
            similarity = round(similarity, 2)

            if verified:
                return FaceVerificationResult(
                    status="PASSED",
                    match=True,
                    state="MATCH_CONFIRMED",
                    distance=round(distance, 4),
                    threshold=threshold,
                    similarity_score=similarity,
                    liveness_verified=False,
                    reason=f"Selfie face matches the document photo (distance {distance:.4f} <= threshold {threshold:.2f})."
                )
            else:
                return FaceVerificationResult(
                    status="REVIEW",
                    match=False,
                    state="MISMATCH",
                    distance=round(distance, 4),
                    threshold=threshold,
                    similarity_score=similarity,
                    liveness_verified=False,
                    reason=f"Selfie face does not sufficiently match the document photo (distance {distance:.4f} > threshold {threshold:.2f})."
                )

        except (ValueError, Exception) as val_err:
            cause_msg = str(getattr(val_err, "__cause__", "") or "").lower()
            err_msg = (str(val_err) + " " + cause_msg).lower()
            if "img1_path" in err_msg:
                return FaceVerificationResult(
                    status="REVIEW",
                    match=None,
                    state="FACE_NOT_DETECTED_IN_DOCUMENT",
                    reason="A clear human face could not be detected in the ID document."
                )
            if "img2_path" in err_msg:
                return FaceVerificationResult(
                    status="REVIEW",
                    match=None,
                    state="FACE_NOT_DETECTED_IN_SELFIE",
                    reason="A clear human face could not be detected in the selfie photo."
                )
            if "face could not be detected" in err_msg or "facenotdetected" in err_msg:
                return FaceVerificationResult(
                    status="REVIEW",
                    match=None,
                    state="FACE_NOT_DETECTED",
                    reason="A clear human face could not be detected in either the ID document or the selfie photo."
                )
            return FaceVerificationResult(
                status="REVIEW",
                match=None,
                state="DETECTION_ERROR",
                reason=f"Face detection could not complete: {str(val_err)}"
            )

    except Exception as err:
        return FaceVerificationResult(
            status="UNAVAILABLE",
            match=None,
            state="SERVICE_ERROR",
            reason="Biometric verification could not be completed; manual review is required."
        )