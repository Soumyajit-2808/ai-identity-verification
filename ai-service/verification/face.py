import cv2
import numpy as np
from deepface import DeepFace


def compare_faces(document_bytes, selfie_bytes):
    """
    Compare the face in an identity document with a selfie.
    """

    try:
        document_array = np.frombuffer(document_bytes, dtype=np.uint8)
        selfie_array = np.frombuffer(selfie_bytes, dtype=np.uint8)

        document_image = cv2.imdecode(document_array, cv2.IMREAD_COLOR)
        selfie_image = cv2.imdecode(selfie_array, cv2.IMREAD_COLOR)

        if document_image is None:
            return {
                "status": "review",
                "match": None,
                "similarity": None,
                "reason": "Identity document image could not be decoded."
            }

        if selfie_image is None:
            return {
                "status": "review",
                "match": None,
                "similarity": None,
                "reason": "Selfie image could not be decoded."
            }

        result = DeepFace.verify(
    document_image,
    selfie_image,
    model_name="Facenet512",
    detector_backend="opencv",
    enforce_detection=True
)

        distance = float(result.get("distance", 1.0))
        threshold = float(result.get("threshold", 0.30))

        similarity = max(
            0.0,
            min(
                1.0,
                1.0 - (distance / max(threshold * 2, 0.001))
            )
        )

        verified = bool(result.get("verified", False))

        if verified:
            return {
                "status": "passed",
                "match": True,
                "similarity": round(similarity, 2),
                "distance": round(distance, 4),
                "reason": "The selfie face matches the face detected in the identity document."
            }

        return {
            "status": "review",
            "match": False,
            "similarity": round(similarity, 2),
            "distance": round(distance, 4),
            "reason": "The selfie face does not sufficiently match the identity document face."
        }

    except Exception as error:
        return {
            "status": "review",
            "match": None,
            "similarity": None,
            "reason": f"Face verification could not be completed: {str(error)}"
        }